import { betterAuth } from 'better-auth';

interface MediaMetadata {
  contentType: string;
  fileName: string;
  size: number;
}
interface R2MediaObject {
  size: number;
  body?: ReadableStream<Uint8Array> | null;
  httpMetadata?: { contentType?: string } | null;
}
interface R2MediaBucket {
  put(key: string, value: ReadableStream<Uint8Array> | ArrayBuffer, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string, options?: { range?: { offset?: number; length?: number; suffix?: number } }): Promise<R2MediaObject | null>;
  head(key: string): Promise<R2MediaObject | null>;
  delete(key: string): Promise<void>;
}
interface Env {
  DB: D1Database;
  MEDIA: KVNamespace;
  MEDIA_R2?: R2MediaBucket;
  BETTER_AUTH_SECRET: string;
  APP_ORIGIN: string;
  ADMIN_ACCESS_DISABLED?: string;
  ADMIN_BOOTSTRAP_EMAIL?: string;
  ADMIN_BOOTSTRAP_SHA256?: string;
  ADMIN_BOOTSTRAP_EXPIRES_AT?: string;
}
interface Context {
  request: Request;
  env: Env;
}
type UserRecord = { id: string; name: string; email: string };
const AUDIO_TYPES = new Set(['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/webm']);
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm']);
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
const R2_STORAGE_LIMIT_BYTES = 100_000_000_000;
const R2_STORAGE_WARNING_BYTES = 80_000_000_000;
const KV_STORAGE_LIMIT_BYTES = 1024 * 1024 * 1024;

function getAuth(env: Env) {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) {
    throw new Error('BETTER_AUTH_SECRET is not configured. Add an encrypted secret with at least 32 characters.');
  }
  if (!env.APP_ORIGIN) throw new Error('APP_ORIGIN is not configured.');
  return betterAuth({
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.APP_ORIGIN,
    trustedOrigins: [env.APP_ORIGIN],
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      minPasswordLength: 8,
      maxPasswordLength: 128
    },
    rateLimit: { enabled: true }
  });
}

function reply(data: unknown, status = 200, cache = 'no-store'): Response {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    }
  });
}

async function getUser(request: Request, env: Env): Promise<UserRecord | null> {
  const session = await getAuth(env).api.getSession({ headers: request.headers });
  if (!session?.user) return null;
  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email
  };
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}


async function ensureAdminSchema(env: Env): Promise<void> {
  // The first valid owner activation can safely recover the Admin Centre schema
  // if the production D1 database missed migration 0002.
  const adminTableSql = `CREATE TABLE IF NOT EXISTS admins (
    user_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'admin' CHECK (role = 'admin'),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`;
  await env.DB.prepare(adminTableSql).run();

  const tableInfo = await env.DB.prepare('PRAGMA table_info(albums)').all<{ name: string }>();
  const columns = new Set((tableInfo.results ?? []).map((column) => column.name));
  const additions = [
    ['description', 'ALTER TABLE albums ADD COLUMN description TEXT'],
    ['is_published', 'ALTER TABLE albums ADD COLUMN is_published INTEGER NOT NULL DEFAULT 0 CHECK (is_published IN (0, 1))'],
    ['published_at', 'ALTER TABLE albums ADD COLUMN published_at TEXT'],
    ['created_by', 'ALTER TABLE albums ADD COLUMN created_by TEXT']
  ] as const;

  for (const [columnName, statement] of additions) {
    if (columns.has(columnName)) continue;
    try {
      await env.DB.prepare(statement).run();
    } catch (error) {
      // If another simultaneous first-activation request added this column,
      // accept the recovered schema; otherwise preserve the original error.
      const refreshed = await env.DB.prepare('PRAGMA table_info(albums)').all<{ name: string }>();
      if (!(refreshed.results ?? []).some((column) => column.name === columnName)) throw error;
    }
  }

  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_albums_public ON albums(is_published, published_at DESC)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_playlists_public ON playlists(is_public, created_at DESC)').run();
  await env.DB.prepare(
    'UPDATE albums SET is_published = 1, published_at = COALESCE(published_at, created_at) WHERE id IN (SELECT DISTINCT album_id FROM tracks WHERE is_published = 1 AND album_id IS NOT NULL)'
  ).run();
}

async function isAdmin(user: UserRecord, env: Env): Promise<boolean> {
  if (env.ADMIN_ACCESS_DISABLED === 'true') return false;
  const record = await env.DB.prepare('SELECT user_id FROM admins WHERE user_id = ?')
    .bind(user.id).first();
  return Boolean(record);
}

async function getAdmin(request: Request, env: Env): Promise<UserRecord | null> {
  const user = await getUser(request, env);
  if (!user || !(await isAdmin(user, env))) return null;
  return user;
}

async function bodyJson<T>(request: Request): Promise<T | null> {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 16384) return null;
  try { return await request.json() as T; }
  catch { return null; }
}

function safeText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function albumIdFromPath(path: string): string | null {
  const match = path.match(/^\/api\/admin\/albums\/([a-zA-Z0-9_-]+)$/);
  return match?.[1] ?? null;
}



async function ensureMediaSchema(env: Env): Promise<void> {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS media_assets (
    id TEXT PRIMARY KEY NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('r2', 'kv')),
    object_key TEXT NOT NULL UNIQUE,
    media_kind TEXT NOT NULL CHECK (media_kind IN ('audio', 'image', 'video')),
    file_name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
    created_by TEXT NOT NULL REFERENCES user(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('pending', 'ready')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();

  const trackColumns = await env.DB.prepare('PRAGMA table_info(tracks)').all<{ name: string }>();
  if (!(trackColumns.results ?? []).some((column) => column.name === 'video_path')) {
    try {
      await env.DB.prepare('ALTER TABLE tracks ADD COLUMN video_path TEXT').run();
    } catch (error) {
      const refreshed = await env.DB.prepare('PRAGMA table_info(tracks)').all<{ name: string }>();
      if (!(refreshed.results ?? []).some((column) => column.name === 'video_path')) throw error;
    }
  }
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_media_assets_provider_status ON media_assets(provider, status)').run();
}

async function mediaUsage(env: Env, provider: 'r2' | 'kv'): Promise<number> {
  await ensureMediaSchema(env);
  const usage = await env.DB.prepare(
    'SELECT COALESCE(SUM(size_bytes), 0) AS used_bytes FROM media_assets WHERE provider = ?'
  ).bind(provider).first<{ used_bytes: number }>();
  return Math.max(0, Number(usage?.used_bytes ?? 0));
}

async function hasMediaObject(env: Env, id: string): Promise<boolean> {
  const key = 'media/' + id;
  if (env.MEDIA_R2) {
    const object = await env.MEDIA_R2.head(key);
    if (object) return true;
  }
  const legacy = await env.MEDIA.get(key, 'arrayBuffer');
  return Boolean(legacy);
}

async function deleteMediaPath(env: Env, mediaPath: string | null | undefined): Promise<void> {
  if (!mediaPath || !mediaPath.startsWith('/media/')) return;
  await ensureMediaSchema(env);
  const id = mediaPath.slice('/media/'.length);
  if (!/^[a-f0-9-]{36}$/i.test(id)) return;
  const record = await env.DB.prepare(
    'SELECT provider, object_key FROM media_assets WHERE id = ?'
  ).bind(id).first<{ provider: 'r2' | 'kv'; object_key: string }>();

  if (record?.provider === 'r2') {
    if (!env.MEDIA_R2) throw new Error('R2 storage is not connected; the media file was kept safe.');
    await env.MEDIA_R2.delete(record.object_key);
  } else if (record?.provider === 'kv') {
    await env.MEDIA.delete(record.object_key);
  } else {
    const key = record?.object_key ?? ('media/' + id);
    if (env.MEDIA_R2) {
      const exists = await env.MEDIA_R2.head(key);
      if (exists) await env.MEDIA_R2.delete(key);
    }
    await env.MEDIA.delete(key);
  }
  await env.DB.prepare('DELETE FROM media_assets WHERE id = ?').bind(id).run();
}

async function reserveMediaAsset(
  env: Env,
  details: { id: string; provider: 'r2' | 'kv'; objectKey: string; kind: 'audio' | 'image' | 'video'; fileName: string; contentType: string; size: number; adminId: string },
  limit: number
): Promise<boolean> {
  await ensureMediaSchema(env);
  const result = await env.DB.prepare(
    `INSERT INTO media_assets (id, provider, object_key, media_kind, file_name, content_type, size_bytes, created_by, status)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending'
     WHERE (SELECT COALESCE(SUM(size_bytes), 0) FROM media_assets WHERE provider = ?) + ? <= ?`
  ).bind(
    details.id, details.provider, details.objectKey, details.kind, details.fileName,
    details.contentType, details.size, details.adminId, details.provider, details.size, limit
  ).run();
  return Number(result.meta.changes ?? 0) === 1;
}

async function uploadMedia(request: Request, env: Env, admin: UserRecord): Promise<Response> {
  let form: FormData;
  try { form = await request.formData(); }
  catch { return reply({ error: 'Invalid upload form.' }, 400); }

  const file = form.get('file');
  const kindValue = form.get('kind');
  if (kindValue !== 'audio' && kindValue !== 'image' && kindValue !== 'video') {
    return reply({ error: 'Choose audio, image, or video media.' }, 400);
  }
  const kind = kindValue;
  if (!file || typeof file !== 'object' || !('stream' in file) || !('size' in file) || !('type' in file) || !('name' in file)) {
    return reply({ error: 'Choose a valid file to upload.' }, 400);
  }

  const upload = file as File;
  const allowed = kind === 'image' ? IMAGE_TYPES : kind === 'video' ? VIDEO_TYPES : AUDIO_TYPES;
  const maxBytes = kind === 'image' ? MAX_IMAGE_BYTES : kind === 'video' ? MAX_VIDEO_BYTES : MAX_AUDIO_BYTES;
  if (!allowed.has(upload.type)) {
    return reply({
      error: kind === 'image'
        ? 'Use a JPG, PNG, or WebP cover image.'
        : kind === 'video'
          ? 'Use an MP4 or WebM video.'
          : 'Use an MP3, M4A, AAC, OGG, WAV, or WebM audio file.'
    }, 415);
  }
  if (upload.size <= 0 || upload.size > maxBytes) {
    return reply({
      error: kind === 'image'
        ? 'Cover images must be 2 MB or smaller.'
        : kind === 'video'
          ? 'Music videos must be 25 MB or smaller.'
          : 'Audio files must be 20 MB or smaller.'
    }, 413);
  }
  if (kind === 'video') {
    const seconds = Number(form.get('durationSeconds'));
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 15.05) {
      return reply({ error: 'Canvas videos must be 15 seconds or shorter. Check the selected video duration.' }, 400);
    }
  }

  const provider: 'r2' | 'kv' = env.MEDIA_R2 ? 'r2' : 'kv';
  const limit = provider === 'r2' ? R2_STORAGE_LIMIT_BYTES : KV_STORAGE_LIMIT_BYTES;
  const id = crypto.randomUUID();
  const key = 'media/' + id;
  const fileName = safeText(upload.name, 120) || (kind === 'image' ? 'cover' : kind === 'video' ? 'canvas' : 'audio');
  const reserved = await reserveMediaAsset(env, {
    id, provider, objectKey: key, kind, fileName, contentType: upload.type, size: upload.size, adminId: admin.id
  }, limit);

  if (!reserved) {
    const usedBytes = await mediaUsage(env, provider);
    return reply({
      error: provider === 'r2'
        ? 'The DeanMusic 100 GB storage ceiling has been reached. Delete media or approve a higher limit before uploading more.'
        : 'The DeanMusic free storage ceiling has been reached. Connect the approved R2 bucket before adding more media.',
      storageProvider: provider === 'r2' ? 'Cloudflare R2' : 'Cloudflare KV',
      usedBytes,
      limitBytes: limit
    }, 507);
  }

  try {
    if (provider === 'r2' && env.MEDIA_R2) {
      await env.MEDIA_R2.put(key, upload.stream(), {
        httpMetadata: { contentType: upload.type },
        customMetadata: { mediaId: id, kind, fileName, uploadedBy: admin.id }
      });
    } else {
      await env.MEDIA.put(key, await upload.arrayBuffer(), {
        metadata: { contentType: upload.type, fileName, size: upload.size } satisfies MediaMetadata
      });
    }
    await env.DB.prepare("UPDATE media_assets SET status = 'ready' WHERE id = ?").bind(id).run();
  } catch (error) {
    await env.DB.prepare('DELETE FROM media_assets WHERE id = ?').bind(id).run();
    throw error;
  }

  const usedBytes = await mediaUsage(env, provider);
  return reply({
    mediaId: id,
    url: '/media/' + id,
    kind,
    size: upload.size,
    storageProvider: provider === 'r2' ? 'Cloudflare R2' : 'Cloudflare KV',
    usedBytes,
    limitBytes: limit,
    warningBytes: provider === 'r2' ? R2_STORAGE_WARNING_BYTES : Math.floor(limit * 0.8),
    uploadedBy: admin.name
  }, 201);
}
async function serveMedia(request: Request, env: Env, id: string): Promise<Response> {
  const { value, metadata } = await env.MEDIA.getWithMetadata<MediaMetadata>('media/' + id, 'arrayBuffer');
  if (!value) return reply({ error: 'Media not found.' }, 404);
  const data = value as ArrayBuffer;
  const size = data.byteLength;
  const rangeHeader = request.headers.get('range');
  const headers = new Headers({
    'Content-Type': metadata?.contentType || 'application/octet-stream',
    'Content-Disposition': 'inline',
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
    'Access-Control-Allow-Origin': '*'
  });
  if (!rangeHeader) {
    headers.set('Content-Length', String(size));
    return new Response(data, { status: 200, headers });
  }
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!match[1] && match[2]) {
    const suffixLength = Number(match[2]);
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
  }
  end = Math.min(end, size - 1);
  const chunk = data.slice(start, end + 1);
  headers.set('Content-Length', String(chunk.byteLength));
  headers.set('Content-Range', 'bytes ' + start + '-' + end + '/' + size);
  return new Response(chunk, { status: 206, headers });
}

export const onRequest = async ({ request, env }: Context): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname;

  if (
    !path.startsWith('/api/auth/') &&
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)
  ) {
    const origin = request.headers.get('origin');
    if (!env.APP_ORIGIN || origin !== env.APP_ORIGIN) {
      return reply({ error: 'Cross-origin request blocked.' }, 403);
    }
  }

  try {
    if (path.startsWith('/api/auth/')) return getAuth(env).handler(request);

    const mediaMatch = path.match(/^\/media\/([a-f0-9-]{36})$/i);
    if (mediaMatch && request.method === 'GET') {
      return await serveMedia(request, env, mediaMatch[1]);
    }

    if (path === '/api/health' && request.method === 'GET') {
      await env.DB.prepare('SELECT 1 AS ok').first();
      return reply({ ok: true, service: 'DeanMusic API', database: 'Cloudflare D1', media: 'Cloudflare Workers KV' });
    }

    if (path === '/api/catalog' && request.method === 'GET') {
      const result = await env.DB.prepare(
        'SELECT t.id, t.title, t.duration_seconds, t.genre, t.audio_path, t.external_audio_url, t.plays_count, ar.name AS artist_name, al.title AS album_title, al.cover_url FROM tracks t INNER JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id WHERE t.is_published = 1 ORDER BY t.plays_count DESC, t.created_at DESC LIMIT 100'
      ).all();
      return reply({ tracks: result.results }, 200, 'public, max-age=60, stale-while-revalidate=300');
    }

    if (path === '/api/albums' && request.method === 'GET') {
      const result = await env.DB.prepare(
        'SELECT al.id, al.title, al.description, al.cover_url, al.release_date, al.genre, al.published_at, ar.name AS artist_name, COUNT(t.id) AS track_count FROM albums al INNER JOIN artists ar ON ar.id = al.artist_id LEFT JOIN tracks t ON t.album_id = al.id AND t.is_published = 1 WHERE al.is_published = 1 GROUP BY al.id ORDER BY COALESCE(al.published_at, al.created_at) DESC LIMIT 100'
      ).all();
      return reply({ albums: result.results }, 200, 'public, max-age=60, stale-while-revalidate=300');
    }

    const publicAlbumMatch = path.match(/^\/api\/albums\/([a-zA-Z0-9_-]+)$/);
    if (publicAlbumMatch && request.method === 'GET') {
      const album = await env.DB.prepare(
        'SELECT al.id, al.title, al.description, al.cover_url, al.release_date, al.genre, ar.name AS artist_name FROM albums al INNER JOIN artists ar ON ar.id = al.artist_id WHERE al.id = ? AND al.is_published = 1'
      ).bind(publicAlbumMatch[1]).first();
      if (!album) return reply({ error: 'Album not found.' }, 404);
      const tracks = await env.DB.prepare(
        'SELECT id, title, duration_seconds, track_number, genre, audio_path, external_audio_url, plays_count FROM tracks WHERE album_id = ? AND is_published = 1 ORDER BY track_number ASC, created_at ASC'
      ).bind(publicAlbumMatch[1]).all();
      return reply({ album, tracks: tracks.results }, 200, 'public, max-age=60, stale-while-revalidate=300');
    }

    if (path === '/api/public-playlists' && request.method === 'GET') {
      const result = await env.DB.prepare(
        'SELECT p.id, p.name, p.description, p.cover_url, p.created_at, u.name AS owner_name, COUNT(pt.track_id) AS track_count FROM playlists p INNER JOIN user u ON u.id = p.owner_id LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id WHERE p.is_public = 1 GROUP BY p.id ORDER BY p.created_at DESC LIMIT 100'
      ).all();
      return reply({ playlists: result.results }, 200, 'public, max-age=60, stale-while-revalidate=300');
    }

    if (path === '/api/me' && request.method === 'GET') {
      return reply({ user: await getUser(request, env) });
    }

    if (path === '/api/playlists' && request.method === 'GET') {
      const user = await getUser(request, env);
      if (!user) return reply({ error: 'Sign in required.' }, 401);
      const result = await env.DB.prepare(
        'SELECT id, name, description, cover_url, is_public, created_at FROM playlists WHERE owner_id = ? ORDER BY created_at DESC LIMIT 100'
      ).bind(user.id).all();
      return reply({ playlists: result.results });
    }

    if (path === '/api/playlists' && request.method === 'POST') {
      const user = await getUser(request, env);
      if (!user) return reply({ error: 'Sign in required.' }, 401);
      const body = await bodyJson<{ name?: unknown; description?: unknown; isPublic?: unknown }>(request);
      const name = safeText(body?.name, 80);
      const description = safeText(body?.description, 500);
      const isPublic = body?.isPublic === true ? 1 : 0;
      if (!name) return reply({ error: 'Playlist name must be 1–80 characters.' }, 400);
      const id = crypto.randomUUID();
      await env.DB.prepare(
        'INSERT INTO playlists (id, owner_id, name, description, is_public) VALUES (?, ?, ?, ?, ?)'
      ).bind(id, user.id, name, description || null, isPublic).run();
      return reply({ playlist: { id, name, description: description || null, is_public: isPublic } }, 201);
    }

    const publicOrOwnedPlaylist = path.match(/^\/api\/playlists\/([a-zA-Z0-9_-]+)$/);
    if (publicOrOwnedPlaylist && request.method === 'GET') {
      const user = await getUser(request, env);
      const playlist = await env.DB.prepare(
        'SELECT p.id, p.owner_id, p.name, p.description, p.cover_url, p.is_public, p.created_at, u.name AS owner_name FROM playlists p INNER JOIN user u ON u.id = p.owner_id WHERE p.id = ? AND (p.is_public = 1 OR p.owner_id = ?)'
      ).bind(publicOrOwnedPlaylist[1], user?.id ?? '').first();
      if (!playlist) return reply({ error: 'Playlist not found.' }, 404);
      const tracks = await env.DB.prepare(
        'SELECT t.id, t.title, t.duration_seconds, t.genre, t.audio_path, t.external_audio_url, t.plays_count, ar.name AS artist_name, al.title AS album_title FROM playlist_tracks pt INNER JOIN tracks t ON t.id = pt.track_id INNER JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id WHERE pt.playlist_id = ? AND t.is_published = 1 ORDER BY pt.position ASC'
      ).bind(publicOrOwnedPlaylist[1]).all();
      return reply({ playlist, tracks: tracks.results }, 200, playlist.is_public ? 'public, max-age=30' : 'no-store');
    }

    const playlistDelete = path.match(/^\/api\/playlists\/([a-zA-Z0-9_-]+)$/);
    if (playlistDelete && request.method === 'DELETE') {
      const user = await getUser(request, env);
      if (!user) return reply({ error: 'Sign in required.' }, 401);
      const result = await env.DB.prepare('DELETE FROM playlists WHERE id = ? AND owner_id = ?')
        .bind(playlistDelete[1], user.id).run();
      if (!result.meta.changes) return reply({ error: 'Playlist not found.' }, 404);
      return reply({ deleted: true });
    }

    const playlistUpdate = path.match(/^\/api\/playlists\/([a-zA-Z0-9_-]+)$/);
    if (playlistUpdate && request.method === 'PATCH') {
      const user = await getUser(request, env);
      if (!user) return reply({ error: 'Sign in required.' }, 401);
      const body = await bodyJson<{ name?: unknown; description?: unknown; isPublic?: unknown }>(request);
      const name = safeText(body?.name, 80);
      const description = safeText(body?.description, 500);
      if (!name) return reply({ error: 'Playlist name is required.' }, 400);
      const result = await env.DB.prepare(
        'UPDATE playlists SET name = ?, description = ?, is_public = ?, updated_at = datetime(\'now\') WHERE id = ? AND owner_id = ?'
      ).bind(name, description || null, body?.isPublic === true ? 1 : 0, playlistUpdate[1], user.id).run();
      if (!result.meta.changes) return reply({ error: 'Playlist not found.' }, 404);
      return reply({ updated: true });
    }

    const addPlaylistTrack = path.match(/^\/api\/playlists\/([a-zA-Z0-9_-]+)\/tracks$/);
    if (addPlaylistTrack && request.method === 'POST') {
      const user = await getUser(request, env);
      if (!user) return reply({ error: 'Sign in required.' }, 401);
      const body = await bodyJson<{ trackId?: unknown }>(request);
      const trackId = safeText(body?.trackId, 100);
      if (!trackId) return reply({ error: 'Invalid track ID.' }, 400);
      const owned = await env.DB.prepare('SELECT id FROM playlists WHERE id = ? AND owner_id = ?')
        .bind(addPlaylistTrack[1], user.id).first();
      if (!owned) return reply({ error: 'Playlist not found.' }, 404);
      const published = await env.DB.prepare('SELECT id FROM tracks WHERE id = ? AND is_published = 1')
        .bind(trackId).first();
      if (!published) return reply({ error: 'Track not found.' }, 404);
      const order = await env.DB.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM playlist_tracks WHERE playlist_id = ?')
        .bind(addPlaylistTrack[1]).first<{ next_position: number }>();
      await env.DB.prepare('INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)')
        .bind(addPlaylistTrack[1], trackId, order?.next_position ?? 0).run();
      return reply({ added: true });
    }

    if (path === '/api/liked-tracks' && request.method === 'GET') {
      const user = await getUser(request, env);
      if (!user) return reply({ error: 'Sign in required.' }, 401);
      const result = await env.DB.prepare(
        'SELECT t.id, t.title, t.genre, t.duration_seconds, t.audio_path, ar.name AS artist_name, al.title AS album_title FROM liked_tracks l INNER JOIN tracks t ON t.id = l.track_id INNER JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id WHERE l.user_id = ? AND t.is_published = 1 ORDER BY l.liked_at DESC LIMIT 500'
      ).bind(user.id).all();
      return reply({ tracks: result.results });
    }

    const likeRoute = path.match(/^\/api\/likes\/([a-zA-Z0-9_-]+)$/);
    if (likeRoute && (request.method === 'POST' || request.method === 'DELETE')) {
      const user = await getUser(request, env);
      if (!user) return reply({ error: 'Sign in required.' }, 401);
      const trackId = likeRoute[1];
      if (request.method === 'POST') {
        const exists = await env.DB.prepare('SELECT id FROM tracks WHERE id = ? AND is_published = 1')
          .bind(trackId).first();
        if (!exists) return reply({ error: 'Track not found.' }, 404);
        await env.DB.prepare('INSERT OR IGNORE INTO liked_tracks (user_id, track_id) VALUES (?, ?)')
          .bind(user.id, trackId).run();
        return reply({ liked: true });
      }
      await env.DB.prepare('DELETE FROM liked_tracks WHERE user_id = ? AND track_id = ?')
        .bind(user.id, trackId).run();
      return reply({ liked: false });
    }

    const playRoute = path.match(/^\/api\/plays\/([a-zA-Z0-9_-]+)$/);
    if (playRoute && request.method === 'POST') {
      const trackId = playRoute[1];
      const result = await env.DB.prepare('UPDATE tracks SET plays_count = plays_count + 1 WHERE id = ? AND is_published = 1')
        .bind(trackId).run();
      if (!result.meta.changes) return reply({ recorded: false });
      const user = await getUser(request, env);
      if (user) {
        await env.DB.prepare('INSERT INTO recently_played (id, user_id, track_id) VALUES (?, ?, ?)')
          .bind(crypto.randomUUID(), user.id, trackId).run();
      }
      return reply({ recorded: true });
    }

    if (path === '/api/admin/bootstrap' && request.method === 'POST') {
      const user = await getUser(request, env);
      if (!user) return reply({ error: 'Sign in to DeanMusic first.' }, 401);
      if (env.ADMIN_ACCESS_DISABLED === 'true') return reply({ error: 'Admin activation is disabled in Preview.' }, 403);

      const approvedEmail = (env.ADMIN_BOOTSTRAP_EMAIL ?? '').trim().toLowerCase();
      const expectedHash = (env.ADMIN_BOOTSTRAP_SHA256 ?? '').trim().toLowerCase();
      const expiresAt = Date.parse(env.ADMIN_BOOTSTRAP_EXPIRES_AT ?? '');
      if (
        !approvedEmail ||
        !/^[a-f0-9]{64}$/.test(expectedHash) ||
        !Number.isFinite(expiresAt) ||
        Date.now() > expiresAt ||
        user.email.trim().toLowerCase() !== approvedEmail
      ) {
        return reply({ error: 'Admin activation is unavailable for this account.' }, 403);
      }

      const body = await bodyJson<{ token?: unknown }>(request);
      const token = typeof body?.token === 'string' ? body.token.trim() : '';
      if (token.length < 32 || token.length > 128) {
        return reply({ error: 'The one-time activation code is invalid or expired.' }, 403);
      }
      const actualHash = await sha256Hex(token);
      if (!constantTimeEqual(actualHash, expectedHash)) {
        return reply({ error: 'The one-time activation code is invalid or expired.' }, 403);
      }

      try {
        await ensureAdminSchema(env);
      } catch (error) {
        console.error('DeanMusic Admin Centre schema recovery failed:', error);
        return reply({ error: 'Admin database setup is incomplete. The activation code was not used; please retry after the database setup is repaired.' }, 503);
      }

      const existing = await env.DB.prepare('SELECT user_id FROM admins LIMIT 1').first();
      if (existing) return reply({ error: 'The first administrator has already been activated.' }, 409);

      const inserted = await env.DB.prepare(
        'INSERT INTO admins (user_id) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM admins)'
      ).bind(user.id).run();
      if (!inserted.meta.changes) {
        return reply({ error: 'The first administrator has already been activated.' }, 409);
      }
      return reply({ isAdmin: true, activated: true }, 201);
    }

    if (path === '/api/admin/status' && request.method === 'GET') {
      const user = await getUser(request, env);
      return reply({ isAdmin: user ? await isAdmin(user, env) : false });
    }

    if (path === '/api/admin/media' && request.method === 'POST') {
      const admin = await getAdmin(request, env);
      if (!admin) return reply({ error: 'Admin access required.' }, 403);
      return await uploadMedia(request, env, admin);
    }

    if (path === '/api/admin/albums' && request.method === 'GET') {
      const admin = await getAdmin(request, env);
      if (!admin) return reply({ error: 'Admin access required.' }, 403);
      const result = await env.DB.prepare(
        'SELECT al.id, al.title, al.description, al.cover_url, al.release_date, al.genre, al.is_published, al.created_at, ar.name AS artist_name, COUNT(t.id) AS track_count FROM albums al INNER JOIN artists ar ON ar.id = al.artist_id LEFT JOIN tracks t ON t.album_id = al.id GROUP BY al.id ORDER BY al.created_at DESC LIMIT 300'
      ).all();
      return reply({ albums: result.results });
    }

    if (path === '/api/admin/albums' && request.method === 'POST') {
      const admin = await getAdmin(request, env);
      if (!admin) return reply({ error: 'Admin access required.' }, 403);
      const body = await bodyJson<{ title?: unknown; artistName?: unknown; genre?: unknown; description?: unknown; releaseDate?: unknown; coverUrl?: unknown }>(request);
      const title = safeText(body?.title, 120);
      const artistName = safeText(body?.artistName, 120) || admin.name;
      const genre = safeText(body?.genre, 60);
      const description = safeText(body?.description, 1000);
      const coverUrl = safeText(body?.coverUrl, 300);
      const releaseDate = safeText(body?.releaseDate, 20);
      if (!title) return reply({ error: 'Album title is required.' }, 400);
      if (coverUrl && !/^\/media\/[a-f0-9-]{36}$/i.test(coverUrl)) return reply({ error: 'Invalid album cover URL.' }, 400);
      let artist = await env.DB.prepare('SELECT id FROM artists WHERE name = ? COLLATE NOCASE LIMIT 1')
        .bind(artistName).first<{ id: string }>();
      if (!artist) {
        const artistId = crypto.randomUUID();
        await env.DB.prepare('INSERT INTO artists (id, name, bio) VALUES (?, ?, ?)')
          .bind(artistId, artistName, 'Published through DeanMusic.').run();
        artist = { id: artistId };
      }
      const id = crypto.randomUUID();
      await env.DB.prepare(
        'INSERT INTO albums (id, artist_id, title, cover_url, release_date, genre, description, is_published, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)'
      ).bind(id, artist.id, title, coverUrl || null, releaseDate || null, genre || null, description || null, admin.id).run();
      return reply({ album: { id, title, artist_name: artistName, genre, description, cover_url: coverUrl || null, is_published: 0 } }, 201);
    }

    const albumPublish = path.match(/^\/api\/admin\/albums\/([a-zA-Z0-9_-]+)\/(publish|unpublish)$/);
    if (albumPublish && request.method === 'POST') {
      const admin = await getAdmin(request, env);
      if (!admin) return reply({ error: 'Admin access required.' }, 403);
      const publish = albumPublish[2] === 'publish';
      const result = await env.DB.prepare(
        'UPDATE albums SET is_published = ?, published_at = CASE WHEN ? = 1 THEN datetime(\'now\') ELSE NULL END WHERE id = ?'
      ).bind(publish ? 1 : 0, publish ? 1 : 0, albumPublish[1]).run();
      if (!result.meta.changes) return reply({ error: 'Album not found.' }, 404);
      await env.DB.prepare('UPDATE tracks SET is_published = ? WHERE album_id = ?')
        .bind(publish ? 1 : 0, albumPublish[1]).run();
      return reply({ published: publish });
    }

    const adminAlbumId = albumIdFromPath(path);
    if (adminAlbumId && request.method === 'PATCH') {
      const admin = await getAdmin(request, env);
      if (!admin) return reply({ error: 'Admin access required.' }, 403);
      const body = await bodyJson<{ title?: unknown; artistName?: unknown; genre?: unknown; description?: unknown; coverUrl?: unknown; releaseDate?: unknown }>(request);
      const title = safeText(body?.title, 120);
      const artistName = safeText(body?.artistName, 120);
      const genre = safeText(body?.genre, 60);
      const description = safeText(body?.description, 1000);
      const coverUrl = safeText(body?.coverUrl, 300);
      const releaseDate = safeText(body?.releaseDate, 20);
      if (!title) return reply({ error: 'Album title is required.' }, 400);
      if (coverUrl && !/^\/media\/[a-f0-9-]{36}$/i.test(coverUrl)) return reply({ error: 'Invalid album cover URL.' }, 400);
      const album = await env.DB.prepare('SELECT artist_id FROM albums WHERE id = ?').bind(adminAlbumId).first<{ artist_id: string }>();
      if (!album) return reply({ error: 'Album not found.' }, 404);
      if (artistName) await env.DB.prepare('UPDATE artists SET name = ? WHERE id = ?').bind(artistName, album.artist_id).run();
      await env.DB.prepare(
        'UPDATE albums SET title = ?, genre = ?, description = ?, cover_url = ?, release_date = ? WHERE id = ?'
      ).bind(title, genre || null, description || null, coverUrl || null, releaseDate || null, adminAlbumId).run();
      return reply({ updated: true });
    }

    if (path === '/api/admin/tracks' && request.method === 'GET') {
      const admin = await getAdmin(request, env);
      if (!admin) return reply({ error: 'Admin access required.' }, 403);
      const result = await env.DB.prepare(
        'SELECT t.id, t.album_id, t.title, t.duration_seconds, t.track_number, t.genre, t.audio_path, t.is_published, t.plays_count, ar.name AS artist_name, al.title AS album_title FROM tracks t INNER JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id ORDER BY t.created_at DESC LIMIT 500'
      ).all();
      return reply({ tracks: result.results });
    }

    if (path === '/api/admin/tracks' && request.method === 'POST') {
      const admin = await getAdmin(request, env);
      if (!admin) return reply({ error: 'Admin access required.' }, 403);
      const body = await bodyJson<{ albumId?: unknown; title?: unknown; genre?: unknown; duration?: unknown; trackNumber?: unknown; audioPath?: unknown }>(request);
      const albumId = safeText(body?.albumId, 100);
      const title = safeText(body?.title, 120);
      const genre = safeText(body?.genre, 60);
      const audioPath = safeText(body?.audioPath, 300);
      const duration = Number(body?.duration);
      const trackNumber = Number(body?.trackNumber);
      if (!albumId || !title || !Number.isFinite(duration) || duration < 0 || duration > 86400 || !Number.isInteger(trackNumber) || trackNumber < 1) {
        return reply({ error: 'Check the album, track title, duration, and track number.' }, 400);
      }
      if (!/^\/media\/[a-f0-9-]{36}$/i.test(audioPath) && audioPath !== 'browser-synth') {
        return reply({ error: 'A DeanMusic media upload is required.' }, 400);
      }
      const album = await env.DB.prepare('SELECT artist_id, genre, is_published FROM albums WHERE id = ?')
        .bind(albumId).first<{ artist_id: string; genre: string | null; is_published: number }>();
      if (!album) return reply({ error: 'Album not found.' }, 404);
      if (audioPath.startsWith('/media/')) {
        const mediaId = audioPath.slice('/media/'.length);
        const mediaExists = await env.MEDIA.get('media/' + mediaId, 'arrayBuffer');
        if (!mediaExists) return reply({ error: 'Uploaded audio file not found in media storage.' }, 400);
      }
      const id = crypto.randomUUID();
      await env.DB.prepare(
        'INSERT INTO tracks (id, album_id, artist_id, title, duration_seconds, track_number, genre, audio_path, is_published) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, albumId, album.artist_id, title, Math.floor(duration), trackNumber, genre || album.genre, audioPath, album.is_published ? 1 : 0).run();
      return reply({ track: { id, album_id: albumId, title, duration_seconds: Math.floor(duration), track_number: trackNumber, genre, audio_path: audioPath, is_published: album.is_published ? 1 : 0 } }, 201);
    }

    const adminTrack = path.match(/^\/api\/admin\/tracks\/([a-zA-Z0-9_-]+)$/);
    if (adminTrack && request.method === 'PATCH') {
      const admin = await getAdmin(request, env);
      if (!admin) return reply({ error: 'Admin access required.' }, 403);
      const body = await bodyJson<{ title?: unknown; genre?: unknown; duration?: unknown; trackNumber?: unknown }>(request);
      const title = safeText(body?.title, 120);
      const genre = safeText(body?.genre, 60);
      const duration = Number(body?.duration);
      const trackNumber = Number(body?.trackNumber);
      if (!title || !Number.isFinite(duration) || duration < 0 || duration > 86400 || !Number.isInteger(trackNumber) || trackNumber < 1) {
        return reply({ error: 'Check the track title, duration, and track number.' }, 400);
      }
      const result = await env.DB.prepare(
        'UPDATE tracks SET title = ?, genre = ?, duration_seconds = ?, track_number = ?, updated_at = datetime(\'now\') WHERE id = ?'
      ).bind(title, genre || null, Math.floor(duration), trackNumber, adminTrack[1]).run();
      if (!result.meta.changes) return reply({ error: 'Track not found.' }, 404);
      return reply({ updated: true });
    }

    if (adminTrack && request.method === 'DELETE') {
      const admin = await getAdmin(request, env);
      if (!admin) return reply({ error: 'Admin access required.' }, 403);
      const track = await env.DB.prepare('SELECT audio_path FROM tracks WHERE id = ?').bind(adminTrack[1]).first<{ audio_path: string | null }>();
      if (!track) return reply({ error: 'Track not found.' }, 404);
      await env.DB.prepare('DELETE FROM tracks WHERE id = ?').bind(adminTrack[1]).run();
      if (track.audio_path?.startsWith('/media/')) {
        await env.MEDIA.delete('media/' + track.audio_path.slice('/media/'.length));
      }
      return reply({ deleted: true });
    }

    if (path === '/api/admin/status' && request.method === 'GET') {
      const user = await getUser(request, env);
      return reply({ isAdmin: user ? await isAdmin(user, env) : false });
    }

    return reply({ error: 'Not found.' }, 404);
  } catch (error) {
    console.error('DeanMusic API error:', error);
    return reply({ error: 'The service could not complete this request. Please try again later.' }, 500);
  }
};

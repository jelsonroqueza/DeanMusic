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



async function ensureAdminActivationAttemptsSchema(env: Env): Promise<void> {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS admin_activation_attempts (
    user_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
    locked_until TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
}

async function getAdminActivationAttempts(
  env: Env,
  userId: string
): Promise<{ failed_attempts: number; locked_until: string | null } | null> {
  return await env.DB.prepare(
    'SELECT failed_attempts, locked_until FROM admin_activation_attempts WHERE user_id = ?'
  ).bind(userId).first<{ failed_attempts: number; locked_until: string | null }>();
}

async function recordAdminActivationFailure(env: Env, userId: string): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO admin_activation_attempts (user_id, failed_attempts, locked_until)
    VALUES (?, 1, NULL)
    ON CONFLICT(user_id) DO UPDATE SET
      failed_attempts = CASE
        WHEN admin_activation_attempts.locked_until IS NOT NULL
          AND admin_activation_attempts.locked_until <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        THEN 1
        ELSE admin_activation_attempts.failed_attempts + 1
      END,
      locked_until = CASE
        WHEN (
          CASE
            WHEN admin_activation_attempts.locked_until IS NOT NULL
              AND admin_activation_attempts.locked_until <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            THEN 1
            ELSE admin_activation_attempts.failed_attempts + 1
          END
        ) >= 5
        THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+15 minutes')
        ELSE NULL
      END,
      updated_at = datetime('now')
  `).bind(userId).run();
}

function readIsoBoxes(view: DataView, start: number, end: number): Array<{ type: string; start: number; end: number }> {
  const boxes: Array<{ type: string; start: number; end: number }> = [];
  let offset = start;
  while (offset + 8 <= end) {
    const size32 = view.getUint32(offset);
    const type = String.fromCharCode(
      view.getUint8(offset + 4), view.getUint8(offset + 5),
      view.getUint8(offset + 6), view.getUint8(offset + 7)
    );
    let headerSize = 8;
    let boxSize = size32;
    if (size32 === 1) {
      if (offset + 16 > end) break;
      const extended = view.getBigUint64(offset + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) break;
      boxSize = Number(extended);
      headerSize = 16;
    } else if (size32 === 0) {
      boxSize = end - offset;
    }
    if (!Number.isSafeInteger(boxSize) || boxSize < headerSize || offset + boxSize > end) break;
    boxes.push({ type, start: offset + headerSize, end: offset + boxSize });
    offset += boxSize;
  }
  return boxes;
}

function parseMp4CanvasInfo(buffer: ArrayBuffer): { duration: number; width: number; height: number } | null {
  try {
    const view = new DataView(buffer);
    const top = readIsoBoxes(view, 0, view.byteLength);
    if (!top.some((box) => box.type === 'ftyp')) return null;
    const moov = top.find((box) => box.type === 'moov');
    if (!moov) return null;
    const moovChildren = readIsoBoxes(view, moov.start, moov.end);
    const mvhd = moovChildren.find((box) => box.type === 'mvhd');
    if (!mvhd || mvhd.start + 20 > mvhd.end) return null;
    const mvhdVersion = view.getUint8(mvhd.start);
    let timescale = 0;
    let durationUnits = 0;
    if (mvhdVersion === 1) {
      if (mvhd.start + 32 > mvhd.end) return null;
      timescale = view.getUint32(mvhd.start + 20);
      const durationValue = view.getBigUint64(mvhd.start + 24);
      durationUnits = Number(durationValue);
    } else if (mvhdVersion === 0) {
      timescale = view.getUint32(mvhd.start + 12);
      durationUnits = view.getUint32(mvhd.start + 16);
    } else {
      return null;
    }
    if (!timescale || !Number.isFinite(durationUnits) || durationUnits <= 0) return null;
    const duration = durationUnits / timescale;

    for (const track of moovChildren.filter((box) => box.type === 'trak')) {
      const trackChildren = readIsoBoxes(view, track.start, track.end);
      const mdia = trackChildren.find((box) => box.type === 'mdia');
      if (!mdia) continue;
      const mediaChildren = readIsoBoxes(view, mdia.start, mdia.end);
      const handler = mediaChildren.find((box) => box.type === 'hdlr');
      const tkhd = trackChildren.find((box) => box.type === 'tkhd');
      if (!handler || !tkhd || handler.start + 12 > handler.end) continue;
      const handlerType = String.fromCharCode(
        view.getUint8(handler.start + 8), view.getUint8(handler.start + 9),
        view.getUint8(handler.start + 10), view.getUint8(handler.start + 11)
      );
      if (handlerType !== 'vide') continue;
      const version = view.getUint8(tkhd.start);
      const dimensionsOffset = version === 1 ? tkhd.start + 88 : tkhd.start + 76;
      if (dimensionsOffset + 8 > tkhd.end) return null;
      const width = view.getUint32(dimensionsOffset) / 65536;
      const height = view.getUint32(dimensionsOffset + 4) / 65536;
      if (width > 0 && height > 0) return { duration, width, height };
    }
    return null;
  } catch {
    return null;
  }
}

function readEbmlVint(view: DataView, offset: number, removeMarker: boolean): { value: bigint; length: number; unknown: boolean } | null {
  if (offset >= view.byteLength) return null;
  const first = view.getUint8(offset);
  let marker = 0x80;
  let length = 1;
  while (length <= 8 && (first & marker) === 0) {
    marker >>= 1;
    length += 1;
  }
  if (length > 8 || offset + length > view.byteLength) return null;
  let value = BigInt(removeMarker ? (first & (marker - 1)) : first);
  for (let index = 1; index < length; index += 1) {
    value = (value << 8n) | BigInt(view.getUint8(offset + index));
  }
  const maximum = (1n << BigInt(7 * length)) - 1n;
  return { value, length, unknown: removeMarker && value === maximum };
}

function readEbmlElements(
  view: DataView,
  start: number,
  end: number
): Array<{ id: bigint; start: number; end: number }> {
  const elements: Array<{ id: bigint; start: number; end: number }> = [];
  let offset = start;
  while (offset < end) {
    const id = readEbmlVint(view, offset, false);
    if (!id) break;
    const size = readEbmlVint(view, offset + id.length, true);
    if (!size) break;
    const dataStart = offset + id.length + size.length;
    const dataEnd = size.unknown ? end : dataStart + Number(size.value);
    if (!Number.isSafeInteger(dataEnd) || dataEnd < dataStart || dataEnd > end) break;
    elements.push({ id: id.value, start: dataStart, end: dataEnd });
    offset = dataEnd;
    if (size.unknown) break;
  }
  return elements;
}

function readEbmlUnsigned(view: DataView, start: number, end: number): number | null {
  const length = end - start;
  if (length < 1 || length > 8) return null;
  let value = 0n;
  for (let offset = start; offset < end; offset += 1) {
    value = (value << 8n) | BigInt(view.getUint8(offset));
  }
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function parseWebmCanvasInfo(buffer: ArrayBuffer): { duration: number; width: number; height: number } | null {
  try {
    const view = new DataView(buffer);
    const top = readEbmlElements(view, 0, view.byteLength);
    const header = top.find((element) => element.id === 0x1A45DFA3n);
    const segment = top.find((element) => element.id === 0x18538067n);
    if (!header || !segment) return null;
    const docType = readEbmlElements(view, header.start, header.end).find((element) => element.id === 0x4282n);
    if (!docType) return null;
    let docTypeText = '';
    for (let offset = docType.start; offset < docType.end; offset += 1) docTypeText += String.fromCharCode(view.getUint8(offset));
    if (docTypeText.toLowerCase() !== 'webm') return null;

    const segmentChildren = readEbmlElements(view, segment.start, segment.end);
    const info = segmentChildren.find((element) => element.id === 0x1549A966n);
    const tracks = segmentChildren.find((element) => element.id === 0x1654AE6Bn);
    if (!info || !tracks) return null;
    const infoChildren = readEbmlElements(view, info.start, info.end);
    const durationElement = infoChildren.find((element) => element.id === 0x4489n);
    const scaleElement = infoChildren.find((element) => element.id === 0x2AD7B1n);
    if (!durationElement) return null;
    const durationLength = durationElement.end - durationElement.start;
    const durationValue = durationLength === 4
      ? view.getFloat32(durationElement.start)
      : durationLength === 8 ? view.getFloat64(durationElement.start) : NaN;
    const timecodeScale = scaleElement
      ? readEbmlUnsigned(view, scaleElement.start, scaleElement.end) ?? 1_000_000
      : 1_000_000;
    const duration = durationValue * timecodeScale / 1_000_000_000;
    if (!Number.isFinite(duration) || duration <= 0) return null;

    for (const trackEntry of readEbmlElements(view, tracks.start, tracks.end).filter((element) => element.id === 0xAEn)) {
      const trackChildren = readEbmlElements(view, trackEntry.start, trackEntry.end);
      const typeElement = trackChildren.find((element) => element.id === 0x83n);
      if (!typeElement || readEbmlUnsigned(view, typeElement.start, typeElement.end) !== 1) continue;
      const video = trackChildren.find((element) => element.id === 0xE0n);
      if (!video) continue;
      const videoChildren = readEbmlElements(view, video.start, video.end);
      const widthElement = videoChildren.find((element) => element.id === 0xB0n);
      const heightElement = videoChildren.find((element) => element.id === 0xBAn);
      if (!widthElement || !heightElement) return null;
      const width = readEbmlUnsigned(view, widthElement.start, widthElement.end) ?? 0;
      const height = readEbmlUnsigned(view, heightElement.start, heightElement.end) ?? 0;
      if (width > 0 && height > 0) return { duration, width, height };
    }
    return null;
  } catch {
    return null;
  }
}

function validateCanvasVideoOnServer(upload: File): string | null {
  const bufferPromise = upload.arrayBuffer();
  return bufferPromise.then((buffer) => {
    const metadata = upload.type === 'video/mp4'
      ? parseMp4CanvasInfo(buffer)
      : parseWebmCanvasInfo(buffer);
    if (!metadata) return 'The server could not verify this MP4/WebM video. Re-export it as a standard MP4 or WebM file.';
    if (metadata.duration > 15.05) return 'Canvas videos must be 15 seconds or shorter.';
    if (metadata.width < 720 || metadata.height < 1280) return 'Use an HD vertical video with at least 720 × 1280 resolution.';
    if (Math.abs((metadata.width / metadata.height) - (9 / 16)) > 0.04) return 'Canvas videos must use a vertical 9:16 aspect ratio.';
    return null;
  }).catch(() => 'The server could not read this video file. Please re-export it as MP4 or WebM.');
}

async function reconcileLegacyKvMedia(
  env: Env,
  adminId: string,
  cursor?: string
): Promise<{ processed: number; imported: number; skipped: number; complete: boolean; cursor: string | null }> {
  const page = await env.MEDIA.list({ prefix: 'media/', limit: 100, ...(cursor ? { cursor } : {}) });
  let processed = 0;
  let imported = 0;
  let skipped = 0;

  for (const key of page.keys) {
    processed += 1;
    const match = key.name.match(/^media\/([a-f0-9-]{36})$/i);
    if (!match) {
      skipped += 1;
      continue;
    }

    let metadata = (key.metadata ?? null) as MediaMetadata | null;
    let size = Number(metadata?.size ?? 0);
    if (!Number.isFinite(size) || size <= 0 || !metadata?.contentType) {
      const stored = await env.MEDIA.getWithMetadata<MediaMetadata>(key.name, 'arrayBuffer');
      if (!stored.value) {
        skipped += 1;
        continue;
      }
      metadata = stored.metadata ?? metadata;
      if (!Number.isFinite(size) || size <= 0) size = (stored.value as ArrayBuffer).byteLength;
    }
    if (!Number.isFinite(size) || size <= 0) {
      skipped += 1;
      continue;
    }

    const contentType = safeText(metadata?.contentType, 120) || 'application/octet-stream';
    const fileName = safeText(metadata?.fileName, 120) || match[1];
    const kind: 'audio' | 'image' | 'video' = contentType.startsWith('image/')
      ? 'image'
      : contentType.startsWith('video/') ? 'video' : 'audio';
    const result = await env.DB.prepare(`
      INSERT OR IGNORE INTO media_assets
        (id, provider, object_key, media_kind, file_name, content_type, size_bytes, created_by, status)
      VALUES (?, 'kv', ?, ?, ?, ?, ?, ?, 'ready')
    `).bind(match[1], key.name, kind, fileName, contentType, Math.floor(size), adminId).run();
    imported += Number(result.meta.changes ?? 0);
    if (!result.meta.changes) skipped += 1;
  }

  return {
    processed,
    imported,
    skipped,
    complete: page.list_complete,
    cursor: page.list_complete ? null : (page.cursor ?? null)
  };
}

async function ensureAdminSchema(env: Env): Promise<void> {
  await ensureAdminActivationAttemptsSchema(env);
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


async function tracksWithCanvas(
  env: Env,
  canvasSql: string,
  legacySql: string,
  values: unknown[] = []
): Promise<Array<Record<string, unknown>>> {
  try {
    const statement = env.DB.prepare(canvasSql);
    const result = await (values.length ? statement.bind(...values) : statement).all<Record<string, unknown>>();
    return result.results ?? [];
  } catch (error) {
    // Until the first authorized Admin Centre visit provisions video_path,
    // keep public catalog, playlists, and likes fully available without Canvas.
    const statement = env.DB.prepare(legacySql);
    const result = await (values.length ? statement.bind(...values) : statement).all<Record<string, unknown>>();
    return (result.results ?? []).map((row) => ({ ...row, video_path: null }));
  }
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
    const validationError = await validateCanvasVideoOnServer(upload);
    if (validationError) return reply({ error: validationError }, 400);
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
    try {
      if (provider === 'r2' && env.MEDIA_R2) await env.MEDIA_R2.delete(key);
      else await env.MEDIA.delete(key);
    } catch (cleanupError) {
      console.error('DeanMusic upload cleanup could not remove a partial media object:', cleanupError);
    }
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
  const key = 'media/' + id;
  if (env.MEDIA_R2) {
    const head = await env.MEDIA_R2.head(key);
    if (head) {
      const size = head.size;
      const rangeHeader = request.headers.get('range');
      const headers = new Headers({
        'Content-Type': head.httpMetadata?.contentType || 'application/octet-stream',
        'Content-Disposition': 'inline',
        'Accept-Ranges': 'bytes',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
        'Access-Control-Allow-Origin': '*'
      });
      if (!rangeHeader) {
        const object = await env.MEDIA_R2.get(key);
        if (!object?.body) return reply({ error: 'Media not found.' }, 404);
        headers.set('Content-Length', String(size));
        return new Response(object.body, { status: 200, headers });
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
      const length = end - start + 1;
      const object = await env.MEDIA_R2.get(key, { range: { offset: start, length } });
      if (!object?.body) return reply({ error: 'Media not found.' }, 404);
      headers.set('Content-Length', String(length));
      headers.set('Content-Range', 'bytes ' + start + '-' + end + '/' + size);
      return new Response(object.body, { status: 206, headers });
    }
  }

  const { value, metadata } = await env.MEDIA.getWithMetadata<MediaMetadata>(key, 'arrayBuffer');
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
      return reply({ ok: true, service: 'DeanMusic API', database: 'Cloudflare D1', media: env.MEDIA_R2 ? 'Cloudflare R2' : 'Cloudflare Workers KV' });
    }

    if (path === '/api/catalog' && request.method === 'GET') {
      const tracks = await tracksWithCanvas(
        env,
        'SELECT t.id, t.title, t.duration_seconds, t.genre, t.audio_path, t.video_path, t.external_audio_url, t.plays_count, ar.name AS artist_name, al.title AS album_title, al.cover_url FROM tracks t INNER JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id WHERE t.is_published = 1 ORDER BY t.plays_count DESC, t.created_at DESC LIMIT 100',
        'SELECT t.id, t.title, t.duration_seconds, t.genre, t.audio_path, t.external_audio_url, t.plays_count, ar.name AS artist_name, al.title AS album_title, al.cover_url FROM tracks t INNER JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id WHERE t.is_published = 1 ORDER BY t.plays_count DESC, t.created_at DESC LIMIT 100'
      );
      return reply({ tracks }, 200, 'public, max-age=60, stale-while-revalidate=300');
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
      const tracks = await tracksWithCanvas(
        env,
        'SELECT id, title, duration_seconds, track_number, genre, audio_path, video_path, external_audio_url, plays_count FROM tracks WHERE album_id = ? AND is_published = 1 ORDER BY track_number ASC, created_at ASC',
        'SELECT id, title, duration_seconds, track_number, genre, audio_path, external_audio_url, plays_count FROM tracks WHERE album_id = ? AND is_published = 1 ORDER BY track_number ASC, created_at ASC',
        [publicAlbumMatch[1]]
      );
      return reply({ album, tracks }, 200, 'public, max-age=60, stale-while-revalidate=300');
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
      const tracks = await tracksWithCanvas(
        env,
        'SELECT t.id, t.title, t.duration_seconds, t.genre, t.audio_path, t.video_path, t.external_audio_url, t.plays_count, ar.name AS artist_name, al.title AS album_title FROM playlist_tracks pt INNER JOIN tracks t ON t.id = pt.track_id INNER JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id WHERE pt.playlist_id = ? AND t.is_published = 1 ORDER BY pt.position ASC',
        'SELECT t.id, t.title, t.duration_seconds, t.genre, t.audio_path, t.external_audio_url, t.plays_count, ar.name AS artist_name, al.title AS album_title FROM playlist_tracks pt INNER JOIN tracks t ON t.id = pt.track_id INNER JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id WHERE pt.playlist_id = ? AND t.is_published = 1 ORDER BY pt.position ASC',
        [publicOrOwnedPlaylist[1]]
      );
      return reply({ playlist, tracks }, 200, playlist.is_public ? 'public, max-age=30' : 'no-store');
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
      const tracks = await tracksWithCanvas(
        env,
        'SELECT t.id, t.title, t.genre, t.duration_seconds, t.audio_path, t.video_path, ar.name AS artist_name, al.title AS album_title FROM liked_tracks l INNER JOIN tracks t ON t.id = l.track_id INNER JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id WHERE l.user_id = ? AND t.is_published = 1 ORDER BY l.liked_at DESC LIMIT 500',
        'SELECT t.id, t.title, t.genre, t.duration_seconds, t.audio_path, ar.name AS artist_name, al.title AS album_title FROM liked_tracks l INNER JOIN tracks t ON t.id = l.track_id INNER JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id WHERE l.user_id = ? AND t.is_published = 1 ORDER BY l.liked_at DESC LIMIT 500',
        [user.id]
      );
      return reply({ tracks });
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

      try {
        await ensureAdminActivationAttemptsSchema(env);
      } catch (error) {
        console.error('DeanMusic administrator activation lockout schema is unavailable:', error);
        return reply({ error: 'Admin activation is temporarily unavailable. Please try again later.' }, 503);
      }

      const attempts = await getAdminActivationAttempts(env, user.id);
      const lockedUntil = attempts?.locked_until ? Date.parse(attempts.locked_until) : NaN;
      if (Number.isFinite(lockedUntil) && lockedUntil > Date.now()) {
        return reply({ error: 'Too many incorrect activation attempts. Please wait 15 minutes before trying again.' }, 429);
      }

      const body = await bodyJson<{ token?: unknown }>(request);
      const token = typeof body?.token === 'string' ? body.token.trim() : '';
      const validTokenLength = token.length >= 43 && token.length <= 128;
      const actualHash = validTokenLength ? await sha256Hex(token) : '';
      if (!validTokenLength || !constantTimeEqual(actualHash, expectedHash)) {
        await recordAdminActivationFailure(env, user.id);
        const updatedAttempts = await getAdminActivationAttempts(env, user.id);
        const isLocked = Boolean(updatedAttempts?.locked_until && Date.parse(updatedAttempts.locked_until) > Date.now());
        return reply({
          error: isLocked
            ? 'Too many incorrect activation attempts. Please wait 15 minutes before trying again.'
            : 'The one-time activation code is invalid or expired.'
        }, isLocked ? 429 : 403);
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
      await env.DB.prepare('DELETE FROM admin_activation_attempts WHERE user_id = ?').bind(user.id).run();
      return reply({ isAdmin: true, activated: true }, 201);
    }

    if (path === '/api/admin/status' && request.method === 'GET') {
      const user = await getUser(request, env);
      return reply({ isAdmin: user ? await isAdmin(user, env) : false });
    }

    if (path === '/api/admin/media/reconcile' && request.method === 'POST') {
      const admin = await getAdmin(request, env);
      if (!admin) return reply({ error: 'Admin access required.' }, 403);
      if (env.MEDIA_R2) return reply({ error: 'The active provider is R2; this scan is only for legacy KV objects.' }, 409);
      await ensureMediaSchema(env);
      const body = await bodyJson<{ cursor?: unknown }>(request);
      const cursor = typeof body?.cursor === 'string' && body.cursor.length <= 4096 ? body.cursor : undefined;
      const result = await reconcileLegacyKvMedia(env, admin.id, cursor);
      const usedBytes = await mediaUsage(env, 'kv');
      return reply({
        ...result,
        provider: 'Cloudflare Workers KV',
        usedBytes,
        limitBytes: KV_STORAGE_LIMIT_BYTES,
        warningBytes: Math.floor(KV_STORAGE_LIMIT_BYTES * 0.8)
      });
    }

    if (path === '/api/admin/media' && request.method === 'POST') {
      const admin = await getAdmin(request, env);
      if (!admin) return reply({ error: 'Admin access required.' }, 403);
      return await uploadMedia(request, env, admin);
    }

    if (path === '/api/admin/media' && request.method === 'GET') {
      const admin = await getAdmin(request, env);
      if (!admin) return reply({ error: 'Admin access required.' }, 403);
      const provider: 'r2' | 'kv' = env.MEDIA_R2 ? 'r2' : 'kv';
      const usedBytes = await mediaUsage(env, provider);
      const limitBytes = provider === 'r2' ? R2_STORAGE_LIMIT_BYTES : KV_STORAGE_LIMIT_BYTES;
      const warningBytes = provider === 'r2' ? R2_STORAGE_WARNING_BYTES : Math.floor(limitBytes * 0.8);
      return reply({
        provider: provider === 'r2' ? 'Cloudflare R2' : 'Cloudflare KV',
        r2Connected: provider === 'r2',
        usedBytes,
        limitBytes,
        warningBytes,
        percentUsed: Math.min(100, Math.round((usedBytes / limitBytes) * 10000) / 100),
        canUpload: usedBytes < limitBytes
      });
    }

    const mediaDelete = path.match(/^\/api\/admin\/media\/([a-f0-9-]{36})$/i);
    if (mediaDelete && request.method === 'DELETE') {
      const admin = await getAdmin(request, env);
      if (!admin) return reply({ error: 'Admin access required.' }, 403);
      await deleteMediaPath(env, '/media/' + mediaDelete[1]);
      return reply({ deleted: true });
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
      await ensureMediaSchema(env);
      const result = await env.DB.prepare(
        'SELECT t.id, t.album_id, t.title, t.duration_seconds, t.track_number, t.genre, t.audio_path, t.video_path, t.is_published, t.plays_count, ar.name AS artist_name, al.title AS album_title FROM tracks t INNER JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id ORDER BY t.created_at DESC LIMIT 500'
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
        if (!(await hasMediaObject(env, mediaId))) return reply({ error: 'Uploaded audio file not found in media storage.' }, 400);
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
      await ensureMediaSchema(env);
      const body = await bodyJson<{ title?: unknown; genre?: unknown; duration?: unknown; trackNumber?: unknown; videoPath?: unknown }>(request);
      const title = safeText(body?.title, 120);
      const genre = safeText(body?.genre, 60);
      const duration = Number(body?.duration);
      const trackNumber = Number(body?.trackNumber);
      if (!title || !Number.isFinite(duration) || duration < 0 || duration > 86400 || !Number.isInteger(trackNumber) || trackNumber < 1) {
        return reply({ error: 'Check the track title, duration, and track number.' }, 400);
      }
      const existing = await env.DB.prepare('SELECT video_path FROM tracks WHERE id = ?')
        .bind(adminTrack[1]).first<{ video_path: string | null }>();
      if (!existing) return reply({ error: 'Track not found.' }, 404);

      let newVideoPath: string | null | undefined;
      if (body && Object.prototype.hasOwnProperty.call(body, 'videoPath')) {
        if (body.videoPath === null || body.videoPath === '') {
          newVideoPath = null;
        } else if (typeof body.videoPath === 'string' && /^\/media\/[a-f0-9-]{36}$/i.test(body.videoPath)) {
          const videoId = body.videoPath.slice('/media/'.length);
          if (!(await hasMediaObject(env, videoId))) return reply({ error: 'Uploaded video file not found in media storage.' }, 400);
          newVideoPath = body.videoPath;
        } else {
          return reply({ error: 'Invalid video media path.' }, 400);
        }
      }

      await env.DB.prepare(
        'UPDATE tracks SET title = ?, genre = ?, duration_seconds = ?, track_number = ?, updated_at = datetime(\'now\') WHERE id = ?'
      ).bind(title, genre || null, Math.floor(duration), trackNumber, adminTrack[1]).run();

      if (newVideoPath !== undefined && newVideoPath !== existing.video_path) {
        await env.DB.prepare('UPDATE tracks SET video_path = ? WHERE id = ?').bind(newVideoPath, adminTrack[1]).run();
        if (existing.video_path) await deleteMediaPath(env, existing.video_path);
      }
      return reply({ updated: true });
    }

    if (adminTrack && request.method === 'DELETE') {
      const admin = await getAdmin(request, env);
      if (!admin) return reply({ error: 'Admin access required.' }, 403);
      await ensureMediaSchema(env);
      const track = await env.DB.prepare('SELECT audio_path, video_path FROM tracks WHERE id = ?')
        .bind(adminTrack[1]).first<{ audio_path: string | null; video_path: string | null }>();
      if (!track) return reply({ error: 'Track not found.' }, 404);
      if (track.audio_path) await deleteMediaPath(env, track.audio_path);
      if (track.video_path) await deleteMediaPath(env, track.video_path);
      await env.DB.prepare('DELETE FROM tracks WHERE id = ?').bind(adminTrack[1]).run();
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

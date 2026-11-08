import { betterAuth } from 'better-auth';

interface Env {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  APP_ORIGIN: string;
  ADMIN_EMAILS?: string;
}
interface Context {
  request: Request;
  env: Env;
}
type UserRecord = { id: string; name: string; email: string };

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

async function bodyJson<T>(request: Request): Promise<T | null> {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 16384) return null;
  try { return await request.json() as T; }
  catch { return null; }
}

function isAdmin(user: UserRecord, env: Env): boolean {
  const emails = (env.ADMIN_EMAILS || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  return emails.includes(user.email.toLowerCase());
}

export const onRequest = async ({ request, env }: Context): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname;

  // Enforce same-origin writes for custom endpoints that use cookie sessions.
  // Better Auth's own auth endpoints separately validate trusted origins.
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

    if (path === '/api/health' && request.method === 'GET') {
      await env.DB.prepare('SELECT 1 AS ok').first();
      return reply({ ok: true, service: 'DeanMusic API', database: 'Cloudflare D1' });
    }

    if (path === '/api/catalog' && request.method === 'GET') {
      const result = await env.DB.prepare(
        'SELECT t.id, t.title, t.duration_seconds, t.genre, t.audio_path, t.external_audio_url, t.plays_count, ar.name AS artist_name, al.title AS album_title, al.cover_url FROM tracks t INNER JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id WHERE t.is_published = 1 ORDER BY t.plays_count DESC, t.created_at DESC LIMIT 100'
      ).all();
      return reply({ tracks: result.results }, 200, 'public, max-age=60, stale-while-revalidate=300');
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
      const body = await bodyJson<{ name?: unknown; description?: unknown }>(request);
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      const description = typeof body?.description === 'string' ? body.description.trim() : '';
      if (!name || name.length > 80) return reply({ error: 'Playlist name must be 1–80 characters.' }, 400);
      if (description.length > 500) return reply({ error: 'Description is limited to 500 characters.' }, 400);
      const id = crypto.randomUUID();
      await env.DB.prepare(
        'INSERT INTO playlists (id, owner_id, name, description, is_public) VALUES (?, ?, ?, ?, 0)'
      ).bind(id, user.id, name, description || null).run();
      return reply({ playlist: { id, name, description: description || null, is_public: 0 } }, 201);
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

    const addPlaylistTrack = path.match(/^\/api\/playlists\/([a-zA-Z0-9_-]+)\/tracks$/);
    if (addPlaylistTrack && request.method === 'POST') {
      const user = await getUser(request, env);
      if (!user) return reply({ error: 'Sign in required.' }, 401);
      const body = await bodyJson<{ trackId?: unknown }>(request);
      const trackId = typeof body?.trackId === 'string' ? body.trackId : '';
      if (!trackId || trackId.length > 100) return reply({ error: 'Invalid track ID.' }, 400);
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

    if (path === '/api/admin/status' && request.method === 'GET') {
      const user = await getUser(request, env);
      return reply({ isAdmin: user ? isAdmin(user, env) : false });
    }

    if (path === '/api/admin/tracks' && request.method === 'GET') {
      const user = await getUser(request, env);
      if (!user || !isAdmin(user, env)) return reply({ error: 'Admin access required.' }, 403);
      const result = await env.DB.prepare(
        'SELECT t.*, ar.name AS artist_name, al.title AS album_title FROM tracks t INNER JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id ORDER BY t.created_at DESC LIMIT 300'
      ).all();
      return reply({ tracks: result.results });
    }

    return reply({ error: 'Not found.' }, 404);
  } catch (error) {
    console.error('DeanMusic API error:', error);
    return reply({ error: 'The service could not complete this request. Please try again later.' }, 500);
  }
};

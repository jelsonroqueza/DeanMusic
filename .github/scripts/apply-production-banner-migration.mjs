const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID;
if (!token || !accountId || !databaseId) {
  throw new Error("Production D1 migration credentials/configuration are missing. No database request was made.");
}

const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function query(sql, label) {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sql }),
      });
      const payload = await response.json().catch(() => null);
      const result = Array.isArray(payload?.result) ? payload.result[0] : payload?.result;
      const failedResult = result?.success === false || Boolean(result?.error);
      if (response.ok && payload?.success === true && !failedResult) {
        return result?.results ?? [];
      }
      const errors = Array.isArray(payload?.errors) ? payload.errors : [];
      const codes = errors.map((item) => Number(item.code)).filter(Number.isFinite);
      const message = errors.map((item) => String(item.message ?? "Cloudflare API error")).join("; ");
      const retryable = response.status >= 500 || codes.includes(7500) || codes.includes(7429);
      lastError = new Error(`${label} failed (HTTP ${response.status}; code ${codes.join(",") || "unknown"}): ${message || "request rejected"}`);
      if (!retryable || attempt === 4) break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Unknown Cloudflare D1 request error.");
      if (attempt === 4) break;
    }
    await wait(1200 * (2 ** attempt));
  }
  throw lastError ?? new Error(`${label} failed.`);
}

async function columns(table) {
  const rows = await query(`PRAGMA table_info("${table}")`, `Inspecting ${table} columns`);
  return new Set(rows.map((row) => String(row.name)));
}

console.log("STEP 1/6 — Read-only Production D1 preflight.");
const tableRows = await query(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  "Reading Production tables"
);
const tables = new Set(tableRows.map((row) => String(row.name)));
const requiredTables = [
  "user", "session", "account", "verification", "artists", "albums",
  "tracks", "playlists", "playlist_tracks", "liked_tracks", "follows",
  "saved_albums", "recently_played", "admins", "media_assets", "d1_migrations",
];
const missingTables = requiredTables.filter((name) => !tables.has(name));
if (missingTables.length) {
  throw new Error("PRE-FLIGHT STOP: Production is missing expected DeanMusic tables: " + missingTables.join(", ") + ". No writes were made.");
}

const requiredColumns = {
  user: ["id", "name", "email"],
  artists: ["id", "name"],
  albums: ["id", "artist_id", "title", "cover_url", "is_published", "published_at", "created_by"],
  tracks: ["id", "album_id", "artist_id", "title", "audio_path", "is_published", "video_path"],
  media_assets: ["id", "provider", "object_key", "media_kind", "file_name", "content_type", "size_bytes", "created_by", "status"],
  d1_migrations: ["id", "name", "applied_at"],
};
for (const [table, expected] of Object.entries(requiredColumns)) {
  const found = await columns(table);
  const missing = expected.filter((name) => !found.has(name));
  if (missing.length) {
    throw new Error(`PRE-FLIGHT STOP: ${table} is missing expected columns: ${missing.join(", ")}. No writes were made.`);
  }
}

const signalOne = await query("SELECT id, is_published FROM albums WHERE id='signal-one'", "Checking approved Signal One album");
if (!signalOne.length) {
  throw new Error("PRE-FLIGHT STOP: approved Signal One album was not found. No writes were made.");
}
const signalTrackRows = await query("SELECT COUNT(*) AS total FROM tracks WHERE album_id='signal-one'", "Counting Signal One tracks");
const signalTrackCount = Number(signalTrackRows?.[0]?.total ?? 0);
if (signalTrackCount <= 0) {
  throw new Error("PRE-FLIGHT STOP: Signal One has no tracks, so the approved publication change cannot be verified. No writes were made.");
}
const indexRows = await query("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'", "Reading Production indexes");
const indexNames = new Set(indexRows.map((row) => String(row.name)));
const expectedIndexes = ["session_userId_idx", "account_userId_idx", "account_provider_account_idx", "verification_identifier_idx", "idx_albums_artist_id", "idx_albums_public", "idx_tracks_artist_id", "idx_tracks_album_id", "idx_tracks_published_plays", "idx_playlists_owner_id", "idx_playlist_tracks_order", "idx_playlists_public", "idx_recently_played_user_time", "idx_media_assets_provider_status"];
const missingIndexes = expectedIndexes.filter((name) => !indexNames.has(name));
if (missingIndexes.length) {
  throw new Error("PRE-FLIGHT STOP: Production is missing expected baseline indexes: " + missingIndexes.join(", ") + ". No writes were made.");
}

const knownMigrations = [
  "0001_init.sql",
  "0002_public_albums_admin.sql",
  "0003_media_assets_canvas.sql",
  "0004_admin_activation_attempts.sql",
  "0005_album_track_banners.sql",
];
const historyRows = await query("SELECT name FROM d1_migrations ORDER BY id", "Reading D1 migration history");
const history = new Set(historyRows.map((row) => String(row.name)));
const unknown = [...history].filter((name) => !knownMigrations.includes(name));
if (unknown.length) {
  throw new Error("PRE-FLIGHT STOP: unexpected migration history entries: " + unknown.join(", ") + ". No writes were made.");
}
console.log(`Preflight passed: ${requiredTables.length} existing tables; Signal One exists with ${signalTrackCount} track(s); migration history contains ${history.size} known record(s).`);

console.log("STEP 2/6 — Ensure the already-approved administrator activation table.");
if (!tables.has("admin_activation_attempts")) {
  await query(
    "CREATE TABLE IF NOT EXISTS admin_activation_attempts (user_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE, failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0), locked_until TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
    "Creating admin_activation_attempts"
  );
}
const activationColumns = await columns("admin_activation_attempts");
for (const name of ["user_id", "failed_attempts", "locked_until", "updated_at"]) {
  if (!activationColumns.has(name)) {
    throw new Error("Production activation table is missing expected column " + name + ". Stopping before banner migration.");
  }
}

console.log("STEP 3/6 — Record only verified existing migration baseline.");
for (const name of knownMigrations.slice(0, 4)) {
  if (!history.has(name)) {
    const escaped = name.replaceAll("'", "''");
    await query(
      `INSERT INTO d1_migrations (name) SELECT '${escaped}' WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name='${escaped}')`,
      "Recording verified baseline " + name
    );
  }
}

console.log("STEP 4/6 — Add optional album and soundtrack banner fields only when missing.");
const albumColumns = await columns("albums");
if (!albumColumns.has("banner_url")) {
  await query("ALTER TABLE albums ADD COLUMN banner_url TEXT", "Adding albums.banner_url");
}
const trackColumns = await columns("tracks");
if (!trackColumns.has("banner_url")) {
  await query("ALTER TABLE tracks ADD COLUMN banner_url TEXT", "Adding tracks.banner_url");
}
const finalAlbumColumns = await columns("albums");
const finalTrackColumns = await columns("tracks");
if (!finalAlbumColumns.has("banner_url") || !finalTrackColumns.has("banner_url")) {
  throw new Error("Banner schema verification failed. Migration history 0005 has not been recorded.");
}

console.log("STEP 5/6 — Apply Dean's approved Signal One publication change.");
await query(
  "UPDATE albums SET is_published=1, published_at=COALESCE(published_at, datetime('now')) WHERE id='signal-one'",
  "Publishing Signal One album"
);
await query(
  "UPDATE tracks SET is_published=1 WHERE album_id='signal-one'",
  "Publishing all Signal One tracks"
);
const verifyAlbum = await query("SELECT is_published FROM albums WHERE id='signal-one'", "Verifying Signal One publication");
const unpublished = await query("SELECT COUNT(*) AS total FROM tracks WHERE album_id='signal-one' AND is_published=0", "Checking unpublished Signal One tracks");
if (Number(verifyAlbum?.[0]?.is_published) !== 1 || Number(unpublished?.[0]?.total ?? -1) !== 0) {
  throw new Error("Signal One publication verification failed. Do not deploy the app until this is resolved.");
}

console.log("STEP 6/6 — Record and verify banner migration 0005.");
const migrationName = "0005_album_track_banners.sql";
await query(
  `INSERT INTO d1_migrations (name) SELECT '${migrationName}' WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name='${migrationName}')`,
  "Recording banner migration 0005"
);
const finalHistory = await query("SELECT name FROM d1_migrations ORDER BY id", "Final migration history verification");
const finalNames = new Set(finalHistory.map((row) => String(row.name)));
for (const name of knownMigrations) {
  if (!finalNames.has(name)) throw new Error("Final migration history is missing " + name);
}
console.log("SUCCESS: Production D1 now has albums.banner_url and tracks.banner_url; Signal One and all its tracks are published.");
console.log("Migration history: " + knownMigrations.join(", "));
console.log("No audio/video media objects, user records, R2 bindings, or billing settings were changed.");

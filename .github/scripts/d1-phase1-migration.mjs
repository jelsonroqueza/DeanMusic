const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID;

if (!token) {
  console.log("WAITING_FOR_SECRET: Add CLOUDFLARE_API_TOKEN in GitHub repository Actions secrets. No Cloudflare request was made.");
  process.exit(0);
}
if (!accountId || !databaseId) {
  throw new Error("Cloudflare account/database configuration is missing.");
}

const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      const firstResult = Array.isArray(payload?.result) ? payload.result[0] : payload?.result;
      const innerFailed = firstResult?.success === false || Boolean(firstResult?.error);
      if (response.ok && payload?.success === true && !innerFailed) {
        return firstResult?.results ?? [];
      }

      const cloudflareErrors = Array.isArray(payload?.errors) ? payload.errors : [];
      const errorCodes = cloudflareErrors.map((item) => Number(item.code)).filter(Number.isFinite);
      const retryable = response.status >= 500 || errorCodes.includes(7500) || errorCodes.includes(7429);
      const safeMessage = cloudflareErrors.map((item) => String(item.message ?? "Cloudflare API error")).join("; ");
      lastError = new Error(`${label} failed (HTTP ${response.status}; codes ${errorCodes.join(",") || "none"}): ${safeMessage || "Cloudflare did not accept the request"}`);

      if (!retryable || attempt === 4) break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Unknown Cloudflare request error.");
      if (attempt === 4) break;
    }
    await sleep(1200 * (2 ** attempt));
  }
  throw lastError ?? new Error(`${label} failed.`);
}

function requireColumns(tableSql, tableName, columns) {
  const sql = String(tableSql ?? "").toLowerCase();
  const missing = columns.filter((column) => !sql.includes(column.toLowerCase()));
  if (missing.length) {
    throw new Error(`Preflight stopped: ${tableName} is missing expected column(s): ${missing.join(", ")}. No database writes were made.`);
  }
}

console.log("STEP 1/5: Inspecting current Production schema (read-only)...");
const schemaRows = await query(
  "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  "Production schema inspection"
);
const tables = new Map(schemaRows.map((row) => [String(row.name), String(row.sql ?? "")]));

const requiredTables = [
  "user", "session", "account", "verification",
  "artists", "albums", "tracks", "playlists", "playlist_tracks",
  "liked_tracks", "follows", "saved_albums", "recently_played",
  "admins", "media_assets", "d1_migrations",
];
const missingTables = requiredTables.filter((name) => !tables.has(name));
if (missingTables.length) {
  throw new Error(`Preflight stopped: expected existing table(s) missing: ${missingTables.join(", ")}. No database writes were made.`);
}

requireColumns(tables.get("albums"), "albums", ["description", "is_published", "published_at", "created_by"]);
requireColumns(tables.get("tracks"), "tracks", ["video_path"]);
requireColumns(tables.get("media_assets"), "media_assets", [
  "provider", "object_key", "media_kind", "file_name", "content_type",
  "size_bytes", "created_by", "status", "created_at",
]);
requireColumns(tables.get("d1_migrations"), "d1_migrations", ["name", "applied_at"]);

console.log(`Preflight passed: ${requiredTables.length} required baseline tables are present; album/media schema matches the existing DeanMusic baseline.`);

console.log("STEP 2/5: Checking expected indexes and migration history (read-only)...");
const indexRows = await query(
  "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'",
  "Index inspection"
);
const indexes = new Set(indexRows.map((row) => String(row.name)));
const requiredIndexes = [
  "session_userId_idx",
  "account_userId_idx",
  "account_provider_account_idx",
  "verification_identifier_idx",
  "idx_albums_artist_id",
  "idx_tracks_artist_id",
  "idx_tracks_album_id",
  "idx_tracks_published_plays",
  "idx_playlists_owner_id",
  "idx_playlist_tracks_order",
  "idx_recently_played_user_time",
  "idx_albums_public",
  "idx_playlists_public",
  "idx_media_assets_provider_status",
];
const missingIndexes = requiredIndexes.filter((name) => !indexes.has(name));
if (missingIndexes.length) {
  throw new Error(`Preflight stopped: expected existing index(es) missing: ${missingIndexes.join(", ")}. No database writes were made.`);
}

const historyRows = await query("SELECT name FROM d1_migrations ORDER BY id", "Migration history inspection");
const allowedNames = new Set([
  "0001_init.sql",
  "0002_public_albums_admin.sql",
  "0003_media_assets_canvas.sql",
  "0004_admin_activation_attempts.sql",
]);
const unknownHistory = historyRows.map((row) => String(row.name)).filter((name) => !allowedNames.has(name));
if (unknownHistory.length) {
  throw new Error(`Preflight stopped: unexpected migration history name(s): ${unknownHistory.join(", ")}. No database writes were made.`);
}
console.log(`Preflight passed: ${requiredIndexes.length} expected indexes are present; migration history has ${historyRows.length} known record(s).`);

console.log("STEP 3/5: Creating the Phase 1 activation lockout table...");
await query(
  "CREATE TABLE IF NOT EXISTS admin_activation_attempts (user_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE, failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0), locked_until TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
  "Creating admin_activation_attempts"
);
const activationTable = await query(
  "SELECT name, sql FROM sqlite_master WHERE type='table' AND name='admin_activation_attempts'",
  "Activation table verification"
);
if (!activationTable.length) {
  throw new Error("Activation lockout table was not found after creation.");
}
requireColumns(activationTable[0].sql, "admin_activation_attempts", [
  "user_id", "failed_attempts", "locked_until", "updated_at",
]);
console.log("Verified: admin_activation_attempts exists with the expected lockout columns.");

console.log("STEP 4/5: Recording the verified migration baseline...");
const migrationNames = [
  "0001_init.sql",
  "0002_public_albums_admin.sql",
  "0003_media_assets_canvas.sql",
  "0004_admin_activation_attempts.sql",
];
for (const name of migrationNames) {
  const escaped = name.replaceAll("'", "''");
  await query(
    `INSERT INTO d1_migrations (name) SELECT '${escaped}' WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = '${escaped}')`,
    `Recording ${name}`
  );
}

console.log("STEP 5/5: Verifying final Production state...");
const finalHistory = await query("SELECT name FROM d1_migrations ORDER BY id", "Final migration history verification");
const finalNames = new Set(finalHistory.map((row) => String(row.name)));
const missingHistory = migrationNames.filter((name) => !finalNames.has(name));
if (missingHistory.length) {
  throw new Error(`Final verification failed; missing migration history record(s): ${missingHistory.join(", ")}.`);
}

const finalTable = await query(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='admin_activation_attempts'",
  "Final activation table verification"
);
if (!finalTable.length) {
  throw new Error("Final verification failed; activation table is missing.");
}

const demoTrackRows = await query(
  "SELECT COUNT(*) AS total FROM tracks WHERE id='demo-midnight'",
  "Non-mutating demo track status check"
);
const demoTrackPresent = Number(demoTrackRows?.[0]?.total ?? 0) > 0;

console.log("SUCCESS: Phase 1 D1 security table and migration baseline are verified.");
console.log("Migration records: " + migrationNames.join(", "));
console.log("Music data, user rows, KV media objects, and R2 resources were not modified by this workflow.");
if (!demoTrackPresent) {
  console.log("NOTE: The existing demo-midnight track was already absent during preflight; this workflow did not recreate or alter it.");
}

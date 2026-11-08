-- DeanMusic media inventory for R2/KV storage and Canvas video metadata.
-- tracks.video_path is added idempotently by ensureMediaSchema() after it checks
-- PRAGMA table_info(tracks), so an already recovered production database is safe.
CREATE TABLE IF NOT EXISTS media_assets (
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
);

CREATE INDEX IF NOT EXISTS idx_media_assets_provider_status
  ON media_assets(provider, status);

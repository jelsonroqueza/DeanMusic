-- DeanMusic admin roles, public album metadata, and public playlist discovery.
-- Audio/image binary files are stored in the free-tier Workers KV namespace bound as MEDIA.
ALTER TABLE albums ADD COLUMN description TEXT;
ALTER TABLE albums ADD COLUMN is_published INTEGER NOT NULL DEFAULT 0 CHECK (is_published IN (0, 1));
ALTER TABLE albums ADD COLUMN published_at TEXT;
ALTER TABLE albums ADD COLUMN created_by TEXT;

CREATE TABLE IF NOT EXISTS admins (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role = 'admin'),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_albums_public ON albums(is_published, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_playlists_public ON playlists(is_public, created_at DESC);

-- Keep the existing demo album visible because it already contains a published track.
UPDATE albums
SET is_published = 1,
    published_at = COALESCE(published_at, created_at)
WHERE id IN (SELECT DISTINCT album_id FROM tracks WHERE is_published = 1 AND album_id IS NOT NULL);

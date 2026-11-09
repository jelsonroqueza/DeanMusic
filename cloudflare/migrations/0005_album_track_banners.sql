-- Optional wide visual banners for album releases and individual soundtracks.
-- Existing cover artwork remains unchanged; banner images are stored in MEDIA storage.
ALTER TABLE albums ADD COLUMN banner_url TEXT;
ALTER TABLE tracks ADD COLUMN banner_url TEXT;

-- Dean explicitly approved publishing the existing Signal One album and its tracks.
UPDATE albums
SET is_published = 1,
    published_at = COALESCE(published_at, datetime('now'))
WHERE id = 'signal-one';

UPDATE tracks
SET is_published = 1
WHERE album_id = 'signal-one';

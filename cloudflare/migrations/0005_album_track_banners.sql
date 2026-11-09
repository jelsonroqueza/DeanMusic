-- Optional wide visual banners for album releases and individual soundtracks.
-- Existing cover artwork remains unchanged; banner images are stored in MEDIA storage.
ALTER TABLE albums ADD COLUMN banner_url TEXT;
ALTER TABLE tracks ADD COLUMN banner_url TEXT;

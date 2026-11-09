-- Per-account throttling for first-administrator activation.
-- Five incorrect activation tokens trigger a 15-minute lockout.
CREATE TABLE IF NOT EXISTS admin_activation_attempts (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

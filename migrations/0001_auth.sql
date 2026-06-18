-- Auth schema for STPresetEditor cloud sync (D1).
-- Single-user model: one owner row in `users`; sessions and API keys reference it.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,   -- sha256(session token)
  user_id     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  name         TEXT,
  key_hash     TEXT NOT NULL UNIQUE,  -- sha256(api key); plaintext shown once
  prefix       TEXT NOT NULL,         -- first chars, for display only
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

CREATE TABLE IF NOT EXISTS used_reset_tokens (
  token_hash TEXT PRIMARY KEY,  -- sha256(consumed emergency reset token)
  used_at    INTEGER NOT NULL
);

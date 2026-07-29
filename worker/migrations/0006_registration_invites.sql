-- Muss vor dem Worker-Deploy mit verpflichtenden Einmal-Einladungen laufen.
-- CREATE IF NOT EXISTS macht einen Retry sicher; bestehende User und Login-Daten bleiben
-- unverändert.
CREATE TABLE IF NOT EXISTS registration_invites (
  token_hash TEXT PRIMARY KEY CHECK (LENGTH(token_hash) = 43),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at >= created_at),
  used_at    INTEGER,
  used_by    TEXT,
  CHECK (
    (used_at IS NULL AND used_by IS NULL) OR
    (used_at IS NOT NULL AND used_by IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_registration_invites_available
  ON registration_invites (expires_at)
  WHERE used_at IS NULL;

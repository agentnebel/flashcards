-- D1-Schema für den Sync-Server.
-- Anwenden:  npm run db:schema:local   (lokal)
--            npm run db:schema:remote  (Cloudflare)

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

-- Aktueller Stand je Objekt (Last-Write-Wins). payload = JSON, NULL bei Löschung.
CREATE TABLE IF NOT EXISTS sync_objects (
  user_id    TEXT NOT NULL,
  entity     TEXT NOT NULL,          -- deck | note | card | revlog | noteType
  entity_id  TEXT NOT NULL,
  payload    TEXT,
  deleted    INTEGER NOT NULL DEFAULT 0,
  seq        INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, entity, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_sync_user_seq ON sync_objects (user_id, seq);

-- Append-only Änderungs-Feed; seq dient als Delta-Cursor (USN-Äquivalent).
CREATE TABLE IF NOT EXISTS change_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  op         TEXT NOT NULL,          -- upsert | delete
  changed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changelog_user_seq ON change_log (user_id, seq);

-- Medien-Metadaten (Blobs liegen in R2 unter {user_id}/{sha256}).
CREATE TABLE IF NOT EXISTS media (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  sha256     TEXT NOT NULL,
  mime       TEXT,
  size       INTEGER,
  r2_key     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, sha256)
);

-- HINWEIS (Phase 2): Für Admin-Queries/Stats kann das generische sync_objects
-- später in normalisierte Tabellen (decks, notes, cards, revlog, note_types mit
-- parent_id-Adjazenzliste) überführt werden — siehe IMPLEMENTATION_PLAN.md §4.2.

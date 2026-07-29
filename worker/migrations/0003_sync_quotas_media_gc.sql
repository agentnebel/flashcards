-- Per-user-Cursor aus dem bisherigen globalen change_log-Cursor übernehmen, bevor
-- der alte Feed zum kompakten, dauerhaft benötigten Sequenz-Allocator wird.
CREATE TABLE IF NOT EXISTS registration_total_usage (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  users INTEGER NOT NULL DEFAULT 0 CHECK (users >= 0)
);
INSERT INTO registration_total_usage (id, users)
SELECT 1, COUNT(*) FROM users WHERE true
ON CONFLICT(id) DO UPDATE SET users = excluded.users;
CREATE TABLE IF NOT EXISTS registration_daily_usage (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  day           TEXT NOT NULL,
  registrations INTEGER NOT NULL
    CONSTRAINT registration_global_daily_limit CHECK (registrations BETWEEN 0 AND 5)
);
CREATE TABLE IF NOT EXISTS registration_ip_daily_usage (
  ip_key        TEXT PRIMARY KEY,
  day           TEXT NOT NULL,
  registrations INTEGER NOT NULL
    CONSTRAINT registration_ip_daily_limit CHECK (registrations BETWEEN 0 AND 1)
);
CREATE TRIGGER IF NOT EXISTS trg_user_insert_usage
AFTER INSERT ON users
BEGIN
  INSERT INTO registration_total_usage (id, users) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET users = registration_total_usage.users + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_user_delete_usage
AFTER DELETE ON users
BEGIN
  UPDATE registration_total_usage SET users = MAX(0, users - 1) WHERE id = 1;
END;

CREATE TABLE IF NOT EXISTS sync_counters (
  user_id TEXT PRIMARY KEY,
  seq     INTEGER NOT NULL DEFAULT 0 CHECK (seq >= 0)
);
INSERT INTO sync_counters (user_id, seq)
SELECT user_id, COALESCE(MAX(seq), 0)
FROM sync_objects
WHERE true
GROUP BY user_id
ON CONFLICT(user_id) DO UPDATE SET seq = MAX(sync_counters.seq, excluded.seq);

-- Ab diesem Punkt verwenden alter und neuer Worker denselben globalen AUTOINCREMENT-
-- Allocator. Der Feed selbst wächst nicht weiter; last_insert_rowid() bleibt trotz
-- sofortiger Löschung für das nachfolgende sync_objects-Upsert gültig.
CREATE TRIGGER IF NOT EXISTS trg_change_log_compact
AFTER INSERT ON change_log
BEGIN
  DELETE FROM change_log WHERE seq = NEW.seq;
END;

CREATE TABLE IF NOT EXISTS sync_object_usage (
  user_id TEXT PRIMARY KEY,
  objects INTEGER NOT NULL DEFAULT 0
    CONSTRAINT sync_user_objects_limit CHECK (objects BETWEEN 0 AND 50000),
  bytes   INTEGER NOT NULL DEFAULT 0
    CONSTRAINT sync_user_storage_bytes_limit CHECK (bytes BETWEEN 0 AND 67108864)
);
INSERT INTO sync_object_usage (user_id, objects, bytes)
SELECT user_id,
       COUNT(*),
       SUM(LENGTH(CAST(COALESCE(payload, '') AS BLOB)) + 256)
FROM sync_objects
WHERE true
GROUP BY user_id
ON CONFLICT(user_id) DO UPDATE SET objects = excluded.objects, bytes = excluded.bytes;

CREATE TABLE IF NOT EXISTS sync_global_storage_usage (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  bytes INTEGER NOT NULL DEFAULT 0
    CONSTRAINT sync_global_storage_bytes_limit CHECK (bytes BETWEEN 0 AND 268435456)
);
INSERT INTO sync_global_storage_usage (id, bytes)
SELECT 1, COALESCE(SUM(LENGTH(CAST(COALESCE(payload, '') AS BLOB)) + 256), 0)
FROM sync_objects
WHERE true
ON CONFLICT(id) DO UPDATE SET bytes = excluded.bytes;

-- Ab jetzt spiegeln auch Schreibvorgänge des noch laufenden Alt-Workers die neuen Zähler.
CREATE TABLE IF NOT EXISTS sync_payload_migration_guard (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  max_bytes INTEGER NOT NULL CHECK (max_bytes <= 262400)
);
INSERT OR REPLACE INTO sync_payload_migration_guard (id, max_bytes)
SELECT 1, COALESCE(MAX(LENGTH(CAST(COALESCE(payload, '') AS BLOB))), 0)
FROM sync_objects;
DROP TABLE sync_payload_migration_guard;

CREATE TRIGGER IF NOT EXISTS trg_sync_payload_insert_limit
BEFORE INSERT ON sync_objects
WHEN LENGTH(CAST(COALESCE(NEW.payload, '') AS BLOB)) > 262400
BEGIN
  SELECT RAISE(ABORT, 'sync_payload_too_large');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_payload_update_limit
BEFORE UPDATE OF payload ON sync_objects
WHEN LENGTH(CAST(COALESCE(NEW.payload, '') AS BLOB)) > 262400
BEGIN
  SELECT RAISE(ABORT, 'sync_payload_too_large');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_object_insert_usage
AFTER INSERT ON sync_objects
BEGIN
  INSERT INTO sync_counters (user_id, seq) VALUES (NEW.user_id, NEW.seq)
  ON CONFLICT(user_id) DO UPDATE SET seq = MAX(sync_counters.seq, excluded.seq);
  INSERT INTO sync_object_usage (user_id, objects, bytes)
  VALUES (NEW.user_id, 1, LENGTH(CAST(COALESCE(NEW.payload, '') AS BLOB)) + 256)
  ON CONFLICT(user_id) DO UPDATE SET
    objects = sync_object_usage.objects + 1,
    bytes = sync_object_usage.bytes + excluded.bytes;
  INSERT INTO sync_global_storage_usage (id, bytes)
  VALUES (1, LENGTH(CAST(COALESCE(NEW.payload, '') AS BLOB)) + 256)
  ON CONFLICT(id) DO UPDATE SET bytes = sync_global_storage_usage.bytes + excluded.bytes;
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_object_update_counter
AFTER UPDATE OF seq, payload ON sync_objects
BEGIN
  INSERT INTO sync_counters (user_id, seq) VALUES (NEW.user_id, NEW.seq)
  ON CONFLICT(user_id) DO UPDATE SET seq = MAX(sync_counters.seq, excluded.seq);
  UPDATE sync_object_usage
     SET bytes = bytes
       + LENGTH(CAST(COALESCE(NEW.payload, '') AS BLOB))
       - LENGTH(CAST(COALESCE(OLD.payload, '') AS BLOB))
   WHERE user_id = NEW.user_id;
  UPDATE sync_global_storage_usage
     SET bytes = bytes
       + LENGTH(CAST(COALESCE(NEW.payload, '') AS BLOB))
       - LENGTH(CAST(COALESCE(OLD.payload, '') AS BLOB))
   WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_object_delete_usage
AFTER DELETE ON sync_objects
BEGIN
  UPDATE sync_object_usage
     SET objects = MAX(0, objects - 1),
         bytes = MAX(0, bytes - LENGTH(CAST(COALESCE(OLD.payload, '') AS BLOB)) - 256)
   WHERE user_id = OLD.user_id;
  UPDATE sync_global_storage_usage
     SET bytes = MAX(0, bytes - LENGTH(CAST(COALESCE(OLD.payload, '') AS BLOB)) - 256)
   WHERE id = 1;
END;

CREATE TABLE IF NOT EXISTS sync_user_daily_usage (
  user_id   TEXT PRIMARY KEY,
  day       TEXT NOT NULL,
  mutations INTEGER NOT NULL
    CONSTRAINT sync_user_daily_mutations_limit CHECK (mutations BETWEEN 0 AND 2000)
);
CREATE TABLE IF NOT EXISTS sync_global_daily_usage (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  day       TEXT NOT NULL,
  mutations INTEGER NOT NULL
    CONSTRAINT sync_global_daily_mutations_limit CHECK (mutations BETWEEN 0 AND 5000)
);
CREATE TABLE IF NOT EXISTS sync_user_daily_pull_usage (
  user_id TEXT PRIMARY KEY,
  day     TEXT NOT NULL,
  units   INTEGER NOT NULL
    CONSTRAINT sync_user_daily_pull_limit CHECK (units BETWEEN 0 AND 25000)
);
CREATE TABLE IF NOT EXISTS sync_global_daily_pull_usage (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  day   TEXT NOT NULL,
  units INTEGER NOT NULL
    CONSTRAINT sync_global_daily_pull_limit CHECK (units BETWEEN 0 AND 100000)
);

ALTER TABLE media ADD COLUMN orphaned_at INTEGER;

CREATE TABLE IF NOT EXISTS media_usage (
  user_id TEXT PRIMARY KEY,
  used    INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  items   INTEGER NOT NULL DEFAULT 0 CHECK (items >= 0)
);
INSERT INTO media_usage (user_id, used, items)
SELECT user_id,
       COALESCE(SUM(size), 0),
       COUNT(*)
FROM media
WHERE true
GROUP BY user_id
ON CONFLICT(user_id) DO UPDATE SET used = excluded.used, items = excluded.items;

CREATE TABLE IF NOT EXISTS media_global_usage (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  used  INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  items INTEGER NOT NULL DEFAULT 0 CHECK (items >= 0)
);
INSERT INTO media_global_usage (id, used, items)
SELECT 1,
       COALESCE(SUM(size), 0),
       COUNT(*)
FROM media
WHERE true
ON CONFLICT(id) DO UPDATE SET used = excluded.used, items = excluded.items;

CREATE TABLE IF NOT EXISTS media_user_daily_usage (
  user_id TEXT PRIMARY KEY,
  day     TEXT NOT NULL,
  uploads INTEGER NOT NULL
    CONSTRAINT media_user_daily_uploads_limit CHECK (uploads BETWEEN 0 AND 250),
  bytes   INTEGER NOT NULL
    CONSTRAINT media_user_daily_bytes_limit CHECK (bytes BETWEEN 0 AND 134217728)
);
CREATE TABLE IF NOT EXISTS media_global_daily_usage (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  day     TEXT NOT NULL,
  uploads INTEGER NOT NULL
    CONSTRAINT media_global_daily_uploads_limit CHECK (uploads BETWEEN 0 AND 1000),
  bytes   INTEGER NOT NULL
    CONSTRAINT media_global_daily_bytes_limit CHECK (bytes BETWEEN 0 AND 268435456)
);
CREATE TABLE IF NOT EXISTS media_r2_user_daily_usage (
  user_id TEXT PRIMARY KEY,
  day     TEXT NOT NULL,
  class_a INTEGER NOT NULL
    CONSTRAINT media_r2_user_class_a_daily_limit CHECK (class_a BETWEEN 0 AND 500),
  class_b INTEGER NOT NULL
    CONSTRAINT media_r2_user_class_b_daily_limit CHECK (class_b BETWEEN 0 AND 10000)
);
CREATE TABLE IF NOT EXISTS media_r2_global_daily_usage (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  day     TEXT NOT NULL,
  class_a INTEGER NOT NULL
    CONSTRAINT media_r2_global_class_a_daily_limit CHECK (class_a BETWEEN 0 AND 2000),
  class_b INTEGER NOT NULL
    CONSTRAINT media_r2_global_class_b_daily_limit CHECK (class_b BETWEEN 0 AND 100000)
);
CREATE TABLE IF NOT EXISTS media_gc_user_daily_usage (
  user_id TEXT PRIMARY KEY,
  day     TEXT NOT NULL,
  units   INTEGER NOT NULL
    CONSTRAINT media_gc_user_daily_limit CHECK (units BETWEEN 0 AND 2000)
);
CREATE TABLE IF NOT EXISTS media_gc_global_daily_usage (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  day   TEXT NOT NULL,
  units INTEGER NOT NULL
    CONSTRAINT media_gc_global_daily_limit CHECK (units BETWEEN 0 AND 4000)
);

CREATE TRIGGER IF NOT EXISTS trg_media_insert_usage
AFTER INSERT ON media
BEGIN
  INSERT INTO media_usage (user_id, used, items)
  VALUES (NEW.user_id, COALESCE(NEW.size, 0), 1)
  ON CONFLICT(user_id) DO UPDATE SET
    used = media_usage.used + excluded.used,
    items = media_usage.items + 1;
  INSERT INTO media_global_usage (id, used, items)
  VALUES (1, COALESCE(NEW.size, 0), 1)
  ON CONFLICT(id) DO UPDATE SET
    used = media_global_usage.used + excluded.used,
    items = media_global_usage.items + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_media_delete_usage
AFTER DELETE ON media
BEGIN
  UPDATE media_usage
     SET used = MAX(0, used - COALESCE(OLD.size, 0)),
         items = MAX(0, items - 1)
   WHERE user_id = OLD.user_id;
  UPDATE media_global_usage
     SET used = MAX(0, used - COALESCE(OLD.size, 0)),
         items = MAX(0, items - 1)
   WHERE id = 1;
END;

CREATE TABLE IF NOT EXISTS media_gc_runs (
  user_id     TEXT PRIMARY KEY,
  last_run_at INTEGER NOT NULL,
  phase       TEXT NOT NULL DEFAULT 'idle' CHECK (phase IN ('idle', 'scan', 'sweep', 'cleanup')),
  note_cursor TEXT NOT NULL DEFAULT '',
  media_cursor TEXT NOT NULL DEFAULT '',
  snapshot_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS media_gc_references (
  user_id TEXT NOT NULL,
  sha256  TEXT NOT NULL,
  PRIMARY KEY (user_id, sha256)
);

-- Historische `change_log`-Zeilen absichtlich NOCH NICHT löschen: Der bis zum
-- anschließenden Worker-Rollout laufende Alt-Worker kann sie noch benötigen. Nach
-- verifiziertem Deploy finalisiert 0004 den Backfill und leert nur die alten Zeilen.

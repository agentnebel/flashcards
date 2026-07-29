-- Erst NACH erfolgreichem Rollout des Workers mit gemeinsamem change_log-Allocator
-- ausführen. Ein finaler Backfill schließt in-flight Schreibvorgänge des Alt-Workers ein.
CREATE TABLE IF NOT EXISTS sync_payload_cleanup_guard (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  max_bytes INTEGER NOT NULL CHECK (max_bytes <= 262400)
);
INSERT OR REPLACE INTO sync_payload_cleanup_guard (id, max_bytes)
SELECT 1, COALESCE(MAX(LENGTH(CAST(COALESCE(payload, '') AS BLOB))), 0)
FROM sync_objects;
DROP TABLE sync_payload_cleanup_guard;

INSERT INTO sync_counters (user_id, seq)
SELECT user_id, COALESCE(MAX(seq), 0)
FROM sync_objects
WHERE true
GROUP BY user_id
ON CONFLICT(user_id) DO UPDATE SET seq = MAX(sync_counters.seq, excluded.seq);

INSERT INTO sync_object_usage (user_id, objects, bytes)
SELECT user_id,
       COUNT(*),
       SUM(LENGTH(CAST(COALESCE(payload, '') AS BLOB)) + 256)
FROM sync_objects
WHERE true
GROUP BY user_id
ON CONFLICT(user_id) DO UPDATE SET objects = excluded.objects, bytes = excluded.bytes;

INSERT INTO sync_global_storage_usage (id, bytes)
SELECT 1, COALESCE(SUM(LENGTH(CAST(COALESCE(payload, '') AS BLOB)) + 256), 0)
FROM sync_objects
WHERE true
ON CONFLICT(id) DO UPDATE SET bytes = excluded.bytes;

INSERT INTO media_usage (user_id, used, items)
SELECT user_id,
       COALESCE(SUM(size), 0),
       COUNT(*)
FROM media
WHERE true
GROUP BY user_id
ON CONFLICT(user_id) DO UPDATE SET used = excluded.used, items = excluded.items;

INSERT INTO media_global_usage (id, used, items)
SELECT 1,
       COALESCE(SUM(size), 0),
       COUNT(*)
FROM media
WHERE true
ON CONFLICT(id) DO UPDATE SET used = excluded.used, items = excluded.items;

DROP INDEX IF EXISTS idx_changelog_user_seq;
-- Nicht droppen: Auch der neue Worker nutzt AUTOINCREMENT als globalen Cursor-Allocator.
-- Historische Zeilen räumt 0005 separat und paginiert auf; dieser teurere Full-Backfill
-- wird dadurch genau einmal ausgeführt.

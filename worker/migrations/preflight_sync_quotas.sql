-- Read-only vor 0003 ausführen. Jede zurückgegebene Zeile ist ein Blocker, der
-- vor dem Wartungsfenster bewusst bereinigt oder durch angepasste Limits gelöst werden muss.
SELECT 'user_objects' AS limit_name, user_id AS scope, COUNT(*) AS actual, 50000 AS allowed
FROM sync_objects
GROUP BY user_id
HAVING COUNT(*) > 50000;

SELECT 'user_sync_bytes' AS limit_name, user_id AS scope,
       SUM(LENGTH(CAST(COALESCE(payload, '') AS BLOB)) + 256) AS actual,
       67108864 AS allowed
FROM sync_objects
GROUP BY user_id
HAVING SUM(LENGTH(CAST(COALESCE(payload, '') AS BLOB)) + 256) > 67108864;

SELECT 'global_sync_bytes' AS limit_name, 'all-users' AS scope,
       COALESCE(SUM(LENGTH(CAST(COALESCE(payload, '') AS BLOB)) + 256), 0) AS actual,
       268435456 AS allowed
FROM sync_objects
HAVING COALESCE(SUM(LENGTH(CAST(COALESCE(payload, '') AS BLOB)) + 256), 0) > 268435456;

SELECT 'single_payload_bytes' AS limit_name,
       user_id || '/' || entity || '/' || entity_id AS scope,
       LENGTH(CAST(COALESCE(payload, '') AS BLOB)) AS actual,
       262400 AS allowed
FROM sync_objects
WHERE LENGTH(CAST(COALESCE(payload, '') AS BLOB)) > 262400
LIMIT 100;

-- Blockiert 0003 nicht, weist aber auf Legacy-Konten hin, die nach dem Cutover
-- erst wieder neue Medien hochladen können, wenn sie unter 250 MiB liegen.
SELECT 'warning_legacy_media_bytes' AS limit_name, user_id AS scope,
       COALESCE(SUM(size), 0) AS actual, 262144000 AS allowed
FROM media
GROUP BY user_id
HAVING COALESCE(SUM(size), 0) > 262144000;

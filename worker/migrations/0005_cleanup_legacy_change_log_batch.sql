-- Optional nach 0004 wiederholt ausführen. Neue Zeilen werden bereits durch den
-- Kompaktierungs-Trigger entfernt; dieser kleine Batch betrifft nur den alten Feed.
DELETE FROM change_log
WHERE seq IN (SELECT seq FROM change_log ORDER BY seq LIMIT 1000);
SELECT changes() AS removed,
       EXISTS(SELECT 1 FROM change_log LIMIT 1) AS has_more;

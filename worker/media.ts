import { error, json } from 'itty-router';
import type { IRequest } from 'itty-router';
import { mediaGcAction } from '../src/lib/mediaGcPolicy';
import { readBodyBytes, readJsonBody } from './body';
import type { Env } from './index';

type AuthedRequest = IRequest & { userId: string };

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_USER_STORAGE_BYTES = 250 * 1024 * 1024;
const MAX_USER_STORAGE_ITEMS = 5_000;
const MAX_GLOBAL_STORAGE_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_GLOBAL_STORAGE_ITEMS = 20_000;
const MAX_EXISTS_HASHES = 40;
const MAX_GC_DELETIONS_PER_RUN = 20;
const MEDIA_GC_MIN_INTERVAL_MS = 12 * 60 * 60_000;
const MEDIA_GC_CONTINUATION_INTERVAL_MS = 45_000;
const D1_BATCH_SIZE = 100;
const GC_NOTE_PAGE_SIZE = 50;
const MAX_GC_NOTES_PER_RUN = 1_000;
const MAX_GC_NOTE_BYTES_PER_RUN = 16 * 1024 * 1024;
const MAX_GC_REFERENCES_PER_RUN = 900;
const GC_REFERENCE_INSERT_CHUNK = 500;
const GC_MEDIA_PAGE_SIZE = 1_000;
const GC_REFERENCE_CLEANUP_PAGE_SIZE = 900;
const GC_REQUEST_BUDGET_BLOCK = 10;
const R2_CLASS_B_BUDGET_BLOCK = 40;
const ALLOWED_MEDIA_TYPES = new Set([
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

interface MediaRow {
  sha256: string;
  r2_key: string;
  size: number | null;
  orphaned_at: number | null;
  referenced: number;
}

interface MediaGcRun {
  phase: 'idle' | 'scan' | 'sweep' | 'cleanup';
  note_cursor: string;
  media_cursor: string;
  snapshot_seq: number;
}

function decodeScanCursor(value: string): { noteId: string; hash: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return { noteId: parsed[0], hash: parsed[1] };
    }
  } catch {
    // Ein Cursor aus einer älteren Worker-Version war entweder leer oder ein Medienhash.
  }
  return null;
}

async function mediaRateLimited(
  req: AuthedRequest,
  env: Env,
  operation: 'upload' | 'get' | 'gc' | 'exists',
): Promise<Response | null> {
  // Getrennte Keys verhindern, dass große Exists-Vorabprüfungen alle Upload-Tokens
  // verbrauchen und der Client dadurch in jedem Minutenfenster ohne Fortschritt bleibt.
  const { success } = await env.MEDIA_LIMITER.limit({ key: `${operation}:${req.userId}` });
  return success ? null : error(429, 'Zu viele Medien-Anfragen. Bitte kurz warten.');
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function runBatches(env: Env, statements: D1PreparedStatement[]): Promise<void> {
  for (let index = 0; index < statements.length; index += D1_BATCH_SIZE) {
    await env.DB.batch(statements.slice(index, index + D1_BATCH_SIZE));
  }
}

function mediaHashesInPayload(payload: string | null): Set<string> {
  const hashes = new Set<string>();
  for (const match of String(payload ?? '').matchAll(/flashmedia:([a-f0-9]{64})/g)) {
    hashes.add(match[1]);
  }
  return hashes;
}

async function existingMediaHashes(
  env: Env,
  userId: string,
  hashes: Set<string>,
): Promise<Set<string>> {
  const values = [...hashes];
  const existing = new Set<string>();
  for (let index = 0; index < values.length; index += GC_REFERENCE_INSERT_CHUNK) {
    const rows = await env.DB.prepare(
      `SELECT requested.value AS sha256
         FROM json_each(?) AS requested
         JOIN media ON media.user_id = ? AND media.sha256 = requested.value`,
    )
      .bind(JSON.stringify(values.slice(index, index + GC_REFERENCE_INSERT_CHUNK)), userId)
      .all<{ sha256: string }>();
    for (const row of rows.results) existing.add(row.sha256);
  }
  return existing;
}

async function storeGcReferences(env: Env, userId: string, hashes: Set<string>): Promise<void> {
  const values = [...hashes];
  const statements: D1PreparedStatement[] = [];
  for (let index = 0; index < values.length; index += GC_REFERENCE_INSERT_CHUNK) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO media_gc_references (user_id, sha256)
         SELECT ?, value FROM json_each(?)`,
      ).bind(userId, JSON.stringify(values.slice(index, index + GC_REFERENCE_INSERT_CHUNK))),
    );
  }
  await runBatches(env, statements);
}

async function reserveGcBudget(
  env: Env,
  userId: string,
  units: number,
  now: number,
): Promise<boolean> {
  if (units <= 0) return true;
  const day = new Date(now).toISOString().slice(0, 10);
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO media_gc_user_daily_usage (user_id, day, units) VALUES (?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET
           day = excluded.day,
           units = CASE WHEN media_gc_user_daily_usage.day = excluded.day
             THEN media_gc_user_daily_usage.units + excluded.units ELSE excluded.units END`,
      ).bind(userId, day, units),
      env.DB.prepare(
        `INSERT INTO media_gc_global_daily_usage (id, day, units) VALUES (1,?,?)
         ON CONFLICT(id) DO UPDATE SET
           day = excluded.day,
           units = CASE WHEN media_gc_global_daily_usage.day = excluded.day
             THEN media_gc_global_daily_usage.units + excluded.units ELSE excluded.units END`,
      ).bind(day, units),
    ]);
    return true;
  } catch (quotaError) {
    const message = quotaError instanceof Error ? quotaError.message : String(quotaError);
    if (message.includes('constraint failed')) return false;
    throw quotaError;
  }
}

async function reserveR2Budget(
  env: Env,
  userId: string,
  classA: number,
  classB: number,
  now = Date.now(),
): Promise<boolean> {
  if (classA <= 0 && classB <= 0) return true;
  // Ein GET/HEAD-Request reserviert mindestens einen 40er-Block. Damit kann ein Angreifer
  // das globale R2-Limit nicht durch Ein-Hash-Requests in mehr D1-Counter-Writes als
  // eigentliche R2-Operationen umwandeln.
  const budgetedClassB = classB > 0 ? Math.max(R2_CLASS_B_BUDGET_BLOCK, classB) : 0;
  const day = new Date(now).toISOString().slice(0, 10);
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO media_r2_user_daily_usage (user_id, day, class_a, class_b)
         VALUES (?,?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET
           day = excluded.day,
           class_a = CASE WHEN media_r2_user_daily_usage.day = excluded.day
             THEN media_r2_user_daily_usage.class_a + excluded.class_a ELSE excluded.class_a END,
           class_b = CASE WHEN media_r2_user_daily_usage.day = excluded.day
             THEN media_r2_user_daily_usage.class_b + excluded.class_b ELSE excluded.class_b END`,
      ).bind(userId, day, classA, budgetedClassB),
      env.DB.prepare(
        `INSERT INTO media_r2_global_daily_usage (id, day, class_a, class_b)
         VALUES (1,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           day = excluded.day,
           class_a = CASE WHEN media_r2_global_daily_usage.day = excluded.day
             THEN media_r2_global_daily_usage.class_a + excluded.class_a ELSE excluded.class_a END,
           class_b = CASE WHEN media_r2_global_daily_usage.day = excluded.day
             THEN media_r2_global_daily_usage.class_b + excluded.class_b ELSE excluded.class_b END`,
      ).bind(day, classA, budgetedClassB),
    ]);
    return true;
  } catch (quotaError) {
    const message = quotaError instanceof Error ? quotaError.message : String(quotaError);
    if (message.includes('media_r2_') && message.includes('_daily_limit')) return false;
    throw quotaError;
  }
}

async function liveReferencedHashes(
  env: Env,
  userId: string,
  hashes: string[],
  afterSeq: number,
): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();
  const rows = await env.DB.prepare(
    `SELECT DISTINCT requested.value AS sha256
       FROM sync_objects AS note
       CROSS JOIN json_each(?) AS requested
      WHERE note.user_id = ?
        AND note.entity = 'note'
        AND note.deleted = 0
        AND note.seq > ?
        AND INSTR(note.payload, 'flashmedia:' || requested.value) > 0`,
  )
    .bind(JSON.stringify(hashes), userId, afterSeq)
    .all<{ sha256: string }>();
  return new Set(rows.results.map((row) => row.sha256));
}

function mediaInsertStatement(
  env: Env,
  values: {
    id: string;
    userId: string;
    hash: string;
    mime: string;
    size: number;
    key: string;
    createdAt: number;
  },
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO media (id, user_id, sha256, mime, size, r2_key, created_at, orphaned_at)
     SELECT ?,?,?,?,?,?,?,NULL
      WHERE COALESCE((SELECT used FROM media_usage WHERE user_id = ?), 0) + ? <= ?
        AND COALESCE((SELECT items FROM media_usage WHERE user_id = ?), 0) + 1 <= ?
        AND COALESCE((SELECT used FROM media_global_usage WHERE id = 1), 0) + ? <= ?
        AND COALESCE((SELECT items FROM media_global_usage WHERE id = 1), 0) + 1 <= ?
     ON CONFLICT(user_id, sha256) DO NOTHING
     RETURNING sha256`,
  ).bind(
    values.id,
    values.userId,
    values.hash,
    values.mime,
    values.size,
    values.key,
    values.createdAt,
    values.userId,
    values.size,
    MAX_USER_STORAGE_BYTES,
    values.userId,
    MAX_USER_STORAGE_ITEMS,
    values.size,
    MAX_GLOBAL_STORAGE_BYTES,
    MAX_GLOBAL_STORAGE_ITEMS,
  );
}

function dailyMediaLimitConstraint(errorValue: unknown): boolean {
  const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
  return message.includes('media_user_daily_uploads_limit') ||
    message.includes('media_user_daily_bytes_limit') ||
    message.includes('media_global_daily_uploads_limit') ||
    message.includes('media_global_daily_bytes_limit') ||
    message.includes('uploads BETWEEN') ||
    message.includes('bytes BETWEEN');
}

async function mediaCapacityResponse(
  env: Env,
  userId: string,
  incomingBytes: number,
): Promise<Response> {
  const usage = await env.DB.prepare(
    `SELECT
       COALESCE((SELECT used FROM media_usage WHERE user_id = ?), 0) AS user_used,
       COALESCE((SELECT items FROM media_usage WHERE user_id = ?), 0) AS user_items,
       COALESCE((SELECT used FROM media_global_usage WHERE id = 1), 0) AS global_used,
       COALESCE((SELECT items FROM media_global_usage WHERE id = 1), 0) AS global_items`,
  )
    .bind(userId, userId)
    .first<{
      user_used: number;
      user_items: number;
      global_used: number;
      global_items: number;
    }>();
  if (
    Number(usage?.user_used ?? 0) + incomingBytes > MAX_USER_STORAGE_BYTES ||
    Number(usage?.user_items ?? 0) + 1 > MAX_USER_STORAGE_ITEMS
  ) {
    return error(
      413,
      `Speicherlimit erreicht (${MAX_USER_STORAGE_BYTES / 1024 / 1024} MiB bzw. ` +
        `${MAX_USER_STORAGE_ITEMS.toLocaleString('de-DE')} Bilder pro Konto)`,
    );
  }
  return error(503, 'Der gemeinsame Medienspeicher ist vorübergehend ausgelastet.');
}

function mediaDeletionInProgressResponse(): Response {
  return json(
    {
      error: 'Die Mediendatei wird gerade bereinigt. Bitte den Upload kurz erneut versuchen.',
      code: 'MEDIA_DELETE_IN_PROGRESS',
    },
    { status: 409, headers: { 'Retry-After': '2' } },
  );
}

// Content-addressed Medien: Upload speichert unter {userId}/{sha256} in R2 + Metazeile in D1.
export async function handleMediaUpload(req: AuthedRequest, env: Env): Promise<Response> {
  if (!env.MEDIA) return json({ error: 'R2 storage not enabled' }, { status: 503 });
  const limited = await mediaRateLimited(req, env, 'upload');
  if (limited) return limited;

  const mime = (req.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
  if (!ALLOWED_MEDIA_TYPES.has(mime)) return error(415, 'Nur unterstützte Rasterbilder erlaubt (kein SVG)');

  const body = await readBodyBytes(req, MAX_UPLOAD_BYTES);
  if (!body.ok) return error(413, 'Datei zu groß (max 15 MB)');
  const buf = body.value;
  if (buf.byteLength === 0) return error(400, 'Leerer Upload');

  const hash = await sha256Hex(buf.buffer);
  const key = `${req.userId}/${hash}`;
  const existing = await env.DB.prepare(
    'SELECT r2_key, orphaned_at FROM media WHERE user_id = ? AND sha256 = ?',
  )
    .bind(req.userId, hash)
    .first<{ r2_key: string; orphaned_at: number | null }>();
  if (existing) {
    if (existing.orphaned_at !== null && existing.orphaned_at < 0) {
      return mediaDeletionInProgressResponse();
    }
    // Nur eine noch nicht vom GC beanspruchte Zeile retten. Das bedingte Update bildet
    // mit dem negativen GC-Claim eine D1-seitig atomare Übergabe zwischen Upload und Delete.
    const rescued = await env.DB.prepare(
      `UPDATE media SET orphaned_at = NULL
        WHERE user_id = ? AND sha256 = ?
          AND (orphaned_at IS NULL OR orphaned_at >= 0)
        RETURNING sha256`,
    )
      .bind(req.userId, hash)
      .first<{ sha256: string }>();
    if (!rescued) {
      const inserted = await mediaInsertStatement(env, {
        id: crypto.randomUUID(),
        userId: req.userId,
        hash,
        mime,
        size: buf.byteLength,
        key,
        createdAt: Date.now(),
      }).first<{ sha256: string }>();
      if (!inserted) {
        const concurrent = await env.DB.prepare(
          'SELECT sha256, orphaned_at FROM media WHERE user_id = ? AND sha256 = ?',
        )
          .bind(req.userId, hash)
          .first<{ sha256: string; orphaned_at: number | null }>();
        if (!concurrent) {
          return mediaCapacityResponse(env, req.userId, buf.byteLength);
        }
        if (concurrent.orphaned_at !== null && concurrent.orphaned_at < 0) {
          return mediaDeletionInProgressResponse();
        }
      }
    }
    // Eine alte D1-Zeile ohne R2-Bytes wird selbstheilend repariert, ohne das Quota
    // ein zweites Mal zu reservieren.
    if (!(await reserveR2Budget(env, req.userId, 0, 1))) {
      return error(429, 'Tägliches Medien-Abruflimit erreicht. Bitte morgen erneut versuchen.');
    }
    if (!(await env.MEDIA.head(key))) {
      if (!(await reserveR2Budget(env, req.userId, 1, 0))) {
        return error(429, 'Tägliches Medien-Uploadlimit erreicht. Bitte morgen erneut versuchen.');
      }
      await env.MEDIA.put(key, buf, { httpMetadata: { contentType: mime } });
    }
    return json({ hash, size: buf.byteLength, mime });
  }

  let inserted = false;
  try {
    // Metadaten zuerst: Das bedingte INSERT prüft User- und Globalquota atomar. Bei einem
    // R2-Fehler bleibt die Reservierung bestehen: Der Client hält den Blob pending und
    // der nächste Upload repariert die fehlenden Bytes über den Existing-Pfad. Ein Löschen
    // hier wäre bei identischen Parallel-Uploads falsch, weil ein zweiter Request denselben
    // content-addressierten R2-Key bereits erfolgreich geschrieben haben kann.
    const day = new Date().toISOString().slice(0, 10);
    const results = await env.DB.batch([
      mediaInsertStatement(env, {
        id: crypto.randomUUID(),
        userId: req.userId,
        hash,
        mime,
        size: buf.byteLength,
        key,
        createdAt: Date.now(),
      }),
      env.DB.prepare(
        `INSERT INTO media_user_daily_usage (user_id, day, uploads, bytes)
         SELECT ?,?,1,? WHERE changes() > 0
         ON CONFLICT(user_id) DO UPDATE SET
           day = excluded.day,
           uploads = CASE WHEN media_user_daily_usage.day = excluded.day
             THEN media_user_daily_usage.uploads + 1 ELSE 1 END,
           bytes = CASE WHEN media_user_daily_usage.day = excluded.day
             THEN media_user_daily_usage.bytes + excluded.bytes ELSE excluded.bytes END`,
      ).bind(req.userId, day, buf.byteLength),
      env.DB.prepare(
        `INSERT INTO media_global_daily_usage (id, day, uploads, bytes)
         SELECT 1,?,1,? WHERE changes() > 0
         ON CONFLICT(id) DO UPDATE SET
           day = excluded.day,
           uploads = CASE WHEN media_global_daily_usage.day = excluded.day
             THEN media_global_daily_usage.uploads + 1 ELSE 1 END,
           bytes = CASE WHEN media_global_daily_usage.day = excluded.day
             THEN media_global_daily_usage.bytes + excluded.bytes ELSE excluded.bytes END`,
      ).bind(day, buf.byteLength),
    ]);
    inserted = Boolean((results[0]?.results?.[0] as { sha256?: string } | undefined)?.sha256);
  } catch (quotaError) {
    if (dailyMediaLimitConstraint(quotaError)) {
      return error(429, 'Tägliches Medienlimit erreicht. Bitte morgen erneut versuchen.');
    }
    throw quotaError;
  }

  if (!inserted) {
    // Ein identischer Parallel-Upload gewinnt den UNIQUE-Konflikt. Nur wenn auch danach
    // keine Metazeile existiert, war eine der atomaren Speichergrenzen erreicht.
    const concurrent = await env.DB.prepare(
      'SELECT sha256, orphaned_at FROM media WHERE user_id = ? AND sha256 = ?',
    )
      .bind(req.userId, hash)
      .first<{ sha256: string; orphaned_at: number | null }>();
    if (!concurrent) {
      return mediaCapacityResponse(env, req.userId, buf.byteLength);
    }
    if (concurrent.orphaned_at !== null && concurrent.orphaned_at < 0) {
      return mediaDeletionInProgressResponse();
    }
  }

  if (!(await reserveR2Budget(env, req.userId, 1, 0))) {
    return error(429, 'Tägliches Medien-Uploadlimit erreicht. Bitte morgen erneut versuchen.');
  }
  // Auch der Verlierer eines identischen Parallel-Uploads darf dieselben Bytes schreiben;
  // der content-addressierte Key ist identisch, die Quota wurde aber nur einmal gebucht.
  await env.MEDIA.put(key, buf, { httpMetadata: { contentType: mime } });

  return json({ hash, size: buf.byteLength, mime });
}

export async function handleMediaGet(req: AuthedRequest, env: Env): Promise<Response> {
  if (!env.MEDIA) return json({ error: 'R2 storage not enabled' }, { status: 503 });
  const limited = await mediaRateLimited(req, env, 'get');
  if (limited) return limited;

  const hash = req.params?.hash;
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) return error(400, 'Ungültiger Hash');
  if (!(await reserveR2Budget(env, req.userId, 0, 1))) {
    return error(429, 'Tägliches Medien-Abruflimit erreicht. Bitte morgen erneut versuchen.');
  }
  const obj = await env.MEDIA.get(`${req.userId}/${hash}`);
  if (!obj) return error(404, 'Nicht gefunden');
  const stored = (obj.httpMetadata?.contentType || '').toLowerCase();
  const contentType = ALLOWED_MEDIA_TYPES.has(stored) ? stored : 'application/octet-stream';
  return new Response(obj.body, {
    headers: {
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
      // Die URL enthält absichtlich keine User-ID. Authentifizierte Medien deshalb nicht
      // im privaten Browser-Cache halten: Nach einem Kontowechsel könnte derselbe URL-Key
      // sonst Bytes des vorherigen Kontos liefern, ohne den Worker erneut zu autorisieren.
      'Cache-Control': 'private, no-store',
    },
  });
}

// Referenzbasierte Bereinigung mit 30 Tagen Quarantäne. Ein Offline-Gerät kann dadurch
// einen alten Verweis synchronisieren; die Client-Revalidierung lädt fehlende Bytes notfalls neu.
export async function handleMediaGc(req: AuthedRequest, env: Env): Promise<Response> {
  if (!env.MEDIA) return json({ error: 'R2 storage not enabled' }, { status: 503 });
  const limited = await mediaRateLimited(req, env, 'gc');
  if (limited) return limited;
  const now = Date.now();
  // Auch gesperrte, zu frühe und inhaltsleere Läufe kosten vor der ersten GC-Abfrage
  // einen festen Block. So kann der öffentliche Endpunkt D1 nicht über No-op-Requests
  // leer lesen, ohne das globale Tagesbudget zu verbrauchen.
  if (!(await reserveGcBudget(env, req.userId, GC_REQUEST_BUDGET_BLOCK, now))) {
    return error(429, 'Tägliches Medien-Bereinigungslimit erreicht. Bitte morgen erneut versuchen.');
  }
  const claimed = await env.DB.prepare(
    `INSERT INTO media_gc_runs (
       user_id, last_run_at, phase, note_cursor, media_cursor, snapshot_seq
     )
     SELECT ?,?,'scan','','',COALESCE(
       (SELECT seq FROM sync_counters WHERE user_id = ?), 0
     )
     ON CONFLICT(user_id) DO UPDATE SET
       last_run_at = excluded.last_run_at,
       phase = CASE WHEN media_gc_runs.phase = 'idle' THEN 'scan' ELSE media_gc_runs.phase END,
       note_cursor = CASE WHEN media_gc_runs.phase = 'idle' THEN '' ELSE media_gc_runs.note_cursor END,
       media_cursor = CASE WHEN media_gc_runs.phase = 'idle' THEN '' ELSE media_gc_runs.media_cursor END,
       snapshot_seq = CASE WHEN media_gc_runs.phase = 'idle'
         THEN excluded.snapshot_seq ELSE media_gc_runs.snapshot_seq END
       WHERE (
         media_gc_runs.phase = 'idle'
         AND media_gc_runs.last_run_at <= ?
       ) OR (
         media_gc_runs.phase <> 'idle'
         AND media_gc_runs.last_run_at <= ?
       )
     RETURNING phase, note_cursor, media_cursor, snapshot_seq`,
  )
    .bind(
      req.userId,
      now,
      req.userId,
      now - MEDIA_GC_MIN_INTERVAL_MS,
      now - MEDIA_GC_CONTINUATION_INTERVAL_MS,
    )
    .first<MediaGcRun>();
  if (!claimed) {
    const current = await env.DB.prepare(
      'SELECT phase, note_cursor, media_cursor, snapshot_seq FROM media_gc_runs WHERE user_id = ?',
    )
      .bind(req.userId)
      .first<MediaGcRun>();
    return json({
      phase: current?.phase ?? 'idle',
      complete: current?.phase === 'idle',
      deleted: 0,
      marked: 0,
      rescued: 0,
      remaining: 0,
      skipped: true,
    });
  }

  if (claimed.phase === 'cleanup') {
    const references = await env.DB.prepare(
      `SELECT sha256
         FROM media_gc_references
        WHERE user_id = ? AND sha256 > ?
        ORDER BY sha256 ASC
        LIMIT ?`,
    )
      .bind(req.userId, claimed.media_cursor, GC_REFERENCE_CLEANUP_PAGE_SIZE)
      .all<{ sha256: string }>();
    const lastHash = references.results[references.results.length - 1]?.sha256;
    if (lastHash) {
      if (!(await reserveGcBudget(env, req.userId, references.results.length * 2, now))) {
        return json({
          phase: 'cleanup',
          complete: false,
          deferred: true,
          cleaned: 0,
          deleted: 0,
          marked: 0,
          rescued: 0,
          remaining: references.results.length,
        });
      }
      await env.DB.prepare(
        'DELETE FROM media_gc_references WHERE user_id = ? AND sha256 > ? AND sha256 <= ?',
      )
        .bind(req.userId, claimed.media_cursor, lastHash)
        .run();
    }
    const complete = references.results.length < GC_REFERENCE_CLEANUP_PAGE_SIZE;
    if (complete) {
      await env.DB.prepare(
        "UPDATE media_gc_runs SET phase = 'idle', note_cursor = '', media_cursor = '' WHERE user_id = ?",
      )
        .bind(req.userId)
        .run();
    } else {
      await env.DB.prepare('UPDATE media_gc_runs SET media_cursor = ? WHERE user_id = ?')
        .bind(lastHash!, req.userId)
        .run();
    }
    return json({
      phase: 'cleanup',
      complete,
      cleaned: references.results.length,
      deleted: 0,
      marked: 0,
      rescued: 0,
      remaining: 0,
    });
  }

  if (claimed.phase === 'scan') {
    let cursor = claimed.note_cursor;
    const resume = decodeScanCursor(claimed.media_cursor);
    let nextScanCursor = '';
    let scanned = 0;
    let scannedBytes = 0;
    const references = new Set<string>();
    let complete = false;
    let partialNote = false;

    scanPages:
    while (scanned < MAX_GC_NOTES_PER_RUN && scannedBytes < MAX_GC_NOTE_BYTES_PER_RUN) {
      const page = await env.DB.prepare(
        `SELECT entity_id, payload, deleted
           FROM sync_objects
          WHERE user_id = ? AND entity = 'note' AND seq <= ? AND entity_id > ?
          ORDER BY entity_id ASC
          LIMIT ?`,
      )
        .bind(req.userId, claimed.snapshot_seq, cursor, GC_NOTE_PAGE_SIZE)
        .all<{ entity_id: string; payload: string | null; deleted: number }>();
      if (page.results.length === 0) {
        complete = true;
        break;
      }

      let consumed = 0;
      for (const row of page.results) {
        const rowBytes = new TextEncoder().encode(row.payload ?? '').byteLength;
        if (scanned > 0 && scannedBytes + rowBytes > MAX_GC_NOTE_BYTES_PER_RUN) {
          break scanPages;
        }
        scannedBytes += rowBytes;

        const resumeHash = resume?.noteId === row.entity_id ? resume.hash : '';
        const rowHashes = row.deleted === 0
          ? [...mediaHashesInPayload(row.payload)]
            .sort()
            .filter((hash) => hash > resumeHash)
          : [];
        let processedHash = resumeHash;
        for (const hash of rowHashes) {
          if (!references.has(hash) && references.size >= MAX_GC_REFERENCES_PER_RUN) {
            // Eine einzelne gültige Sync-Payload kann mehrere tausend Media-Hashes
            // enthalten. Den Notizinhalt deshalb innerhalb derselben Note fortsetzbar
            // paginieren, statt den GC dauerhaft am Tagesbudget festzufahren.
            nextScanCursor = JSON.stringify([row.entity_id, processedHash]);
            partialNote = true;
            break;
          }
          references.add(hash);
          processedHash = hash;
        }
        if (partialNote) break scanPages;

        scanned += 1;
        consumed += 1;
        cursor = row.entity_id;
        nextScanCursor = '';
        if (scanned >= MAX_GC_NOTES_PER_RUN) break;
      }

      if (consumed < page.results.length) break;
      if (page.results.length < GC_NOTE_PAGE_SIZE) {
        complete = true;
        break;
      }
    }

    // Fake-Hashes aus Payloads dürfen keine D1-Snapshotzeilen erzeugen. Nur tatsächlich
    // vorhandene Medien referenzieren und deren Writes gegen das tägliche GC-Budget buchen.
    const existingReferences = await existingMediaHashes(env, req.userId, references);
    if (!(await reserveGcBudget(env, req.userId, existingReferences.size * 2, now))) {
      return json({
        phase: 'scan',
        complete: false,
        deferred: true,
        scanned: 0,
        references: 0,
        readyToSweep: false,
        deleted: 0,
        marked: 0,
        rescued: 0,
        remaining: 0,
      });
    }
    await storeGcReferences(env, req.userId, existingReferences);
    if (complete) {
      await env.DB.prepare(
        "UPDATE media_gc_runs SET phase = 'sweep', note_cursor = '', media_cursor = '' WHERE user_id = ?",
      )
        .bind(req.userId)
        .run();
    } else {
      await env.DB.prepare(
        'UPDATE media_gc_runs SET note_cursor = ?, media_cursor = ? WHERE user_id = ?',
      )
        .bind(cursor, nextScanCursor, req.userId)
        .run();
    }
    return json({
      phase: 'scan',
      complete: false,
      scanned,
      references: existingReferences.size,
      readyToSweep: complete,
      deleted: 0,
      marked: 0,
      rescued: 0,
      remaining: 0,
    });
  }

  const rows = await env.DB.prepare(
    `SELECT media.sha256, media.r2_key, media.size, media.orphaned_at,
            CASE WHEN refs.sha256 IS NULL THEN 0 ELSE 1 END AS referenced
       FROM media
       LEFT JOIN media_gc_references AS refs
         ON refs.user_id = media.user_id AND refs.sha256 = media.sha256
      WHERE media.user_id = ? AND media.sha256 > ?
      ORDER BY media.sha256 ASC
      LIMIT ?`,
  )
    .bind(req.userId, claimed.media_cursor, GC_MEDIA_PAGE_SIZE)
    .all<MediaRow>();
  const referenced = new Set(
    rows.results.filter((row) => row.referenced === 1).map((row) => row.sha256),
  );
  const statements: D1PreparedStatement[] = [];
  const deletable: MediaRow[] = [];
  let marked = 0;
  let rescued = 0;

  for (const row of rows.results) {
    const action = mediaGcAction(
      { sha256: row.sha256, orphanedAt: row.orphaned_at },
      referenced,
      now,
    );
    if (action === 'mark') {
      marked += 1;
      statements.push(
        env.DB.prepare(
          'UPDATE media SET orphaned_at = ? WHERE user_id = ? AND sha256 = ? AND orphaned_at IS NULL',
        ).bind(now, req.userId, row.sha256),
      );
    } else if (action === 'rescue') {
      rescued += 1;
      statements.push(
        env.DB.prepare('UPDATE media SET orphaned_at = NULL WHERE user_id = ? AND sha256 = ?')
          .bind(req.userId, row.sha256),
      );
    } else if (action === 'delete') {
      deletable.push(row);
    }
  }

  const candidates = deletable.slice(0, MAX_GC_DELETIONS_PER_RUN);
  // Snapshot-Refs können bei parallel neu hinzugefügten Notizverweisen konservativ veraltet
  // sein. Direkt vor der irreversiblen R2-Löschung deshalb höchstens 20 Kandidaten live prüfen.
  const liveReferenced = await liveReferencedHashes(
    env,
    req.userId,
    candidates.map((row) => row.sha256),
    claimed.snapshot_seq,
  );
  const deletionCandidates = candidates.filter((row) => !liveReferenced.has(row.sha256));
  for (const row of candidates) {
    if (liveReferenced.has(row.sha256)) {
      rescued += 1;
      statements.push(
        env.DB.prepare('UPDATE media SET orphaned_at = NULL WHERE user_id = ? AND sha256 = ?')
          .bind(req.userId, row.sha256),
      );
    }
  }
  // DELETE media ändert Tabelle + PK/UNIQUE-Indizes und beide Usage-Zeilen. Referenz-
  // Inserts/-Deletes kosten wegen ihres zusammengesetzten Primärschlüssels je zwei Writes.
  const gcMutationUnits = statements.length + deletionCandidates.length * 6;
  if (!(await reserveGcBudget(env, req.userId, gcMutationUnits, now))) {
    return json({
      phase: 'sweep',
      complete: false,
      deferred: true,
      deleted: 0,
      marked: 0,
      rescued: 0,
      remaining: deletable.length,
    });
  }
  await runBatches(env, statements);

  // Vor dem R2-Delete beansprucht der GC jede Zeile mit einem negativen Zeitstempel.
  // Uploads können danach nicht mehr "retten", sondern erhalten 409 und versuchen es
  // nach Abschluss erneut. Gewinnt der Upload zuerst, schlägt das bedingte Claim fehl.
  const deleteClaim = -Math.max(1, now);
  const claimResults = deletionCandidates.length > 0
    ? await env.DB.batch(deletionCandidates.map((row) =>
      env.DB.prepare(
        `UPDATE media SET orphaned_at = ?
          WHERE user_id = ? AND sha256 = ? AND orphaned_at = ?
            AND NOT EXISTS (
              SELECT 1 FROM sync_objects AS note
               WHERE note.user_id = ?
                 AND note.entity = 'note'
                 AND note.deleted = 0
                 AND note.seq > ?
                 AND INSTR(note.payload, 'flashmedia:' || ?) > 0
            )
          RETURNING sha256`,
      ).bind(
        deleteClaim,
        req.userId,
        row.sha256,
        row.orphaned_at,
        req.userId,
        claimed.snapshot_seq,
        row.sha256,
      )))
    : [];
  const claimedHashes = new Set(
    claimResults.flatMap((result) =>
      (result.results as Array<{ sha256?: string }> | undefined) ?? [])
      .map((row) => row.sha256)
      .filter((hash): hash is string => typeof hash === 'string'),
  );
  const deleting = deletionCandidates.filter((row) => claimedHashes.has(row.sha256));
  rescued += deletionCandidates.length - deleting.length;

  await Promise.all(deleting.map((row) => env.MEDIA!.delete(row.r2_key)));
  if (deleting.length > 0) {
    await env.DB.batch(deleting.map((row) =>
      env.DB.prepare(
        'DELETE FROM media WHERE user_id = ? AND sha256 = ? AND orphaned_at = ?',
      )
        .bind(req.userId, row.sha256, deleteClaim)));
  }

  const hasUnprocessedDeletions = deletable.length > candidates.length;
  const pageComplete = rows.results.length < GC_MEDIA_PAGE_SIZE && !hasUnprocessedDeletions;
  if (pageComplete) {
    // Der Referenz-Snapshot kann zehntausende Zeilen enthalten. Nicht in einem einzigen
    // DELETE abbauen: D1 zählt jede betroffene Zeile als Write. Eine eigene Cleanup-Phase
    // entfernt deshalb höchstens 1.000 Referenzen pro Folgeaufruf.
    await env.DB.prepare(
      "UPDATE media_gc_runs SET phase = 'cleanup', note_cursor = '', media_cursor = '' WHERE user_id = ?",
    )
      .bind(req.userId)
      .run();
  } else {
    const nextCursor = hasUnprocessedDeletions
      ? candidates[candidates.length - 1]?.sha256 ?? claimed.media_cursor
      : rows.results[rows.results.length - 1]?.sha256 ?? claimed.media_cursor;
    await env.DB.prepare('UPDATE media_gc_runs SET media_cursor = ? WHERE user_id = ?')
      .bind(nextCursor, req.userId)
      .run();
  }

  return json({
    phase: 'sweep',
    complete: false,
    readyToCleanup: pageComplete,
    deleted: deleting.length,
    marked,
    rescued,
    remaining: Math.max(0, deletable.length - candidates.length),
  });
}

export async function handleMediaExists(req: AuthedRequest, env: Env): Promise<Response> {
  const limited = await mediaRateLimited(req, env, 'exists');
  if (limited) return limited;
  const parsed = await readJsonBody<{ hashes?: unknown }>(req, 4 * 1024);
  if (!parsed.ok) {
    return error(parsed.reason === 'too-large' ? 413 : 400, 'Ungültige Exists-Anfrage');
  }
  const hashes = Array.isArray(parsed.value.hashes)
    ? parsed.value.hashes.filter((hash): hash is string => typeof hash === 'string')
    : [];
  if (hashes.length > MAX_EXISTS_HASHES) return error(413, `Zu viele Hashes (max ${MAX_EXISTS_HASHES})`);

  const unique = [...new Set(hashes.filter((hash) => /^[a-f0-9]{64}$/.test(hash)))];
  if (unique.length === 0 || !env.MEDIA) return json({ have: [], missing: unique });

  if (!(await reserveR2Budget(env, req.userId, 0, unique.length))) {
    return error(429, 'Tägliches Medien-Abruflimit erreicht. Bitte morgen erneut versuchen.');
  }
  const heads = await Promise.all(unique.map((hash) => env.MEDIA!.head(`${req.userId}/${hash}`)));
  const have = unique.filter((_, index) => heads[index] !== null);
  const missing = unique.filter((_, index) => heads[index] === null);

  return json({ have, missing });
}

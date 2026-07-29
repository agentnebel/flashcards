import { error, json } from 'itty-router';
import type { IRequest } from 'itty-router';
import {
  MAX_SYNC_REQUEST_BYTES,
  isSafeSyncPayload,
  type SyncMutation,
  validateSyncMutations,
} from '../src/lib/syncProtocol';
import { readBodyBytes, readJsonBody } from './body';
import type { Env } from './index';

type AuthedRequest = IRequest & { userId: string };

const MAX_SYNC_OBJECTS_PER_USER = 50_000;
const MAX_SYNC_STORAGE_BYTES_PER_USER = 64 * 1024 * 1024;
const MAX_PULL_QUERY_ROWS = 64;
const MAX_PULL_RESPONSE_BYTES = 2 * 1024 * 1024;
const PULL_REQUEST_BUDGET_BLOCK = 4;
const pullEncoder = new TextEncoder();

async function syncRateLimited(
  env: Env,
  userId: string,
  operation: 'pull' | 'push',
): Promise<Response | null> {
  const { success } = await env.SYNC_LIMITER.limit({ key: `${operation}:${userId}` });
  return success ? null : error(429, 'Zu viele Sync-Anfragen. Bitte kurz warten.');
}

function isQuotaConstraint(errorValue: unknown): boolean {
  const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
  return message.includes('CHECK constraint failed') || message.includes('constraint failed');
}

function isObjectLimitConstraint(errorValue: unknown): boolean {
  const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
  return message.includes('sync_user_objects_limit') ||
    message.includes('objects BETWEEN 0 AND 50000');
}

function isUserStorageLimitConstraint(errorValue: unknown): boolean {
  const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
  return message.includes('sync_user_storage_bytes_limit') ||
    message.includes('bytes BETWEEN 0 AND 67108864');
}

function isGlobalStorageLimitConstraint(errorValue: unknown): boolean {
  const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
  return message.includes('sync_global_storage_bytes_limit') ||
    message.includes('bytes BETWEEN 0 AND 268435456');
}

function isPayloadLimitConstraint(errorValue: unknown): boolean {
  const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
  return message.includes('sync_payload_too_large');
}

async function reservePullBudget(env: Env, userId: string, units: number, now: number): Promise<boolean> {
  const day = new Date(now).toISOString().slice(0, 10);
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sync_user_daily_pull_usage (user_id, day, units) VALUES (?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET
           day = excluded.day,
           units = CASE
             WHEN sync_user_daily_pull_usage.day = excluded.day
             THEN sync_user_daily_pull_usage.units + excluded.units
             ELSE excluded.units
           END`,
      ).bind(userId, day, units),
      env.DB.prepare(
        `INSERT INTO sync_global_daily_pull_usage (id, day, units) VALUES (1,?,?)
         ON CONFLICT(id) DO UPDATE SET
           day = excluded.day,
           units = CASE
             WHEN sync_global_daily_pull_usage.day = excluded.day
             THEN sync_global_daily_pull_usage.units + excluded.units
             ELSE excluded.units
           END`,
      ).bind(day, units),
    ]);
    return true;
  } catch (quotaError) {
    if (isQuotaConstraint(quotaError)) return false;
    throw quotaError;
  }
}

async function readPushMutations(req: AuthedRequest): Promise<
  | { ok: true; mutations: SyncMutation[] }
  | { ok: false; response: Response }
> {
  const bodyBytes = await readBodyBytes(req, MAX_SYNC_REQUEST_BYTES);
  if (!bodyBytes.ok) {
    return { ok: false, response: error(413, 'Sync-Anfrage ist zu groß') };
  }

  let body: unknown;
  try {
    body = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bodyBytes.value),
    );
  } catch {
    return { ok: false, response: error(400, 'Ungültiges JSON') };
  }
  const mutationsValue =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>).mutations
      : undefined;
  const validated = validateSyncMutations(mutationsValue);
  if (!validated.ok) {
    return { ok: false, response: error(validated.status, validated.message) };
  }
  return { ok: true, mutations: validated.mutations };
}

function mutationUpdatedAt(mutation: SyncMutation, now: number): number {
  const payloadUpdatedAt = mutation.payload?.updatedAt;
  const raw =
    typeof payloadUpdatedAt === 'number' && Number.isFinite(payloadUpdatedAt)
      ? payloadUpdatedAt
      : mutation.createdAt ?? now;
  // Nie einen Wert in der Zukunft persistieren: Nach dem bestätigenden Pull übernimmt
  // der Client diesen Serverwert. Eine direkt folgende lokale Änderung mit Date.now()
  // ist dadurch mindestens gleich neu und kann nicht minutenlang als "älter" verloren gehen.
  return Math.min(raw, now);
}

export async function handlePush(req: AuthedRequest, env: Env): Promise<Response> {
  const limited = await syncRateLimited(env, req.userId, 'push');
  if (limited) return limited;

  const parsed = await readPushMutations(req);
  if (!parsed.ok) return parsed.response;
  const { mutations } = parsed;
  if (mutations.length === 0) return json({ cursor: 0, applied: 0 });

  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const normalizedMutations = mutations.map((mutation) => {
    const updatedAt = mutationUpdatedAt(mutation, now);
    return {
      mutation,
      updatedAt,
      // Der Konfliktwert und der an Clients verteilte Payload-Zeitstempel müssen identisch
      // sein. Sonst bleibt ein Gerät mit stark vorgehender Uhr lokal auf einem Zukunftswert
      // hängen und verwirft spätere, serverseitig bereits akzeptierte Änderungen dauerhaft.
      payload:
        mutation.op === 'upsert'
          ? { ...mutation.payload, updatedAt }
          : undefined,
    };
  });
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO sync_user_daily_usage (user_id, day, mutations) VALUES (?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET
         day = excluded.day,
         mutations = CASE
           WHEN sync_user_daily_usage.day = excluded.day
           THEN sync_user_daily_usage.mutations + excluded.mutations
           ELSE excluded.mutations
         END`,
    ).bind(req.userId, day, mutations.length),
    env.DB.prepare(
      `INSERT INTO sync_global_daily_usage (id, day, mutations) VALUES (1,?,?)
       ON CONFLICT(id) DO UPDATE SET
         day = excluded.day,
         mutations = CASE
           WHEN sync_global_daily_usage.day = excluded.day
           THEN sync_global_daily_usage.mutations + excluded.mutations
           ELSE excluded.mutations
         END`,
    ).bind(day, mutations.length),
    ...normalizedMutations.flatMap(({ mutation, payload, updatedAt }) => {
      const isDelete = mutation.op === 'delete';
      return [
        // Während des rollierenden Upgrades teilen sich alter und neuer Worker denselben
        // AUTOINCREMENT-Allocator. Ein Kompaktierungs-Trigger löscht die Feed-Zeile direkt
        // wieder; sqlite_sequence und last_insert_rowid() bleiben monoton erhalten.
        env.DB.prepare(
          `INSERT INTO change_log (user_id, entity, entity_id, op, changed_at)
           VALUES (?,?,?,?,?) RETURNING seq`,
        ).bind(req.userId, mutation.entity, mutation.entityId, mutation.op, now),
        env.DB.prepare(
          `INSERT INTO sync_objects (user_id, entity, entity_id, payload, deleted, seq, updated_at)
           VALUES (?,?,?,?,?,last_insert_rowid(),?)
           ON CONFLICT(user_id, entity, entity_id) DO UPDATE SET
             payload    = CASE WHEN excluded.updated_at >= sync_objects.updated_at THEN excluded.payload ELSE sync_objects.payload END,
             deleted    = CASE WHEN excluded.updated_at >= sync_objects.updated_at THEN excluded.deleted ELSE sync_objects.deleted END,
             updated_at = MAX(excluded.updated_at, sync_objects.updated_at),
             seq        = excluded.seq`,
        ).bind(
          req.userId,
          mutation.entity,
          mutation.entityId,
          isDelete ? null : JSON.stringify(payload),
          isDelete ? 1 : 0,
          updatedAt,
        ),
      ];
    }),
  ];

  // Quota, globale Cursorvergabe und alle Objektstände bilden EINE D1-Transaktion. So kann
  // kein paralleler Pull einen höheren Cursor sehen und danach später committete niedrigere
  // Sequenzen dauerhaft überspringen.
  let results: D1Result[];
  try {
    results = await env.DB.batch(statements);
  } catch (batchError) {
    if (isObjectLimitConstraint(batchError)) {
      return json({
        error: `Sync-Objektlimit erreicht (max. ${MAX_SYNC_OBJECTS_PER_USER} pro Konto)`,
        code: 'SYNC_OBJECT_LIMIT',
      }, { status: 413 });
    }
    if (isGlobalStorageLimitConstraint(batchError)) {
      return error(503, 'Der gemeinsame Sync-Speicher ist vorübergehend ausgelastet.');
    }
    if (isUserStorageLimitConstraint(batchError)) {
      return json({
        error:
          `Sync-Speicherlimit erreicht (max. ` +
          `${MAX_SYNC_STORAGE_BYTES_PER_USER / 1024 / 1024} MiB pro Konto)`,
        code: 'SYNC_STORAGE_LIMIT',
      }, { status: 413 });
    }
    if (isPayloadLimitConstraint(batchError)) {
      return json({
        error: 'Eine Sync-Änderung überschreitet das maximale Payload-Limit.',
        code: 'SYNC_PAYLOAD_TOO_LARGE',
      }, { status: 413 });
    }
    if (isQuotaConstraint(batchError)) {
      return error(429, 'Tägliches Sync-Limit erreicht. Bitte morgen erneut versuchen.');
    }
    throw batchError;
  }
  let cursor = 0;
  for (let index = 0; index < mutations.length; index++) {
    const seq = Number(
      (results[2 + index * 2]?.results?.[0] as { seq?: number } | undefined)?.seq ?? 0,
    );
    cursor = Math.max(cursor, seq);
  }
  if (!Number.isFinite(cursor) || cursor <= 0) {
    throw new Error('Sync-Cursor konnte nicht reserviert werden');
  }

  return json({ cursor, applied: mutations.length });
}

export async function handlePull(req: AuthedRequest, env: Env): Promise<Response> {
  const limited = await syncRateLimited(env, req.userId, 'pull');
  if (limited) return limited;

  const parsed = await readJsonBody<{ cursor?: unknown }>(req, 1024);
  if (!parsed.ok) {
    return error(parsed.reason === 'too-large' ? 413 : 400, 'Ungültige Pull-Anfrage');
  }
  const body = parsed.value;
  const cursor =
    typeof body.cursor === 'number' && Number.isFinite(body.cursor)
      ? Math.max(0, Math.floor(body.cursor))
      : 0;
  const budgetNow = Date.now();
  // Jeder Pull reserviert vor der Objektabfrage einen Grundblock. Dadurch kosten auch
  // leere oder absichtlich veraltete Cursor Requests Tagesbudget; vier Units lassen
  // zugleich den normalen Minuten-Sync mit ausreichender Tagesreserve weiterlaufen.
  if (!(await reservePullBudget(env, req.userId, PULL_REQUEST_BUDGET_BLOCK, budgetNow))) {
    return error(429, 'Tägliches Download-Limit erreicht. Bitte morgen erneut versuchen.');
  }
  const pullLimit = MAX_PULL_QUERY_ROWS;
  const result = await env.DB.prepare(
    'SELECT entity, entity_id, payload, deleted, seq, updated_at FROM sync_objects WHERE user_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
  )
    // Eine zusätzliche Zeile verrät zuverlässig, ob noch Daten folgen, ohne sie bereits
    // gegen das Tagesbudget auszuliefern.
    .bind(req.userId, cursor, pullLimit + 1)
    .all<{
      entity: string;
      entity_id: string;
      payload: string | null;
      deleted: number;
      seq: number;
      updated_at: number;
    }>();

  const selectedRows: typeof result.results = [];
  let responseBytes = pullEncoder.encode('{"cursor":0,"changes":[],"hasMore":false}').byteLength;
  for (const row of result.results.slice(0, pullLimit)) {
    const changeBytes = pullEncoder.encode(JSON.stringify({
      entity: row.entity,
      entityId: row.entity_id,
      deleted: row.deleted === 1,
      payload: row.payload,
      seq: row.seq,
      updatedAt: row.updated_at,
    })).byteLength + 1;
    if (selectedRows.length > 0 && responseBytes + changeBytes > MAX_PULL_RESPONSE_BYTES) break;
    selectedRows.push(row);
    responseBytes += changeBytes;
  }
  const additionalUnits = Math.max(0, selectedRows.length - PULL_REQUEST_BUDGET_BLOCK);
  if (additionalUnits > 0) {
    if (!(await reservePullBudget(env, req.userId, additionalUnits, budgetNow))) {
      return error(429, 'Tägliches Download-Limit erreicht. Bitte morgen erneut versuchen.');
    }
  }
  const changes = [];
  for (const row of selectedRows) {
    let payload: Record<string, unknown> | null = null;
    if (row.payload !== null) {
      try {
        const parsedPayload: unknown = JSON.parse(row.payload);
        if (!isSafeSyncPayload(parsedPayload)) {
          return json({
            error: 'Ein gespeicherter Sync-Datensatz ist ungültig oder zu tief verschachtelt.',
            code: 'SYNC_STORED_PAYLOAD_INVALID',
            entity: row.entity,
            entityId: row.entity_id,
          }, { status: 422 });
        }
        payload = parsedPayload;
      } catch {
        return json({
          error: 'Ein gespeicherter Sync-Datensatz enthält ungültiges JSON.',
          code: 'SYNC_STORED_PAYLOAD_INVALID',
          entity: row.entity,
          entityId: row.entity_id,
        }, { status: 422 });
      }
    }
    changes.push({
      entity: row.entity,
      entityId: row.entity_id,
      deleted: row.deleted === 1,
      payload,
      seq: row.seq,
      updatedAt: row.updated_at,
    });
  }
  const newCursor = changes.reduce((maximum, change) => Math.max(maximum, change.seq), cursor);

  return json({ cursor: newCursor, changes, hasMore: result.results.length > selectedRows.length });
}

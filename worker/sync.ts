import { error, json } from 'itty-router';
import type { IRequest } from 'itty-router';
import type { Env } from './index';

type AuthedRequest = IRequest & { userId: string };

interface Mutation {
  op: 'upsert' | 'delete';
  entity: string;
  entityId: string;
  payload?: unknown;
}

// Delta-Sync (vereinfachtes USN-Modell): append-only change_log liefert den Cursor (seq),
// sync_objects hält den aktuellen Stand je (user, entity, entity_id). Last-Write-Wins.
// Strukturkonflikte (Notetype/Template) werden hier noch nicht gesondert behandelt -> Phase 2.

const ALLOWED_ENTITIES = new Set(['deck', 'note', 'card', 'revlog', 'noteType']);

export async function handlePush(req: AuthedRequest, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { mutations?: Mutation[] };
  const mutations = Array.isArray(body.mutations) ? body.mutations : [];
  if (mutations.length > 5000) return error(413, 'Zu viele Mutationen pro Batch');

  const now = Date.now();
  let cursor = 0;

  for (const m of mutations) {
    if (!m || !m.entity || !m.entityId || (m.op !== 'upsert' && m.op !== 'delete')) continue;
    // Nur bekannte Entitäten zulassen — verhindert, dass ein bösartiger/fehlerhafter Client
    // Fremd-Entitäten in den Feed schreibt, die auf anderen Geräten Müll anrichten.
    if (!ALLOWED_ENTITIES.has(m.entity)) continue;
    // Revlog ist append-only: Löschungen werden nicht über den Sync propagiert.
    if (m.entity === 'revlog' && m.op === 'delete') continue;
    const isDelete = m.op === 'delete';
    const payloadObj = !isDelete && m.payload && typeof m.payload === 'object' ? (m.payload as Record<string, unknown>) : null;
    // Upsert-Payload muss zur entityId passen (Clients indexieren lokal auf payload.id;
    // eine Abweichung würde LWW-/Dedup-Prüfungen auf anderen Geräten umgehen).
    if (payloadObj && typeof payloadObj.id === 'string' && payloadObj.id !== m.entityId) continue;
    // Konfliktauflösung serverautoritativ per Inhalts-updatedAt (statt reiner Ankunftsreihenfolge).
    const clientUpdatedAt = payloadObj && typeof payloadObj.updatedAt === 'number' ? payloadObj.updatedAt : now;

    // Atomar: change_log + sync_objects in EINEM D1-Batch (eine Transaktion). Verhindert,
    // dass eine seq im change_log ohne passenden sync_objects-Stand zurückbleibt (Datenverlust
    // für andere Geräte). seq wird via last_insert_rowid() aus dem change_log-Insert übernommen.
    const res = await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO change_log (user_id, entity, entity_id, op, changed_at) VALUES (?,?,?,?,?) RETURNING seq',
      ).bind(req.userId, m.entity, m.entityId, m.op, now),
      env.DB.prepare(
        `INSERT INTO sync_objects (user_id, entity, entity_id, payload, deleted, seq, updated_at)
         VALUES (?,?,?,?,?, last_insert_rowid(), ?)
         ON CONFLICT(user_id, entity, entity_id) DO UPDATE SET
           payload    = CASE WHEN excluded.updated_at >= sync_objects.updated_at THEN excluded.payload ELSE sync_objects.payload END,
           deleted    = CASE WHEN excluded.updated_at >= sync_objects.updated_at THEN excluded.deleted ELSE sync_objects.deleted END,
           updated_at = MAX(excluded.updated_at, sync_objects.updated_at),
           seq        = excluded.seq`, // seq immer hochzählen → gewinnende Version propagiert an alle Geräte
      ).bind(
        req.userId,
        m.entity,
        m.entityId,
        isDelete ? null : JSON.stringify(m.payload ?? null),
        isDelete ? 1 : 0,
        clientUpdatedAt,
      ),
    ]);
    const seq = (res[0]?.results?.[0] as { seq?: number } | undefined)?.seq ?? 0;
    cursor = Math.max(cursor, seq);
  }

  return json({ cursor, applied: mutations.length });
}

export async function handlePull(req: AuthedRequest, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { cursor?: number };
  const cursor = typeof body.cursor === 'number' ? body.cursor : 0;
  const res = await env.DB.prepare(
    'SELECT entity, entity_id, payload, deleted, seq FROM sync_objects WHERE user_id = ? AND seq > ? ORDER BY seq ASC LIMIT 1000',
  )
    .bind(req.userId, cursor)
    .all<{ entity: string; entity_id: string; payload: string | null; deleted: number; seq: number }>();

  const changes = res.results.map((r) => ({
    entity: r.entity,
    entityId: r.entity_id,
    deleted: r.deleted === 1,
    payload: r.payload ? JSON.parse(r.payload) : null,
    seq: r.seq,
  }));
  const newCursor = changes.reduce((m, c) => Math.max(m, c.seq), cursor);

  return json({ cursor: newCursor, changes, hasMore: changes.length === 1000 });
}

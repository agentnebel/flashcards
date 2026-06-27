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

export async function handlePush(req: AuthedRequest, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { mutations?: Mutation[] };
  const mutations = Array.isArray(body.mutations) ? body.mutations : [];
  if (mutations.length > 5000) return error(413, 'Zu viele Mutationen pro Batch');

  const now = Date.now();
  let cursor = 0;

  for (const m of mutations) {
    if (!m || !m.entity || !m.entityId || (m.op !== 'upsert' && m.op !== 'delete')) continue;
    const seqRow = await env.DB.prepare(
      'INSERT INTO change_log (user_id, entity, entity_id, op, changed_at) VALUES (?,?,?,?,?) RETURNING seq',
    )
      .bind(req.userId, m.entity, m.entityId, m.op, now)
      .first<{ seq: number }>();
    const seq = seqRow?.seq ?? 0;
    cursor = Math.max(cursor, seq);
    await env.DB.prepare(
      `INSERT INTO sync_objects (user_id, entity, entity_id, payload, deleted, seq, updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(user_id, entity, entity_id) DO UPDATE SET
         payload=excluded.payload, deleted=excluded.deleted, seq=excluded.seq, updated_at=excluded.updated_at`,
    )
      .bind(
        req.userId,
        m.entity,
        m.entityId,
        m.op === 'delete' ? null : JSON.stringify(m.payload ?? null),
        m.op === 'delete' ? 1 : 0,
        seq,
        now,
      )
      .run();
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

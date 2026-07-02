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

  // Validierung vorab: nur bekannte Entitäten (verhindert, dass ein bösartiger/fehlerhafter
  // Client Fremd-Entitäten in den Feed schreibt), Revlog append-only (keine Deletes),
  // Upsert-Payload muss zur entityId passen (Clients indexieren lokal auf payload.id;
  // eine Abweichung würde LWW-/Dedup-Prüfungen auf anderen Geräten umgehen).
  const valid = mutations.filter((m) => {
    if (!m || !m.entity || !m.entityId || (m.op !== 'upsert' && m.op !== 'delete')) return false;
    if (!ALLOWED_ENTITIES.has(m.entity)) return false;
    if (m.entity === 'revlog' && m.op === 'delete') return false;
    if (m.op === 'upsert' && m.payload && typeof m.payload === 'object') {
      const id = (m.payload as Record<string, unknown>).id;
      if (typeof id === 'string' && id !== m.entityId) return false;
    }
    return true;
  });

  let cursor = 0;

  // Gebündelte D1-Batches statt eines Batches je Mutation: Jeder batch()-Aufruf zählt als
  // EIN Subrequest (Free-Plan-Limit: 50/Request) — ein 500er-Push-Chunk mit Einzel-Batches
  // würde das Limit sprengen und große Importe live abbrechen. Pro Mutation bleiben es zwei
  // Statements: change_log-Insert liefert die seq (last_insert_rowid() gilt innerhalb der
  // sequentiell laufenden Batch-Transaktion für das unmittelbar vorangehende Insert), das
  // sync_objects-Upsert übernimmt sie. Beides zusammen atomar — keine seq ohne Objektstand.
  const BATCH = 100; // 200 Statements je Batch, bleibt deutlich unter den D1-Limits
  for (let i = 0; i < valid.length; i += BATCH) {
    const slice = valid.slice(i, i + BATCH);
    const stmts = slice.flatMap((m) => {
      const isDelete = m.op === 'delete';
      const payloadObj = !isDelete && m.payload && typeof m.payload === 'object' ? (m.payload as Record<string, unknown>) : null;
      // Konfliktauflösung serverautoritativ per Inhalts-updatedAt (statt reiner Ankunftsreihenfolge).
      const clientUpdatedAt = payloadObj && typeof payloadObj.updatedAt === 'number' ? payloadObj.updatedAt : now;
      return [
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
      ];
    });
    const res = await env.DB.batch(stmts);
    for (let j = 0; j < slice.length; j++) {
      const seq = (res[j * 2]?.results?.[0] as { seq?: number } | undefined)?.seq ?? 0;
      cursor = Math.max(cursor, seq);
    }
  }

  return json({ cursor, applied: valid.length });
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

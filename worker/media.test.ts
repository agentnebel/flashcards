// @vitest-environment node
import { createHash } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import type { IRequest } from 'itty-router';
import { handleMediaExists, handleMediaGc, handleMediaGet, handleMediaUpload } from './media';
import { handlePush } from './sync';
import schema from './schema.sql?raw';
import type { Env } from './index';

const userId = 'media-race-user';
const bytes = new Uint8Array([1, 2, 3]);
const hash = createHash('sha256').update(bytes).digest('hex');

interface SqlStatement {
  query: string;
  execute: () => { results: Record<string, unknown>[] };
}

function mediaFixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schema);
  const now = Date.now();
  sqlite.prepare(
    `INSERT INTO media (id,user_id,sha256,mime,size,r2_key,created_at,orphaned_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run('media-1', userId, hash, 'image/png', bytes.length, `${userId}/${hash}`,
    now - 40 * 86_400_000, now - 31 * 86_400_000);
  sqlite.prepare(
    `INSERT INTO media_gc_runs (user_id,last_run_at,phase,note_cursor,media_cursor,snapshot_seq)
     VALUES (?,0,'sweep','','',0)`,
  ).run(userId);

  const r2 = new Set([`${userId}/${hash}`]);
  const hooks: {
    beforeBatch?: (statements: SqlStatement[]) => Promise<void>;
    beforeDelete?: () => Promise<void>;
  } = {};
  const media = {
    head: vi.fn(async (key: string) => r2.has(key) ? {} : null),
    put: vi.fn(async (key: string) => { r2.add(key); }),
    delete: vi.fn(async (key: string) => {
      await hooks.beforeDelete?.();
      r2.delete(key);
    }),
  };
  const env = {
    DB: {
      prepare(query: string) {
        const statement = sqlite.prepare(query);
        let args: SQLInputValue[] = [];
        return {
          query,
          bind(...values: SQLInputValue[]) { args = values; return this; },
          async first() { return statement.get(...args) ?? null; },
          async all() { return { results: statement.all(...args) }; },
          async run() { return { results: statement.all(...args) }; },
          execute() { return { results: statement.all(...args) }; },
        };
      },
      async batch(statements: SqlStatement[]) {
        await hooks.beforeBatch?.(statements);
        sqlite.exec('BEGIN');
        try {
          const results = statements.map((statement) => statement.execute());
          sqlite.exec('COMMIT');
          return results;
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      },
    },
    MEDIA: media,
    MEDIA_LIMITER: { limit: async () => ({ success: true }) },
    SYNC_LIMITER: { limit: async () => ({ success: true }) },
  } as unknown as Env;
  return { sqlite, r2, hooks, media, env };
}

function authedRequest(path: string, body?: unknown) {
  const request = new Request(`https://flashcards.test/api/${path}`, {
    method: 'POST',
    ...(body === undefined ? {} : {
      body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
    }),
  }) as unknown as IRequest & { userId: string };
  request.userId = userId;
  return request;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('Medien-GC mit echten SQLite-Transaktionen', () => {
  it.each(['note', 'noteType'] as const)(
    'weist neue %s-Referenzen während eines Claims vollständig ab und lässt den Retry zu',
    async (entity) => {
      const fixture = mediaFixture();
      const deleting = deferred();
      const finishDelete = deferred();
      fixture.hooks.beforeDelete = async () => {
        deleting.resolve();
        await finishDelete.promise;
      };
      const gc = handleMediaGc(authedRequest('media/gc'), fixture.env);
      await deleting.promise;

      const mutations = [
        { op: 'upsert', entity: 'deck', entityId: 'unrelated', payload: { id: 'unrelated' } },
        { op: 'upsert', entity, entityId: 'restored', payload: {
          id: 'restored', ...(entity === 'note'
            ? { fields: { front: `<img src="flashmedia:${hash}">` } }
            : { css: `.card { background: url("flashmedia:${hash}") }` }),
        } },
        { op: 'delete', entity: 'deck', entityId: 'also-unrelated' },
      ];
      const blocked = await handlePush(authedRequest('sync/push', { mutations }), fixture.env);
      expect(blocked.status).toBe(409);
      await expect(blocked.json()).resolves.toMatchObject({ code: 'MEDIA_DELETE_IN_PROGRESS' });
      expect(fixture.sqlite.prepare('SELECT COUNT(*) AS count FROM sync_objects').get()?.count).toBe(0);
      expect(fixture.sqlite.prepare('SELECT * FROM sync_user_daily_usage').get()).toBeUndefined();
      expect(fixture.sqlite.prepare('SELECT * FROM sync_global_daily_usage').get()).toBeUndefined();

      const exists = await handleMediaExists(authedRequest('media/exists', { hashes: [hash] }), fixture.env);
      await expect(exists.json()).resolves.toEqual({ have: [], missing: [hash] });
      expect(fixture.media.head).not.toHaveBeenCalled();

      finishDelete.resolve();
      await gc;
      const retry = await handlePush(authedRequest('sync/push', { mutations }), fixture.env);
      expect(retry.status).toBe(200);
      await expect(retry.json()).resolves.toEqual({ cursor: 3, applied: 3 });
      expect(fixture.sqlite.prepare('SELECT seq FROM sync_objects ORDER BY seq').all())
        .toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
      expect(fixture.sqlite.prepare('SELECT mutations FROM sync_user_daily_usage').get()?.mutations).toBe(3);

      const upload = new Request('https://flashcards.test/api/media/upload', {
        method: 'POST', headers: { 'Content-Type': 'image/png' }, body: bytes,
      }) as unknown as IRequest & { userId: string };
      upload.userId = userId;
      expect((await handleMediaUpload(upload, fixture.env)).status).toBe(200);
      expect(fixture.r2.has(`${userId}/${hash}`)).toBe(true);
      fixture.sqlite.close();
    },
  );

  it('rettet einen Exists-Treffer atomar vor einem bereits vorbereiteten GC-Claim', async () => {
    const fixture = mediaFixture();
    const claiming = deferred();
    const finishClaim = deferred();
    fixture.hooks.beforeBatch = async (statements) => {
      if (statements.some(({ query }) => query.includes('UPDATE media SET orphaned_at = ?') &&
        query.includes('AND NOT EXISTS'))) {
        claiming.resolve();
        await finishClaim.promise;
      }
    };
    const gc = handleMediaGc(authedRequest('media/gc'), fixture.env);
    await claiming.promise;
    const exists = await handleMediaExists(authedRequest('media/exists', { hashes: [hash] }), fixture.env);
    await expect(exists.json()).resolves.toEqual({ have: [hash], missing: [] });
    finishClaim.resolve();
    await expect((await gc).json()).resolves.toMatchObject({ deleted: 0, rescued: 1 });
    expect(fixture.media.delete).not.toHaveBeenCalled();
    expect(fixture.r2.has(`${userId}/${hash}`)).toBe(true);
    fixture.sqlite.close();
  });

  it.each(['scan', 'sweep'] as const)(
    'behält Vorlagenbilder auch bei einem bereits laufenden %s-Zyklus',
    async (phase) => {
      const fixture = mediaFixture();
      fixture.sqlite.prepare(
        `INSERT INTO sync_objects (user_id,entity,entity_id,payload,seq,updated_at)
         VALUES (?,'note','same-id',?,1,1), (?,'noteType','same-id',?,2,2)`,
      ).run(userId, JSON.stringify({ id: 'same-id', fields: { front: 'Text' } }),
        userId, JSON.stringify({ id: 'same-id', templates: [{ qfmt: `<img src="flashmedia:${hash}">` }] }));
      fixture.sqlite.prepare('UPDATE media_gc_runs SET phase = ?, snapshot_seq = 2').run(phase);
      if (phase === 'scan') {
        await handleMediaGc(authedRequest('media/gc'), fixture.env);
        expect(fixture.sqlite.prepare('SELECT sha256 FROM media_gc_references').get()?.sha256).toBe(hash);
        fixture.sqlite.prepare('UPDATE media_gc_runs SET last_run_at = 0').run();
      }
      const result = await handleMediaGc(authedRequest('media/gc'), fixture.env);
      await expect(result.json()).resolves.toMatchObject({ deleted: 0, rescued: 1 });
      expect(fixture.r2.has(`${userId}/${hash}`)).toBe(true);
      expect(fixture.sqlite.prepare('SELECT orphaned_at FROM media').get()?.orphaned_at).toBeNull();
      fixture.sqlite.close();
    },
  );
});

describe('authentifizierter Medienabruf', () => {
  it('verbietet Browser-Caching über Kontowechsel hinweg', async () => {
    const statement = {
      bind: vi.fn(),
    };
    statement.bind.mockReturnValue(statement);
    const env = {
      DB: {
        prepare: vi.fn().mockReturnValue(statement),
        batch: vi.fn().mockResolvedValue([]),
      },
      MEDIA: {
        get: vi.fn().mockResolvedValue({
          body: new Uint8Array([1, 2, 3]),
          httpMetadata: { contentType: 'image/png' },
        }),
      },
      MEDIA_LIMITER: {
        limit: vi.fn().mockResolvedValue({ success: true }),
      },
    } as unknown as Env;
    const request = {
      userId: 'user-a',
      params: { hash: 'a'.repeat(64) },
    } as unknown as IRequest & { userId: string };

    const response = await handleMediaGet(request, env);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Cache-Control')).not.toContain('max-age');
  });
});

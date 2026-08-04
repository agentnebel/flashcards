import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renameDeck } from '../db/api';
import { db, type Deck } from '../db/db';
import { MAX_SYNC_PAYLOAD_BYTES, MAX_SYNC_REQUEST_BYTES } from '../lib/syncProtocol';
import {
  getAuth,
  getSyncState,
  loadLastSyncAt,
  login,
  logout,
  register,
  sync,
} from './engine';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pullResponse(deckId: string): Response {
  const deck: Deck = {
    id: deckId,
    name: 'Verspäteter Serverstand',
    parentId: null,
    newPerDay: 20,
    updatedAt: 10,
  };
  return new Response(JSON.stringify({
    cursor: 1,
    changes: [{
      entity: 'deck',
      entityId: deck.id,
      deleted: false,
      payload: deck,
      seq: 1,
    }],
    hasMore: false,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function emptyPullResponse(): Response {
  return new Response(JSON.stringify({ cursor: 0, changes: [], hasMore: false }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await logout();
  await db.transaction('rw', db.tables, async () => {
    await Promise.all(db.tables.map((table) => table.clear()));
  });
});

describe('Sync-Invalidierung bei Konto-Übergängen', () => {
  it('bricht eine Registrierung vor dem Server-Request ab, wenn der Kontowechsel abgelehnt wird', async () => {
    await db.meta.put({ key: 'lastAccountId', value: 'old-user' });
    await db.decks.put({
      id: 'local-deck',
      name: 'Nur lokal',
      parentId: null,
      newPerDay: 20,
      updatedAt: 1,
    });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    await expect(register(
      'new@example.test',
      'password-123',
      'one-time-invitation-code',
    )).rejects.toThrow(/Registrierung abgebrochen/);

    expect(fetchMock).not.toHaveBeenCalled();
    await expect(db.decks.get('local-deck')).resolves.toBeDefined();
    await expect(getAuth()).resolves.toBeNull();
  });

  it('bestätigt den Registrierungs-Kontowechsel nur einmal und löscht danach atomar', async () => {
    await db.meta.put({ key: 'lastAccountId', value: 'old-user' });
    await db.decks.put({
      id: 'local-deck',
      name: 'Nur lokal',
      parentId: null,
      newPerDay: 20,
      updatedAt: 1,
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      token: 'new-token',
      user: { id: 'new-user', email: 'new@example.test' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(register(
      'new@example.test',
      'password-123',
      'one-time-invitation-code',
    )).resolves.toMatchObject({ userId: 'new-user' });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledOnce();
    await expect(db.decks.get('local-deck')).resolves.toBeUndefined();
    await expect(getAuth()).resolves.toMatchObject({ token: 'new-token', userId: 'new-user' });
  });

  it('wartet beim Logout auf den invalidierten Pull und verwirft dessen verspätete Daten', async () => {
    await db.meta.bulkPut([
      { key: 'auth', value: { token: 'old-token', userId: 'old-user', email: 'old@example.test' } },
      { key: 'lastAccountId', value: 'old-user' },
    ]);
    const delayedPull = deferred<Response>();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => delayedPull.promise);
    vi.stubGlobal('fetch', fetchMock);

    const syncPromise = sync();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    let logoutFinished = false;
    const logoutPromise = logout().then(() => {
      logoutFinished = true;
    });
    await vi.waitFor(() => {
      const request = fetchMock.mock.calls[0][1] as RequestInit;
      expect(request.signal?.aborted).toBe(true);
    });
    expect(logoutFinished).toBe(false);

    delayedPull.resolve(pullResponse('stale-after-logout'));
    await Promise.all([syncPromise, logoutPromise]);

    await expect(db.decks.get('stale-after-logout')).resolves.toBeUndefined();
    await expect(getAuth()).resolves.toBeNull();
    expect(getSyncState()).toMatchObject({
      syncing: false,
      lastSyncAt: null,
      error: null,
    });
  });

  it('wartet beim Kontowechsel und lässt den alten Pull weder Daten noch Status zurückschreiben', async () => {
    await db.meta.bulkPut([
      { key: 'auth', value: { token: 'old-token', userId: 'old-user', email: 'old@example.test' } },
      { key: 'lastAccountId', value: 'old-user' },
      { key: 'lastSyncAt', value: 123 },
    ]);
    await loadLastSyncAt();

    const delayedPull = deferred<Response>();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
      if (String(input) === '/api/auth/login') {
        return Promise.resolve(new Response(JSON.stringify({
          token: 'new-token',
          user: { id: 'new-user', email: 'new@example.test' },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return delayedPull.promise;
    });
    vi.stubGlobal('fetch', fetchMock);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    const syncPromise = sync();
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input) === '/api/sync/pull')).toBe(true);
    });
    const loginPromise = login('new@example.test', 'password-123');
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    const pullCall = fetchMock.mock.calls.find(([input]) => String(input) === '/api/sync/pull');
    expect((pullCall?.[1] as RequestInit).signal?.aborted).toBe(true);

    delayedPull.resolve(pullResponse('stale-after-account-switch'));
    const [, auth] = await Promise.all([syncPromise, loginPromise]);

    expect(auth).toMatchObject({ token: 'new-token', userId: 'new-user' });
    await expect(db.decks.get('stale-after-account-switch')).resolves.toBeUndefined();
    await expect(getAuth()).resolves.toMatchObject({ token: 'new-token', userId: 'new-user' });
    await expect(db.meta.get('lastAccountId')).resolves.toMatchObject({ value: 'new-user' });
    expect(getSyncState()).toEqual({
      syncing: false,
      lastSyncAt: null,
      error: null,
    });
  });
});

describe('Server-Normalisierung lokaler Zeitstempel', () => {
  it('übernimmt den Serverwert und verliert eine direkte Folgeänderung nicht', async () => {
    const normalizedAt = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(normalizedAt);
    const futureAt = normalizedAt + 365 * 24 * 60 * 60_000;
    const localDeck: Deck = {
      id: 'future-deck',
      name: 'Zukunft',
      parentId: null,
      newPerDay: 20,
      updatedAt: futureAt,
    };
    await db.meta.bulkPut([
      { key: 'auth', value: { token: 'token', userId: 'user', email: 'user@example.test' } },
      { key: 'lastMediaGcAt', value: Date.now() },
      { key: 'lastMediaRevalidationAt', value: Date.now() },
    ]);
    await db.decks.put(localDeck);
    await db.outbox.add({
      op: 'upsert',
      entity: 'deck',
      entityId: localDeck.id,
      payload: localDeck,
      createdAt: futureAt,
    });

    let pullCalls = 0;
    let serverSeq = 0;
    let serverDeck: Deck | undefined;
    const pushedUpdatedAts: number[] = [];
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const path = String(input);
      if (path === '/api/sync/push') {
        const body = JSON.parse(String(init?.body)) as {
          mutations: Array<{ payload?: Deck }>;
        };
        const pushed = body.mutations[0]?.payload;
        if (!pushed) throw new Error('Deck-Payload fehlt');
        pushedUpdatedAts.push(pushed.updatedAt);
        serverSeq += 1;
        serverDeck = { ...pushed, updatedAt: Math.min(pushed.updatedAt, Date.now()) };
        return Promise.resolve(new Response(JSON.stringify({ cursor: serverSeq, applied: 1 })));
      }
      if (path === '/api/sync/pull') {
        pullCalls += 1;
        const { cursor } = JSON.parse(String(init?.body)) as { cursor: number };
        if (!serverDeck || cursor >= serverSeq) {
          return Promise.resolve(new Response(JSON.stringify({
            cursor,
            changes: [],
            hasMore: false,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        return Promise.resolve(new Response(JSON.stringify({
          cursor: serverSeq,
          changes: [{
            entity: 'deck',
            entityId: serverDeck.id,
            deleted: false,
            payload: serverDeck,
            seq: serverSeq,
            updatedAt: serverDeck.updatedAt,
          }],
          hasMore: false,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      throw new Error(`Unerwarteter Request: ${path}`);
    }));

    await sync();

    expect(pushedUpdatedAts).toEqual([futureAt]);
    expect(pullCalls).toBe(2);
    await expect(db.decks.get(localDeck.id)).resolves.toMatchObject({
      updatedAt: normalizedAt,
    });
    await expect(db.outbox.count()).resolves.toBe(0);

    vi.mocked(Date.now).mockReturnValue(normalizedAt + 1);
    await renameDeck(localDeck.id, 'Direkte Folgeänderung');
    await sync();

    expect(pushedUpdatedAts).toEqual([futureAt, normalizedAt + 1]);
    expect(pullCalls).toBe(4);
    await expect(db.decks.get(localDeck.id)).resolves.toMatchObject({
      name: 'Direkte Folgeänderung',
      updatedAt: normalizedAt + 1,
    });
    await expect(db.outbox.count()).resolves.toBe(0);
    expect(getSyncState().error).toBeNull();
  });
});

describe('Outbox-Batching gemäß Serververtrag', () => {
  it('teilt 100er-Chunks zusätzlich an der 2-MiB-Requestgrenze', async () => {
    await db.meta.put({
      key: 'auth',
      value: { token: 'token', userId: 'user', email: 'user@example.test' },
    });
    for (let index = 0; index < 12; index++) {
      const id = `large-note-${index}`;
      await db.outbox.add({
        op: 'upsert',
        entity: 'note',
        entityId: id,
        payload: { id, updatedAt: 1, fields: { Front: 'x'.repeat(200 * 1024) } },
        createdAt: 1,
      });
    }

    const pushBodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const path = String(input);
      if (path === '/api/sync/pull') return Promise.resolve(emptyPullResponse());
      if (path === '/api/sync/push') {
        pushBodies.push(String(init?.body ?? ''));
        const mutations = (JSON.parse(String(init?.body)) as { mutations: unknown[] }).mutations;
        return Promise.resolve(new Response(JSON.stringify({ cursor: mutations.length, applied: mutations.length })));
      }
      if (path === '/api/media/gc') return Promise.resolve(new Response(JSON.stringify({ deleted: 0 })));
      throw new Error(`Unerwarteter Request: ${path}`);
    }));

    await sync();

    expect(pushBodies.length).toBeGreaterThan(1);
    for (const body of pushBodies) {
      expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(MAX_SYNC_REQUEST_BYTES);
    }
    await expect(db.outbox.count()).resolves.toBe(0);
    expect(getSyncState().error).toBeNull();
  });

  it('markiert übergroße Einzeländerungen sichtbar und synchronisiert spätere Einträge weiter', async () => {
    await db.meta.put({
      key: 'auth',
      value: { token: 'token', userId: 'user', email: 'user@example.test' },
    });
    await db.outbox.bulkAdd([
      {
        op: 'upsert',
        entity: 'note',
        entityId: 'oversized',
        payload: {
          id: 'oversized',
          updatedAt: 1,
          fields: { Front: 'x'.repeat(MAX_SYNC_PAYLOAD_BYTES + 1) },
        },
        createdAt: 1,
      },
      {
        op: 'upsert',
        entity: 'deck',
        entityId: 'valid-deck',
        payload: { id: 'valid-deck', updatedAt: 2, name: 'Klein' },
        createdAt: 2,
      },
    ]);
    const pushedEntities: string[] = [];
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const path = String(input);
      if (path === '/api/sync/pull') return Promise.resolve(emptyPullResponse());
      if (path === '/api/sync/push') {
        const body = JSON.parse(String(init?.body)) as {
          mutations: Array<{ entityId: string }>;
        };
        pushedEntities.push(...body.mutations.map((mutation) => mutation.entityId));
        return Promise.resolve(new Response(JSON.stringify({
          cursor: pushedEntities.length,
          applied: body.mutations.length,
        })));
      }
      if (path === '/api/media/gc') return Promise.resolve(new Response(JSON.stringify({ deleted: 0 })));
      throw new Error(`Unerwarteter Request: ${path}`);
    }));

    await sync();

    expect(pushedEntities).toContain('valid-deck');
    expect(pushedEntities).not.toContain('oversized');
    const rejected = await db.outbox.toArray();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ entityId: 'oversized' });
    expect(rejected[0].syncError).toMatch(/Payload ist zu groß/);
    expect(getSyncState().error).toMatch(/bleiben lokal/);

    await db.outbox.add({
      op: 'upsert',
      entity: 'note',
      entityId: 'oversized',
      payload: { id: 'oversized', updatedAt: 3, fields: { Front: 'jetzt klein' } },
      createdAt: 3,
    });
    await sync();

    expect(pushedEntities).toContain('oversized');
    await expect(db.outbox.count()).resolves.toBe(0);
    expect(getSyncState().error).toBeNull();
  });

  it('isoliert serverseitige 413-Einträge und lässt Updates dahinter passieren', async () => {
    await db.meta.put({
      key: 'auth',
      value: { token: 'token', userId: 'user', email: 'user@example.test' },
    });
    await db.outbox.bulkAdd([
      {
        op: 'upsert',
        entity: 'deck',
        entityId: 'new-over-limit',
        payload: { id: 'new-over-limit', updatedAt: 1 },
        createdAt: 1,
      },
      {
        op: 'upsert',
        entity: 'deck',
        entityId: 'existing-update',
        payload: { id: 'existing-update', updatedAt: 2 },
        createdAt: 2,
      },
    ]);
    const successful: string[] = [];
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const path = String(input);
      if (path === '/api/sync/pull') return Promise.resolve(emptyPullResponse());
      if (path === '/api/sync/push') {
        const body = JSON.parse(String(init?.body)) as {
          mutations: Array<{ entityId: string }>;
        };
        if (body.mutations.some((mutation) => mutation.entityId === 'new-over-limit')) {
          return Promise.resolve(new Response(
            JSON.stringify({ error: 'Sync-Objektlimit erreicht' }),
            { status: 413, headers: { 'Content-Type': 'application/json' } },
          ));
        }
        successful.push(...body.mutations.map((mutation) => mutation.entityId));
        return Promise.resolve(new Response(JSON.stringify({
          cursor: successful.length,
          applied: body.mutations.length,
        })));
      }
      if (path === '/api/media/gc') return Promise.resolve(new Response(JSON.stringify({ deleted: 0 })));
      throw new Error(`Unerwarteter Request: ${path}`);
    }));

    await sync();

    expect(successful).toEqual(['existing-update']);
    const remaining = await db.outbox.toArray();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({
      entityId: 'new-over-limit',
      syncError: 'Sync-Objektlimit erreicht',
    });
    expect(getSyncState().error).toMatch(/bleiben lokal/);
  });

  it('verwirft Quota-413 nicht dauerhaft und versucht nach einem freigebenden Update erneut', async () => {
    await db.meta.put({
      key: 'auth',
      value: { token: 'token', userId: 'user', email: 'user@example.test' },
    });
    await db.outbox.bulkAdd([
      {
        op: 'upsert',
        entity: 'deck',
        entityId: 'new-after-limit',
        payload: { id: 'new-after-limit', updatedAt: 1 },
        createdAt: 1,
      },
      {
        op: 'upsert',
        entity: 'note',
        entityId: 'shrunk-existing',
        payload: { id: 'shrunk-existing', updatedAt: 2, fields: { Front: 'klein' } },
        createdAt: 2,
      },
    ]);
    let spaceFreed = false;
    let newAttempts = 0;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const path = String(input);
      if (path === '/api/sync/pull') return Promise.resolve(emptyPullResponse());
      if (path === '/api/sync/push') {
        const body = JSON.parse(String(init?.body)) as {
          mutations: Array<{ entityId: string }>;
        };
        const includesNew = body.mutations.some((mutation) => mutation.entityId === 'new-after-limit');
        const includesShrink = body.mutations.some((mutation) => mutation.entityId === 'shrunk-existing');
        if (includesNew) newAttempts += 1;
        if (includesNew && !spaceFreed) {
          return Promise.resolve(new Response(JSON.stringify({
            error: 'Sync-Speicherlimit erreicht',
            code: 'SYNC_STORAGE_LIMIT',
          }), { status: 413, headers: { 'Content-Type': 'application/json' } }));
        }
        if (includesShrink) spaceFreed = true;
        return Promise.resolve(new Response(JSON.stringify({
          cursor: 1,
          applied: body.mutations.length,
        })));
      }
      if (path === '/api/media/gc') return Promise.resolve(new Response(JSON.stringify({ deleted: 0 })));
      throw new Error(`Unerwarteter Request: ${path}`);
    }));

    await sync();

    expect(spaceFreed).toBe(true);
    expect(newAttempts).toBe(3);
    await expect(db.outbox.count()).resolves.toBe(0);
  });

  it('behandelt das Objektlimit als transient statt den Eintrag dauerhaft abzulehnen', async () => {
    await db.meta.put({
      key: 'auth',
      value: { token: 'token', userId: 'user', email: 'user@example.test' },
    });
    await db.outbox.add({
      op: 'upsert',
      entity: 'revlog',
      entityId: 'review-at-limit',
      payload: { id: 'review-at-limit' },
      createdAt: 1,
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation((input) => {
      const path = String(input);
      if (path === '/api/sync/pull') return Promise.resolve(emptyPullResponse());
      if (path === '/api/sync/push') {
        return Promise.resolve(new Response(JSON.stringify({
          error: 'Sync-Objektlimit erreicht (max. 50000 pro Konto)',
          code: 'SYNC_OBJECT_LIMIT',
        }), { status: 413, headers: { 'Content-Type': 'application/json' } }));
      }
      if (path === '/api/media/gc') return Promise.resolve(new Response(JSON.stringify({ deleted: 0 })));
      throw new Error(`Unerwarteter Request: ${path}`);
    }));

    await sync();

    // Löschungen können später wieder Platz schaffen — der Eintrag bleibt sendbar,
    // statt per syncError dauerhaft aus jedem künftigen Push herauszufallen.
    const [item] = await db.outbox.toArray();
    expect(item.syncError).toBeUndefined();
    expect(getSyncState().error).toContain('Objektlimit');
  });
});

describe('Pull-Schemaprüfung', () => {
  it('überspringt strukturell kaputte Remote-Payloads statt sie still zu übernehmen', async () => {
    await db.meta.put({
      key: 'auth',
      value: { token: 'token', userId: 'user', email: 'user@example.test' },
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation((input) => {
      const path = String(input);
      if (path === '/api/sync/pull') {
        return Promise.resolve(new Response(JSON.stringify({
          cursor: 2,
          changes: [
            {
              entity: 'card',
              entityId: 'broken-card',
              deleted: false,
              // due und fsrs fehlen → würde lokal als Invalid Date landen und nie fällig.
              payload: { id: 'broken-card', noteId: 'n1', deckId: 'd1', updatedAt: 5 },
              seq: 1,
            },
            {
              entity: 'deck',
              entityId: 'valid-deck',
              deleted: false,
              payload: { id: 'valid-deck', name: 'OK', parentId: null, newPerDay: 20, updatedAt: 5 },
              seq: 2,
            },
          ],
          hasMore: false,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (path === '/api/media/gc') return Promise.resolve(new Response(JSON.stringify({ deleted: 0 })));
      throw new Error(`Unerwarteter Request: ${path}`);
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await sync();
    } finally {
      warn.mockRestore();
    }

    // Der kaputte Datensatz wird übersprungen, gültige dahinter kommen an, der Cursor
    // läuft weiter (kein dauerhaft hängender Sync wegen eines Einzelfalls).
    await expect(db.cards.count()).resolves.toBe(0);
    await expect(db.decks.get('valid-deck')).resolves.toMatchObject({ name: 'OK' });
    await expect(db.meta.get('syncCursor')).resolves.toMatchObject({ value: 2 });
    expect(getSyncState().error).toBeNull();
  });
});

describe('Medienfehler isolieren', () => {
  it('wiederholt eine abgeschlossene R2-Revalidierung nicht bei jedem Minuten-Sync', async () => {
    const now = Date.now();
    const hash = 'e'.repeat(64);
    await db.meta.bulkPut([
      { key: 'auth', value: { token: 'token', userId: 'user', email: 'user@example.test' } },
      { key: 'lastMediaGcAt', value: now },
    ]);
    await db.notes.add({
      id: 'media-note',
      guid: 'media-note-guid',
      noteTypeId: 'basic',
      deckId: 'deck',
      fields: { Front: `<img src="flashmedia:${hash}">`, Back: '' },
      tags: [],
      sortField: '',
      updatedAt: now,
    });
    await db.media.add({
      hash,
      blob: new Blob(['image'], { type: 'image/webp' }),
      mime: 'image/webp',
      size: 5,
      width: 1,
      height: 1,
      createdAt: now,
      synced: 1,
    });
    let existsCalls = 0;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation((input) => {
      const path = String(input);
      if (path === '/api/sync/pull') return Promise.resolve(emptyPullResponse());
      if (path === '/api/media/exists') {
        existsCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({
          have: [hash],
          missing: [],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      throw new Error(`Unerwarteter Request: ${path}`);
    }));

    await sync();
    await sync();

    expect(existsCalls).toBe(1);
    await expect(db.meta.get('lastMediaRevalidationAt')).resolves.toMatchObject({
      value: expect.any(Number),
    });
  });

  it('führt Remote-GC trotz voller Medienquote aus', async () => {
    await db.meta.put({
      key: 'auth',
      value: { token: 'token', userId: 'user', email: 'user@example.test' },
    });
    await db.media.add({
      hash: 'a'.repeat(64),
      blob: new Blob(['pending'], { type: 'image/webp' }),
      mime: 'image/webp',
      size: 7,
      width: 1,
      height: 1,
      createdAt: 1,
      synced: 0,
    });
    let gcCalls = 0;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation((input) => {
      const path = String(input);
      if (path === '/api/sync/pull') return Promise.resolve(emptyPullResponse());
      if (path === '/api/media/exists') {
        return Promise.resolve(new Response(JSON.stringify({
          have: [],
          missing: ['a'.repeat(64)],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (path === '/api/media/upload') {
        return Promise.resolve(new Response(JSON.stringify({
          error: 'Speicherlimit erreicht (500 MB pro Konto)',
        }), { status: 413, headers: { 'Content-Type': 'application/json' } }));
      }
      if (path === '/api/media/gc') {
        gcCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({
          phase: 'scan',
          complete: false,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      throw new Error(`Unerwarteter Request: ${path}`);
    }));

    await sync();

    expect(gcCalls).toBe(1);
    expect(getSyncState().error).toMatch(/1 Bild/);
    await expect(db.media.get('a'.repeat(64))).resolves.toMatchObject({ synced: 0 });
  });
});

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, type Media, type Note } from '../db/db';
import {
  downloadReferencedMedia,
  garbageCollectRemoteMedia,
  revalidateReferencedMedia,
  uploadPendingMedia,
} from './media';

function makeNote(fields: Record<string, string>): Note {
  return {
    id: 'note-media',
    guid: 'guid-media',
    noteTypeId: 'nt-basic',
    deckId: 'deck-default',
    fields,
    tags: [],
    sortField: '',
    updatedAt: 1,
  };
}

function makeMedia(hash: string, synced: 0 | 1): Media {
  const blob = new Blob([hash], { type: 'image/webp' });
  return {
    hash,
    blob,
    mime: blob.type,
    size: blob.size,
    width: 1,
    height: 1,
    createdAt: 1,
    synced,
  };
}

beforeEach(async () => {
  await db.transaction('rw', db.tables, async () => {
    await Promise.all(db.tables.map((table) => table.clear()));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Remote-Medien-Revalidierung', () => {
  it('setzt nur referenzierte und remote fehlende synced-Blobs wieder auf pending', async () => {
    const present = 'a'.repeat(64);
    const missing = 'b'.repeat(64);
    const unreferenced = 'c'.repeat(64);
    const alreadyPending = 'd'.repeat(64);
    await db.notes.add(makeNote({
      Front: `<img src="flashmedia:${present}"><img src="flashmedia:${missing}">`,
      Back: `<img src="flashmedia:${alreadyPending}">`,
    }));
    await db.media.bulkAdd([
      makeMedia(present, 1),
      makeMedia(missing, 1),
      makeMedia(unreferenced, 1),
      makeMedia(alreadyPending, 0),
    ]);

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      have: [present],
      missing: [missing],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(revalidateReferencedMedia('', 'token')).resolves.toEqual({
      reset: 1,
      complete: true,
    });
    await expect(db.media.get(present)).resolves.toMatchObject({ synced: 1 });
    await expect(db.media.get(missing)).resolves.toMatchObject({ synced: 0 });
    await expect(db.media.get(unreferenced)).resolves.toMatchObject({ synced: 1 });
    await expect(db.media.get(alreadyPending)).resolves.toMatchObject({ synced: 0 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual({ hashes: [present, missing] });
  });

  it('behält bestätigte Missing-Ergebnisse, wenn ein späterer Exists-Chunk limitiert wird', async () => {
    const hashes = Array.from({ length: 41 }, (_, index) => index.toString(16).padStart(64, '0'));
    await db.notes.add(makeNote({
      Front: hashes.map((hash) => `<img src="flashmedia:${hash}">`).join(''),
    }));
    await db.media.bulkAdd(hashes.map((hash) => makeMedia(hash, 1)));
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        have: hashes.slice(1, 40),
        missing: [hashes[0]],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(revalidateReferencedMedia('', 'token')).resolves.toEqual({
      reset: 1,
      complete: false,
    });
    await expect(db.media.get(hashes[0])).resolves.toMatchObject({ synced: 0 });
    await expect(db.media.get(hashes[40])).resolves.toMatchObject({ synced: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rotiert den Revalidierungs-Cursor statt bei großen Sammlungen am Listenanfang zu verhungern', async () => {
    const hashes = Array.from({ length: 801 }, (_, index) => index.toString(16).padStart(64, '0'));
    await db.notes.add(makeNote({
      Front: hashes.map((hash) => `<img src="flashmedia:${hash}">`).join(''),
    }));
    await db.media.bulkAdd(hashes.map((hash) => makeMedia(hash, 1)));
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      const body = JSON.parse(String(init?.body)) as { hashes: string[] };
      return Promise.resolve(new Response(JSON.stringify({
        have: body.hashes,
        missing: [],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(revalidateReferencedMedia('', 'token')).resolves.toEqual({
      reset: 0,
      complete: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(20);
    await expect(db.meta.get('mediaRevalidationCursor')).resolves.toMatchObject({
      value: hashes[799],
    });

    await expect(revalidateReferencedMedia('', 'token')).resolves.toEqual({
      reset: 0,
      complete: true,
    });
    const firstSecondRun = fetchMock.mock.calls[20][1] as RequestInit;
    expect((JSON.parse(String(firstSecondRun.body)) as { hashes: string[] }).hashes[0])
      .toBe(hashes[800]);
    await expect(db.meta.get('mediaRevalidationCursor')).resolves.toBeUndefined();
  });
});

describe('Pending-Medien-Upload', () => {
  it('bricht nach einem global wirkenden Upload-Fehler ab, statt den Rest zu stürmen', async () => {
    const hashes = Array.from({ length: 65 }, (_, index) => (index + 1).toString(16).padStart(64, '0'));
    await db.media.bulkAdd(hashes.map((hash) => makeMedia(hash, 0)));
    let uploads = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      if (String(input).endsWith('/api/media/exists')) {
        const body = JSON.parse(String(init?.body)) as { hashes: string[] };
        return Promise.resolve(new Response(JSON.stringify({
          have: [],
          missing: body.hashes,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      uploads += 1;
      const hash = hashes[uploads - 1];
      return Promise.resolve(
        uploads === 1
          ? new Response(JSON.stringify({ hash }), { status: 200 })
          : new Response(JSON.stringify({ error: 'limitiert' }), { status: 429 }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(uploadPendingMedia('', 'token')).resolves.toEqual({
      uploaded: 1,
      failed: 64,
    });
    expect(uploads).toBe(2);
    await expect(db.media.where('synced').equals(0).count()).resolves.toBe(64);
  });

  it('überspringt eine gerade vom GC beanspruchte Datei (409), ohne Fehler oder Abbruch', async () => {
    const hashes = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
    await db.media.bulkAdd(hashes.map((hash) => makeMedia(hash, 0)));
    let uploads = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      if (String(input).endsWith('/api/media/exists')) {
        const body = JSON.parse(String(init?.body)) as { hashes: string[] };
        return Promise.resolve(new Response(JSON.stringify({ have: [], missing: body.hashes })));
      }
      uploads += 1;
      // Zweiter Upload: GC-Claim (MEDIA_DELETE_IN_PROGRESS) — transient, kein Fehler.
      if (uploads === 2) {
        return Promise.resolve(new Response(
          JSON.stringify({ error: 'wird bereinigt', code: 'MEDIA_DELETE_IN_PROGRESS' }),
          { status: 409 },
        ));
      }
      return Promise.resolve(new Response(JSON.stringify({ hash: hashes[uploads - 1] }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(uploadPendingMedia('', 'token')).resolves.toEqual({ uploaded: 2, failed: 0 });
    expect(uploads).toBe(3);
    await expect(db.media.get(hashes[1])).resolves.toMatchObject({ synced: 0 });
  });

  it('markiert einen Upload bei abweichendem Server-Hash nicht als synchronisiert', async () => {
    const hash = 'a'.repeat(64);
    await db.media.add(makeMedia(hash, 0));
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation((input) => {
      if (String(input).endsWith('/api/media/exists')) {
        return Promise.resolve(new Response(JSON.stringify({ have: [], missing: [hash] })));
      }
      return Promise.resolve(new Response(JSON.stringify({ hash: 'b'.repeat(64) }), { status: 200 }));
    }));

    await expect(uploadPendingMedia('', 'token')).resolves.toEqual({ uploaded: 0, failed: 1 });
    await expect(db.media.get(hash)).resolves.toMatchObject({ synced: 0 });
  });
});

describe('Paginierte Remote-Medienbereinigung', () => {
  it('meldet einen Teilzyklus erst nach dem Sweep als vollständig', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        phase: 'scan',
        complete: false,
        readyToSweep: false,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        phase: 'sweep',
        complete: true,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(garbageCollectRemoteMedia('', 'token')).resolves.toEqual({
      available: true,
      complete: false,
    });
    await expect(garbageCollectRemoteMedia('', 'token')).resolves.toEqual({
      available: true,
      complete: true,
    });
  });

  it('unterscheidet deaktiviertes R2 und alte vollständige Worker-Antworten', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'disabled' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ deleted: 0 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(garbageCollectRemoteMedia('', 'token')).resolves.toEqual({
      available: false,
      complete: false,
    });
    await expect(garbageCollectRemoteMedia('', 'token')).resolves.toEqual({
      available: true,
      complete: true,
    });
  });
});


describe('Medien aus Kartenvorlagen', () => {
  async function addTemplate(hash: string): Promise<void> {
    await db.noteTypes.add({
      id: 'template-only', name: 'Vorlage', kind: 'standard', fields: ['Front'],
      templates: [{ name: 'Karte', qfmt: `<img src="flashmedia:${hash}">{{Front}}`, afmt: '{{FrontSide}}' }],
      css: '', updatedAt: 1,
    });
  }

  it('revalidiert ein ausschließlich in der Vorlage referenziertes Bild', async () => {
    const hash = 'e'.repeat(64);
    await addTemplate(hash);
    await db.media.add(makeMedia(hash, 1));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      have: [], missing: [hash],
    })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(revalidateReferencedMedia('', 'token')).resolves.toEqual({ reset: 1, complete: true });
    await expect(db.media.get(hash)).resolves.toMatchObject({ synced: 0 });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ hashes: [hash] });
  });

  it('lädt Vorlagenbilder auf einem anderen Gerät auch ohne Bildreferenz in Notizfeldern', async () => {
    const bytes = 'template image bytes';
    const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>('node:crypto');
    const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(bytes));
    const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    await addTemplate(hash);
    vi.stubGlobal('crypto', webcrypto);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes, {
      headers: { 'Content-Type': 'image/webp' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(downloadReferencedMedia('', 'token')).resolves.toEqual({ downloaded: 1, pending: 0 });
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/media/${hash}`);
    await expect(db.media.get(hash)).resolves.toMatchObject({ hash, synced: 1 });
  });
});

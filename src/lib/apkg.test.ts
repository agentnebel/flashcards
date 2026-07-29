import 'fake-indexeddb/auto';
import { zipSync } from 'fflate';
import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/db';
import { importApkg, prepareApkgMedia } from './apkg';

vi.mock('sql.js', async () => {
  return vi.importActual<typeof import('sql.js')>('sql.js/dist/sql-asm.js');
});

beforeEach(async () => {
  await db.transaction('rw', db.tables, async () => {
    await Promise.all(db.tables.map((table) => table.clear()));
  });
});

async function makeApkg({
  models,
  notes,
  media = {},
  mediaManifest,
}: {
  models: unknown;
  notes: Array<[string, number | string, string]>;
  media?: Record<string, Uint8Array>;
  mediaManifest?: Record<string, string>;
}): Promise<File> {
  const SQL = await initSqlJs();
  const collection = new SQL.Database();
  collection.run('CREATE TABLE col (models TEXT NOT NULL)');
  collection.run('INSERT INTO col (models) VALUES (?)', [JSON.stringify(models)]);
  collection.run('CREATE TABLE notes (guid TEXT NOT NULL, mid INTEGER NOT NULL, flds TEXT NOT NULL)');
  for (const [guid, mid, fields] of notes) {
    collection.run(
      'INSERT INTO notes (guid, mid, flds) VALUES (?, ?, ?)',
      [guid, mid, fields],
    );
  }
  const sqliteBytes = collection.export();
  collection.close();

  const entries: Record<string, Uint8Array> = {
    'collection.anki2': sqliteBytes,
    ...media,
  };
  if (mediaManifest) {
    entries.media = new TextEncoder().encode(JSON.stringify(mediaManifest));
  }
  const archive = zipSync(entries);
  return new File([new Uint8Array(archive)], 'minimal.apkg', {
    type: 'application/octet-stream',
  });
}

function basicModels(qfmt: unknown = '{{Front}}'): unknown {
  return {
    1: {
      name: 'Minimal',
      type: 0,
      css: '.card { color: black; }',
      flds: [
        { name: 'Front', ord: 0 },
        { name: 'Back', ord: 1 },
      ],
      tmpls: [{
        name: 'Karte 1',
        qfmt,
        afmt: '{{FrontSide}}<hr>{{Back}}',
        ord: 0,
      }],
    },
  };
}

async function minimalApkg(): Promise<File> {
  return makeApkg({
    models: basicModels(),
    notes: [['minimal-guid', 1, 'Frage\u001fAntwort']],
  });
}

async function addTargetDeck(): Promise<void> {
  await db.decks.add({
    id: 'target-deck',
    name: 'Importziel',
    parentId: null,
    newPerDay: 20,
    updatedAt: 1,
  });
}

describe('prepareApkgMedia', () => {
  it('akzeptiert kleine unterstützte Rasterbilder unverändert', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const result = await prepareApkgMedia('karte.png', bytes);

    expect(result).toMatchObject({
      ok: true,
      mime: 'image/png',
      normalized: false,
    });
    if (result.ok) expect(result.blob.size).toBe(bytes.byteLength);
  });

  it('überspringt SVG und unbekannte Formate ohne Normalisierungsversuch', async () => {
    const normalizeImage = vi.fn();

    await expect(
      prepareApkgMedia('diagramm.svg', new Uint8Array([1]), { normalizeImage }),
    ).resolves.toEqual({ ok: false, reason: 'svg' });
    await expect(
      prepareApkgMedia('anhang.bin', new Uint8Array([1]), { normalizeImage }),
    ).resolves.toEqual({ ok: false, reason: 'unsupported' });
    expect(normalizeImage).not.toHaveBeenCalled();
  });

  it('normalisiert ein übergroßes Rasterbild auf den Upload-Vertrag', async () => {
    const normalizedBlob = new Blob([new Uint8Array([9, 8])], { type: 'image/webp' });
    const normalizeImage = vi.fn().mockResolvedValue({
      blob: normalizedBlob,
      mime: 'image/webp',
      width: 800,
      height: 600,
    });

    const result = await prepareApkgMedia(
      'gross.jpg',
      new Uint8Array([1, 2, 3, 4, 5]),
      { maxBytes: 4, normalizeImage },
    );

    expect(normalizeImage).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: true,
      blob: normalizedBlob,
      mime: 'image/webp',
      width: 800,
      height: 600,
      normalized: true,
    });
  });

  it('speichert ein weiterhin übergroßes oder nicht dekodierbares Bild nicht', async () => {
    const stillLarge = vi.fn().mockResolvedValue({
      blob: new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'image/webp' }),
      mime: 'image/webp',
      width: 10,
      height: 10,
    });
    const decodeError = vi.fn().mockRejectedValue(new Error('decode failed'));

    await expect(
      prepareApkgMedia('gross.png', new Uint8Array([1, 2, 3, 4, 5]), {
        maxBytes: 4,
        normalizeImage: stillLarge,
      }),
    ).resolves.toEqual({ ok: false, reason: 'still-too-large' });
    await expect(
      prepareApkgMedia('gross.png', new Uint8Array([1, 2, 3, 4, 5]), {
        maxBytes: 4,
        normalizeImage: decodeError,
      }),
    ).resolves.toEqual({ ok: false, reason: 'normalization-failed' });
  });
});

describe('importApkg', () => {
  it('importiert ein minimales echtes SQLite-Paket atomar in alle lokalen Tabellen', async () => {
    await addTargetDeck();

    const result = await importApkg(await minimalApkg(), 'target-deck');

    expect(result).toEqual({
      noteTypes: 1,
      notes: 1,
      cards: 1,
      media: 0,
      warnings: [],
    });
    const [noteTypes, notes, cards, outbox] = await Promise.all([
      db.noteTypes.toArray(),
      db.notes.toArray(),
      db.cards.toArray(),
      db.outbox.orderBy('id').toArray(),
    ]);
    expect(noteTypes).toHaveLength(1);
    expect(noteTypes[0]).toMatchObject({
      name: 'Minimal',
      fields: ['Front', 'Back'],
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      guid: 'minimal-guid',
      noteTypeId: noteTypes[0].id,
      deckId: 'target-deck',
      fields: { Front: 'Frage', Back: 'Antwort' },
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      noteId: notes[0].id,
      noteTypeId: noteTypes[0].id,
      deckId: 'target-deck',
      templateOrd: 0,
    });
    expect(outbox.map(({ entity, entityId }) => ({ entity, entityId }))).toEqual([
      { entity: 'noteType', entityId: noteTypes[0].id },
      { entity: 'note', entityId: notes[0].id },
      { entity: 'card', entityId: cards[0].id },
    ]);
  });

  it('lehnt malformed Model-Daten vor jedem IndexedDB-Write ab', async () => {
    await addTargetDeck();
    const malformed = await makeApkg({
      models: basicModels(null),
      notes: [['malformed-guid', 1, 'Frage\u001fAntwort']],
      media: { 0: new Uint8Array([1, 2, 3]) },
      mediaManifest: { 0: 'bild.png' },
    });

    await expect(importApkg(malformed, 'target-deck'))
      .rejects.toThrow(/Ungültige Vorlage/);

    await expect(Promise.all([
      db.noteTypes.count(),
      db.notes.count(),
      db.cards.count(),
      db.media.count(),
      db.outbox.count(),
    ])).resolves.toEqual([0, 0, 0, 0, 0]);
  });

  it('rollt Medien, Notiztypen und Notizen zurück, wenn der atomare Commit scheitert', async () => {
    await addTargetDeck();
    const packageWithMedia = await makeApkg({
      models: basicModels(),
      notes: [[
        'rollback-guid',
        1,
        '<img src="bild.png">Frage\u001fAntwort',
      ]],
      media: { 0: new Uint8Array([1, 2, 3]) },
      mediaManifest: { 0: 'bild.png' },
    });
    const cardWrite = vi.spyOn(db.cards, 'bulkAdd')
      .mockRejectedValueOnce(new Error('simulierter Karten-Write-Fehler'));

    try {
      await expect(importApkg(packageWithMedia, 'target-deck'))
        .rejects.toThrow(/simulierter Karten-Write-Fehler/);
    } finally {
      cardWrite.mockRestore();
    }

    await expect(Promise.all([
      db.noteTypes.count(),
      db.notes.count(),
      db.cards.count(),
      db.media.count(),
      db.outbox.count(),
    ])).resolves.toEqual([0, 0, 0, 0, 0]);
  });

  it('committet keine Medien, wenn alle referenzierenden Notizen übersprungen werden', async () => {
    await addTargetDeck();
    await db.notes.add({
      id: 'existing-note',
      guid: 'duplicate-guid',
      noteTypeId: 'existing-type',
      deckId: 'target-deck',
      fields: { Front: 'Vorhanden', Back: 'Antwort' },
      tags: [],
      sortField: 'Vorhanden',
      updatedAt: 1,
    });
    const duplicateOnly = await makeApkg({
      models: basicModels(),
      notes: [[
        'duplicate-guid',
        1,
        '<img src="bild.png">Frage\u001fAntwort',
      ]],
      media: { 0: new Uint8Array([1, 2, 3]) },
      mediaManifest: { 0: 'bild.png' },
    });

    const result = await importApkg(duplicateOnly, 'target-deck');

    expect(result).toMatchObject({ noteTypes: 0, notes: 0, cards: 0, media: 0 });
    await expect(db.media.count()).resolves.toBe(0);
    await expect(db.outbox.count()).resolves.toBe(0);
  });
});

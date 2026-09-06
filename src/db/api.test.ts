import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyCard } from '../scheduler/fsrs';
import {
  deleteDeck,
  deleteNote,
  exportBackupArchive,
  getReviewStreak,
  importBackup,
  importBackupFile,
  addNote,
  updateNote,
  gcOrphanedMedia,
  commitReview,
  ReviewConflictError,
} from './api';
import { db, type Card, type Deck, type Media, type Note, type NoteType, type RevlogEntry } from './db';
import type { RecordLogItem } from 'ts-fsrs';

function makeDeck(id: string, parentId: string | null = null): Deck {
  return { id, name: id, parentId, newPerDay: 20, updatedAt: 1 };
}

function makeNote(id: string, deckId: string): Note {
  return {
    id,
    guid: `guid-${id}`,
    noteTypeId: 'basic',
    deckId,
    fields: { Front: id, Back: 'Antwort' },
    tags: [],
    sortField: id,
    updatedAt: 1,
  };
}

function makeCard(id: string, noteId: string, deckId: string): Card {
  const fsrs = createEmptyCard(new Date('2026-07-11T12:00:00Z'));
  return {
    id,
    noteId,
    deckId,
    noteTypeId: 'basic',
    templateOrd: 0,
    clozeNum: null,
    fsrs,
    due: fsrs.due,
    suspended: 0,
    updatedAt: 1,
  };
}

function makeRevlog(id: string, cardId: string): RevlogEntry {
  return {
    id,
    cardId,
    rating: 3,
    state: 2,
    due: new Date('2026-07-12T12:00:00Z'),
    stability: 1,
    difficulty: 5,
    elapsedDays: 1,
    lastElapsedDays: 1,
    scheduledDays: 1,
    reviewedAt: Date.parse('2026-07-11T12:00:00Z'),
  };
}

beforeEach(async () => {
  await db.transaction('rw', db.tables, async () => {
    await Promise.all(db.tables.map((table) => table.clear()));
  });
});

describe('Entwurfsbilder und Vorlagenbilder', () => {
  const hash = 'a'.repeat(64);
  const type: NoteType = {
    id: 'basic', name: 'Einfach', kind: 'standard', fields: ['Front', 'Back'],
    templates: [{ name: 'Karte', qfmt: '{{Front}}', afmt: '{{Back}}' }], css: '', updatedAt: 1,
  };
  const image: Media = {
    hash, blob: new Blob(['draft-image']), mime: 'image/png', size: 11,
    width: 1, height: 1, createdAt: 1, synced: 0,
  };

  it.each(['neu', 'bearbeiten'] as const)('speichert bereinigte Entwurfsbilder atomar mit der Notiz: %s', async (mode) => {
    await db.decks.add(makeDeck('deck'));
    await db.noteTypes.add(type);
    if (mode === 'bearbeiten') await addNote({ deckId: 'deck', noteTypeId: type.id, fields: { Front: 'Vorher' } });
    await db.media.add(image);
    // Ein anderer Tab bereinigt den Blob, bevor der Entwurf gespeichert wird.
    expect(await gcOrphanedMedia()).toBe(1);
    const fields = { Front: `<img src="flashmedia:${hash}">`, Back: 'Antwort' };
    if (mode === 'neu') {
      await addNote({ deckId: 'deck', noteTypeId: type.id, fields, draftMedia: [image] });
    } else {
      const note = await db.notes.toCollection().first();
      await updateNote(note!.id, fields, undefined, undefined, [image]);
    }
    expect((await db.notes.toCollection().first())?.fields).toEqual(fields);
    expect(await db.media.get(hash)).toMatchObject({ hash, size: 11, synced: 0 });
    expect(await gcOrphanedMedia()).toBe(0);
  });

  it('bewahrt vorhandenen Sync-Status und speichert keine aus dem Entwurf entfernten Bilder', async () => {
    await db.decks.add(makeDeck('deck'));
    await db.noteTypes.add(type);
    await db.media.add({ ...image, synced: 1 });
    const removedImage = { ...image, hash: 'b'.repeat(64) };
    await addNote({
      deckId: 'deck', noteTypeId: type.id, fields: { Front: `<img src="flashmedia:${hash}">` },
      draftMedia: [image, removedImage],
    });
    expect((await db.media.get(hash))?.synced).toBe(1);
    expect(await db.media.get(removedImage.hash)).toBeUndefined();
  });

  it('behält Bilder, die ausschließlich in einer Kartenvorlage referenziert werden', async () => {
    await db.media.add(image);
    await db.noteTypes.add({ ...type, templates: [{ name: 'Bild', qfmt: `<img src="flashmedia:${hash}">`, afmt: '' }] });
    expect(await gcOrphanedMedia()).toBe(0);
    expect(await db.media.get(hash)).toBeDefined();
  });
});

describe('Versionskonflikte beim Lernen', () => {
  it('signalisiert veraltete oder gelöschte Karten ohne Lernhistorie zu verändern', async () => {
    const stale = makeCard('card', 'note', 'deck');
    const item = { card: stale.fsrs, log: { review: new Date() } } as RecordLogItem;
    await db.cards.add({ ...stale, updatedAt: stale.updatedAt + 1 });
    await expect(commitReview(stale, item)).rejects.toBeInstanceOf(ReviewConflictError);
    await db.cards.delete(stale.id);
    await expect(commitReview(stale, item)).rejects.toBeInstanceOf(ReviewConflictError);
    expect(await db.revlog.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });
});

describe('vollständige Löschvorgänge', () => {
  it('löscht ein Deck inklusive Unterdecks, Inhalten und Lernhistorie', async () => {
    await db.decks.bulkAdd([
      makeDeck('parent'),
      makeDeck('child', 'parent'),
      makeDeck('unrelated'),
    ]);
    await db.notes.bulkAdd([
      makeNote('note-child', 'child'),
      makeNote('note-unrelated', 'unrelated'),
    ]);
    await db.cards.bulkAdd([
      makeCard('card-child', 'note-child', 'child'),
      makeCard('card-unrelated', 'note-unrelated', 'unrelated'),
    ]);
    await db.revlog.bulkAdd([
      makeRevlog('rev-child', 'card-child'),
      makeRevlog('rev-unrelated', 'card-unrelated'),
    ]);

    await deleteDeck('parent');

    await expect(db.decks.toCollection().primaryKeys()).resolves.toEqual(['unrelated']);
    await expect(db.notes.toCollection().primaryKeys()).resolves.toEqual(['note-unrelated']);
    await expect(db.cards.toCollection().primaryKeys()).resolves.toEqual(['card-unrelated']);
    await expect(db.revlog.toCollection().primaryKeys()).resolves.toEqual(['rev-unrelated']);

    const tombstones = await db.outbox.filter((item) => item.op === 'delete').toArray();
    expect(tombstones.map(({ entity, entityId }) => `${entity}:${entityId}`)).toEqual(expect.arrayContaining([
      'deck:parent',
      'deck:child',
      'note:note-child',
      'card:card-child',
      'revlog:rev-child',
    ]));
  });

  it('löscht bei einer einzelnen Notiz ebenfalls Karten und Lernhistorie', async () => {
    await db.notes.add(makeNote('note', 'deck'));
    await db.cards.add(makeCard('card', 'note', 'deck'));
    await db.revlog.add(makeRevlog('rev', 'card'));

    await deleteNote('note');

    await expect(db.notes.count()).resolves.toBe(0);
    await expect(db.cards.count()).resolves.toBe(0);
    await expect(db.revlog.count()).resolves.toBe(0);
  });
});

describe('Backup-Wiederherstellung', () => {
  it('stempelt alle konfliktfähigen Entitäten und ihre Outbox-Payloads einheitlich neu', async () => {
    const restoredAt = Date.parse('2026-07-29T10:00:00Z');
    const now = vi.spyOn(Date, 'now').mockReturnValue(restoredAt);
    const deck = makeDeck('restored-deck');
    const note = makeNote('restored-note', deck.id);
    const card = makeCard('restored-card', note.id, deck.id);
    const noteType: NoteType = {
      id: 'basic',
      name: 'Einfach',
      kind: 'standard',
      fields: ['Front', 'Back'],
      templates: [{ name: 'Karte 1', qfmt: '{{Front}}', afmt: '{{Back}}' }],
      css: '',
      updatedAt: 1,
    };

    try {
      await importBackup(JSON.stringify({
        decks: [deck],
        noteTypes: [noteType],
        notes: [note],
        cards: [card],
      }));

      const restored = await Promise.all([
        db.decks.get(deck.id),
        db.noteTypes.get(noteType.id),
        db.notes.get(note.id),
        db.cards.get(card.id),
      ]);
      expect(restored.map((row) => row?.updatedAt)).toEqual([
        restoredAt,
        restoredAt,
        restoredAt,
        restoredAt,
      ]);

      const outbox = await db.outbox.orderBy('id').toArray();
      expect(outbox).toHaveLength(4);
      expect(outbox.map((item) => item.createdAt)).toEqual([
        restoredAt,
        restoredAt,
        restoredAt,
        restoredAt,
      ]);
      expect(outbox.map((item) => (item.payload as { updatedAt: number }).updatedAt)).toEqual([
        restoredAt,
        restoredAt,
        restoredAt,
        restoredAt,
      ]);
    } finally {
      now.mockRestore();
    }
  });

  it('exportiert und importiert ein vollständiges ZIP-Backup ohne Base64-Limitbruch', async () => {
    const deck = makeDeck('archive-deck');
    const note = makeNote('archive-note', deck.id);
    const bytes = new TextEncoder().encode('backup-image');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    await db.decks.add(deck);
    await db.notes.add(note);
    const mediaRow = {
      hash,
      blob: new Blob([bytes], { type: 'image/png' }),
      mime: 'image/png',
      size: bytes.byteLength,
      width: 2,
      height: 3,
      createdAt: 1,
      synced: 1 as const,
    };
    // fake-indexeddb serialisiert jsdom-Blobs nicht bytegetreu. Für den Exportpfad
    // das echte Browser-Blob liefern; der produktive IndexedDB-Pfad behält es ebenfalls.
    const mediaRows = vi.spyOn(db.media, 'toArray').mockResolvedValue([mediaRow]);

    const archive = await exportBackupArchive();
    mediaRows.mockRestore();
    expect(archive.type).toBe('application/zip');
    await db.transaction('rw', db.tables, async () => {
      await Promise.all(db.tables.map((table) => table.clear()));
    });

    const result = await importBackupFile(
      new File([archive], 'backup.flashcards.zip', { type: 'application/zip' }),
    );

    expect(result).toMatchObject({ decks: 1, notes: 1, media: 1 });
    await expect(db.decks.get(deck.id)).resolves.toMatchObject({ id: deck.id });
    await expect(db.notes.get(note.id)).resolves.toMatchObject({ id: note.id });
    const restoredMedia = await db.media.get(hash);
    expect(restoredMedia).toMatchObject({
      hash,
      mime: 'image/png',
      width: 2,
      height: 3,
      synced: 0,
      size: bytes.byteLength,
    });
  });
});

describe('Lern-Streak', () => {
  // Lokale Tagesmitte n Tage vor heute — explizite Kalenderarithmetik statt 24h-Offsets,
  // damit die Tests auch über Zeitumstellungen hinweg deterministisch bleiben.
  function dayAt(daysAgo: number): number {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - daysAgo);
    return d.getTime();
  }

  it('zählt zusammenhängende Tage inklusive heute', async () => {
    await db.revlog.bulkAdd([
      { ...makeRevlog('r0', 'c1'), reviewedAt: dayAt(0) },
      { ...makeRevlog('r1', 'c1'), reviewedAt: dayAt(1) },
      { ...makeRevlog('r2', 'c1'), reviewedAt: dayAt(2) },
    ]);
    await expect(getReviewStreak()).resolves.toBe(3);
  });

  it('behält den Streak bis Tagesende, wenn heute noch nichts gelernt wurde', async () => {
    await db.revlog.bulkAdd([
      { ...makeRevlog('r1', 'c1'), reviewedAt: dayAt(1) },
      { ...makeRevlog('r2', 'c1'), reviewedAt: dayAt(2) },
    ]);
    await expect(getReviewStreak()).resolves.toBe(2);
  });

  it('bricht am ersten Tag ohne Review ab', async () => {
    await db.revlog.bulkAdd([
      { ...makeRevlog('r0', 'c1'), reviewedAt: dayAt(0) },
      { ...makeRevlog('r2', 'c1'), reviewedAt: dayAt(2) },
    ]);
    await expect(getReviewStreak()).resolves.toBe(1);
  });

  it('liefert 0 ohne Reviews heute und gestern', async () => {
    await db.revlog.add({ ...makeRevlog('r2', 'c1'), reviewedAt: dayAt(2) });
    await expect(getReviewStreak()).resolves.toBe(0);
    await db.revlog.clear();
    await expect(getReviewStreak()).resolves.toBe(0);
  });
});

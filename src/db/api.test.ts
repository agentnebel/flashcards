import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyCard } from '../scheduler/fsrs';
import {
  deleteDeck,
  deleteNote,
  exportBackupArchive,
  importBackup,
  importBackupFile,
} from './api';
import { db, type Card, type Deck, type Note, type NoteType, type RevlogEntry } from './db';

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

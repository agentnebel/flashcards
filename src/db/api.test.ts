import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyCard } from '../scheduler/fsrs';
import { deleteDeck, deleteNote } from './api';
import { db, type Card, type Deck, type Note, type RevlogEntry } from './db';

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

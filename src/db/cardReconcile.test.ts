import { describe, expect, it } from 'vitest';
import type { Card, Note, NoteType } from './db';
import { createEmptyCard } from '../scheduler/fsrs';
import { reconcileCardsForNote } from './cardReconcile';

const clozeNt: NoteType = {
  id: 'nt-cloze',
  name: 'Cloze',
  kind: 'cloze',
  fields: ['Text', 'Extra'],
  templates: [{ name: 'Cloze', qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<hr>{{Extra}}' }],
  css: '',
  updatedAt: 0,
};

function makeNote(text: string, deckId = 'deck-a'): Note {
  return {
    id: 'note-1',
    guid: 'guid-1',
    noteTypeId: clozeNt.id,
    deckId,
    fields: { Text: text, Extra: '' },
    tags: [],
    sortField: text,
    updatedAt: 100,
  };
}

function makeCard(id: string, clozeNum: number, deckId = 'deck-a'): Card {
  const fsrs = createEmptyCard(new Date('2026-07-03T08:00:00Z'));
  return {
    id,
    noteId: 'note-1',
    deckId,
    noteTypeId: clozeNt.id,
    templateOrd: 0,
    clozeNum,
    fsrs,
    due: fsrs.due,
    suspended: 0,
    updatedAt: 10,
  };
}

describe('reconcileCardsForNote', () => {
  it('adds new cloze cards without rewriting retained cards', () => {
    const existing = makeCard('card-c1', 1);
    const result = reconcileCardsForNote(makeNote('{{c1::a}} {{c2::b}}'), clozeNt, [existing], 200);

    expect(result.remove).toEqual([]);
    expect(result.upsert).toHaveLength(1);
    expect(result.upsert[0]).toMatchObject({ noteId: 'note-1', deckId: 'deck-a', clozeNum: 2 });
    expect(result.upsert[0].id).not.toBe(existing.id);
  });

  it('removes stale cloze cards when a deletion disappears', () => {
    const c1 = makeCard('card-c1', 1);
    const c2 = makeCard('card-c2', 2);
    const result = reconcileCardsForNote(makeNote('{{c1::a}}'), clozeNt, [c1, c2], 200);

    expect(result.upsert).toEqual([]);
    expect(result.remove.map((c) => c.id)).toEqual(['card-c2']);
  });

  it('moves retained cards to a new deck while preserving scheduling state', () => {
    const existing = makeCard('card-c1', 1);
    const result = reconcileCardsForNote(makeNote('{{c1::a}}', 'deck-b'), clozeNt, [existing], 200);

    expect(result.remove).toEqual([]);
    expect(result.upsert).toHaveLength(1);
    expect(result.upsert[0]).toMatchObject({ id: 'card-c1', deckId: 'deck-b', updatedAt: 200 });
    expect(result.upsert[0].fsrs).toBe(existing.fsrs);
  });

  it('removes duplicate cards for the same generated card identity', () => {
    const first = makeCard('card-c1-a', 1);
    const duplicate = makeCard('card-c1-b', 1);
    const result = reconcileCardsForNote(makeNote('{{c1::a}}'), clozeNt, [first, duplicate], 200);

    expect(result.upsert).toEqual([]);
    expect(result.remove.map((c) => c.id)).toEqual(['card-c1-b']);
  });
});

import { db, type Card, type Deck, type Note, type NoteType, type RevlogEntry } from './db';
import { createEmptyCard, makeScheduler } from '../scheduler/fsrs';
import { Rating } from 'ts-fsrs';
import type { Grade } from 'ts-fsrs';
import { generateCards } from '../lib/cardgen';
import { uuid } from './ids';

export async function getDesiredRetention(): Promise<number> {
  const m = await db.meta.get('desiredRetention');
  return typeof m?.value === 'number' ? (m.value as number) : 0.9;
}

export async function setDesiredRetention(v: number): Promise<void> {
  await db.meta.put({ key: 'desiredRetention', value: v });
}

export async function createDeck(name: string): Promise<string> {
  const id = uuid();
  const now = Date.now();
  const deck: Deck = { id, name, parentId: null, newPerDay: 20, updatedAt: now, usn: -1 };
  await db.transaction('rw', db.decks, db.outbox, async () => {
    await db.decks.add(deck);
    await db.outbox.add({ op: 'upsert', entity: 'deck', entityId: id, payload: deck, createdAt: now });
  });
  return id;
}

export async function addNote(params: {
  noteTypeId: string;
  deckId: string;
  fields: Record<string, string>;
  tags?: string[];
}): Promise<void> {
  const nt = await db.noteTypes.get(params.noteTypeId);
  if (!nt) throw new Error('Notiztyp nicht gefunden');
  const id = uuid();
  const now = Date.now();
  const sortField = params.fields[nt.fields[0]] ?? '';
  const note: Note = {
    id,
    guid: uuid(),
    noteTypeId: nt.id,
    deckId: params.deckId,
    fields: params.fields,
    tags: params.tags ?? [],
    sortField,
    updatedAt: now,
    usn: -1,
  };
  const cards: Card[] = generateCards(note, nt).map((s) => {
    const fsrs = createEmptyCard(new Date());
    return {
      id: uuid(),
      noteId: id,
      deckId: params.deckId,
      noteTypeId: nt.id,
      templateOrd: s.templateOrd,
      clozeNum: s.clozeNum,
      fsrs,
      due: fsrs.due,
      suspended: 0,
      updatedAt: now,
      usn: -1,
    };
  });
  await db.transaction('rw', db.notes, db.cards, db.outbox, async () => {
    await db.notes.add(note);
    await db.cards.bulkAdd(cards);
    await db.outbox.add({ op: 'upsert', entity: 'note', entityId: id, payload: note, createdAt: now });
    for (const c of cards) {
      await db.outbox.add({ op: 'upsert', entity: 'card', entityId: c.id, payload: c, createdAt: now });
    }
  });
}

export async function deleteNote(noteId: string): Promise<void> {
  const now = Date.now();
  const cards = await db.cards.where('noteId').equals(noteId).toArray();
  await db.transaction('rw', db.notes, db.cards, db.outbox, async () => {
    await db.notes.delete(noteId);
    await db.cards.where('noteId').equals(noteId).delete();
    await db.outbox.add({ op: 'delete', entity: 'note', entityId: noteId, payload: null, createdAt: now });
    for (const c of cards) {
      await db.outbox.add({ op: 'delete', entity: 'card', entityId: c.id, payload: null, createdAt: now });
    }
  });
}

// Lernschlange: fällige Lern-/Review-Karten zuerst, dann limitierte neue Karten.
export async function getStudyQueue(deckId: string, newLimit = 20): Promise<Card[]> {
  const now = new Date();
  const all = await db.cards.where('deckId').equals(deckId).toArray();
  const active = all.filter((c) => !c.suspended && !c.deleted);
  const due = active
    .filter((c) => c.fsrs.state !== 0 && c.due <= now)
    .sort((a, b) => a.due.getTime() - b.due.getTime());
  const fresh = active.filter((c) => c.fsrs.state === 0).slice(0, newLimit);
  return [...due, ...fresh];
}

export interface QueueCounts {
  due: number;
  fresh: number;
}

export async function deckCounts(deckId: string): Promise<QueueCounts> {
  const now = new Date();
  const all = await db.cards.where('deckId').equals(deckId).toArray();
  const active = all.filter((c) => !c.suspended && !c.deleted);
  return {
    due: active.filter((c) => c.fsrs.state !== 0 && c.due <= now).length,
    fresh: active.filter((c) => c.fsrs.state === 0).length,
  };
}

// Vorschau der nächsten Fälligkeit je Bewertung (für die Antwort-Buttons).
export function previewDueDates(card: Card, retention: number): Record<number, Date> {
  const f = makeScheduler(retention);
  const rec = f.repeat(card.fsrs, new Date());
  return {
    [Rating.Again]: rec[Rating.Again].card.due,
    [Rating.Hard]: rec[Rating.Hard].card.due,
    [Rating.Good]: rec[Rating.Good].card.due,
    [Rating.Easy]: rec[Rating.Easy].card.due,
  };
}

export async function answerCard(card: Card, rating: Grade, retention: number): Promise<void> {
  const f = makeScheduler(retention);
  const now = new Date();
  const { card: next, log } = f.next(card.fsrs, now, rating);
  const updated: Card = { ...card, fsrs: next, due: next.due, updatedAt: now.getTime(), usn: -1 };
  const rev: RevlogEntry = {
    id: uuid(),
    cardId: card.id,
    rating,
    state: log.state,
    due: log.due,
    stability: log.stability,
    difficulty: log.difficulty,
    elapsedDays: log.elapsed_days,
    lastElapsedDays: log.last_elapsed_days,
    scheduledDays: log.scheduled_days,
    reviewedAt: now.getTime(),
  };
  await db.transaction('rw', db.cards, db.revlog, db.outbox, async () => {
    await db.cards.put(updated);
    await db.revlog.add(rev);
    await db.outbox.add({ op: 'upsert', entity: 'card', entityId: card.id, payload: updated, createdAt: now.getTime() });
    await db.outbox.add({ op: 'upsert', entity: 'revlog', entityId: rev.id, payload: rev, createdAt: now.getTime() });
  });
}

export async function setSuspended(cardId: string, suspended: 0 | 1): Promise<void> {
  const card = await db.cards.get(cardId);
  if (!card) return;
  const updated = { ...card, suspended, updatedAt: Date.now(), usn: -1 };
  await db.cards.put(updated);
  await db.outbox.add({ op: 'upsert', entity: 'card', entityId: cardId, payload: updated, createdAt: Date.now() });
}

export async function exportBackup(): Promise<string> {
  const [decks, noteTypes, notes, cards, revlog] = await Promise.all([
    db.decks.toArray(),
    db.noteTypes.toArray(),
    db.notes.toArray(),
    db.cards.toArray(),
    db.revlog.toArray(),
  ]);
  return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), decks, noteTypes, notes, cards, revlog }, null, 2);
}

export type { NoteType };

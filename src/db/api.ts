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

export async function renameDeck(deckId: string, name: string): Promise<void> {
  const deck = await db.decks.get(deckId);
  if (!deck) return;
  const now = Date.now();
  const updated: Deck = { ...deck, name, updatedAt: now, usn: -1 };
  await db.transaction('rw', db.decks, db.outbox, async () => {
    await db.decks.put(updated);
    await db.outbox.add({ op: 'upsert', entity: 'deck', entityId: deckId, payload: updated, createdAt: now });
  });
}

export async function deleteDeck(deckId: string): Promise<void> {
  const now = Date.now();
  const notes = await db.notes.where('deckId').equals(deckId).toArray();
  const cards = await db.cards.where('deckId').equals(deckId).toArray();
  await db.transaction('rw', db.decks, db.notes, db.cards, db.outbox, async () => {
    await db.decks.delete(deckId);
    await db.notes.where('deckId').equals(deckId).delete();
    await db.cards.where('deckId').equals(deckId).delete();
    await db.outbox.add({ op: 'delete', entity: 'deck', entityId: deckId, payload: null, createdAt: now });
    for (const n of notes) {
      await db.outbox.add({ op: 'delete', entity: 'note', entityId: n.id, payload: null, createdAt: now });
    }
    for (const c of cards) {
      await db.outbox.add({ op: 'delete', entity: 'card', entityId: c.id, payload: null, createdAt: now });
    }
  });
}

export async function updateNote(
  noteId: string,
  fields: Record<string, string>,
  newDeckId?: string,
): Promise<void> {
  const note = await db.notes.get(noteId);
  if (!note) return;
  const nt = await db.noteTypes.get(note.noteTypeId);
  if (!nt) return;
  const now = Date.now();
  const deckId = newDeckId ?? note.deckId;
  const updated: Note = { ...note, fields, sortField: fields[nt.fields[0]] ?? '', deckId, updatedAt: now, usn: -1 };
  const noteCards = await db.cards.where('noteId').equals(noteId).toArray();
  const updatedCards = noteCards.map((c) => ({ ...c, deckId, updatedAt: now, usn: -1 as const }));
  await db.transaction('rw', db.notes, db.cards, db.outbox, async () => {
    await db.notes.put(updated);
    await db.outbox.add({ op: 'upsert', entity: 'note', entityId: noteId, payload: updated, createdAt: now });
    for (const c of updatedCards) {
      await db.cards.put(c);
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

// Massenimport (CSV/TSV): erzeugt Notizen + Karten + Outbox-Einträge in Batches.
export async function importNotes(params: {
  deckId: string;
  noteTypeId: string;
  rows: string[][];
  fieldMap: number[]; // Spaltenindex je Notiztyp-Feld, -1 = leer lassen
  hasHeader: boolean;
}): Promise<number> {
  const nt = await db.noteTypes.get(params.noteTypeId);
  if (!nt) throw new Error('Notiztyp nicht gefunden');
  const dataRows = params.hasHeader ? params.rows.slice(1) : params.rows;
  let imported = 0;
  const CHUNK = 200;
  for (let start = 0; start < dataRows.length; start += CHUNK) {
    const slice = dataRows.slice(start, start + CHUNK);
    await db.transaction('rw', db.notes, db.cards, db.outbox, async () => {
      const now = Date.now();
      for (const r of slice) {
        const fields: Record<string, string> = {};
        nt.fields.forEach((f, idx) => {
          const col = params.fieldMap[idx];
          fields[f] = col >= 0 ? (r[col] ?? '').trim() : '';
        });
        if (!Object.values(fields).some((v) => v.trim())) continue;
        const id = uuid();
        const note: Note = {
          id,
          guid: uuid(),
          noteTypeId: nt.id,
          deckId: params.deckId,
          fields,
          tags: [],
          sortField: fields[nt.fields[0]] ?? '',
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
        await db.notes.add(note);
        await db.cards.bulkAdd(cards);
        await db.outbox.add({ op: 'upsert', entity: 'note', entityId: id, payload: note, createdAt: now });
        for (const c of cards) {
          await db.outbox.add({ op: 'upsert', entity: 'card', entityId: c.id, payload: c, createdAt: now });
        }
        imported++;
      }
    });
  }
  return imported;
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

// Blob → base64 data URL (für vollständige, eigenständige Backups).
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('FileReader-Fehler'));
    reader.readAsDataURL(blob);
  });
}

export async function exportBackup(): Promise<string> {
  const [decks, noteTypes, notes, cards, revlog, mediaRows] = await Promise.all([
    db.decks.toArray(),
    db.noteTypes.toArray(),
    db.notes.toArray(),
    db.cards.toArray(),
    db.revlog.toArray(),
    db.media.toArray(),
  ]);
  // Medien als base64-Data-URLs einbetten, damit das Backup vollständig ist.
  const media = await Promise.all(
    mediaRows.map(async (m) => ({
      hash: m.hash,
      mime: m.mime,
      width: m.width,
      height: m.height,
      dataUrl: await blobToDataUrl(m.blob),
    })),
  );
  return JSON.stringify(
    { version: 1, exportedAt: new Date().toISOString(), decks, noteTypes, notes, cards, revlog, media },
    null,
    2,
  );
}

export type { NoteType };

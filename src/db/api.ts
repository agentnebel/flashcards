import { db, type Card, type Deck, type Media, type Note, type NoteType, type OutboxItem, type RevlogEntry } from './db';
import { createEmptyCard, makeScheduler } from '../scheduler/fsrs';
import type { RecordLog, RecordLogItem } from 'ts-fsrs';
import { generateCards } from '../lib/cardgen';
import { uuid } from './ids';

// FSRS verlangt request_retention in (0,1]; defensiv auf einen sinnvollen Bereich klemmen,
// damit ein korrupter/aus dem Sync stammender Wert den Scheduler nicht crasht.
function clampRetention(v: number): number {
  if (!Number.isFinite(v)) return 0.9;
  return Math.min(0.97, Math.max(0.7, v));
}

export async function getDesiredRetention(): Promise<number> {
  const m = await db.meta.get('desiredRetention');
  return clampRetention(typeof m?.value === 'number' ? (m.value as number) : 0.9);
}

export async function setDesiredRetention(v: number): Promise<void> {
  await db.meta.put({ key: 'desiredRetention', value: clampRetention(v) });
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
  await gcOrphanedMedia(); // jetzt unreferenzierte Bilder lokal entfernen
}

export async function updateNote(
  noteId: string,
  fields: Record<string, string>,
  newDeckId?: string,
  newNoteTypeId?: string,
): Promise<void> {
  const note = await db.notes.get(noteId);
  if (!note) return;
  const resolvedNoteTypeId = newNoteTypeId ?? note.noteTypeId;
  const nt = await db.noteTypes.get(resolvedNoteTypeId);
  if (!nt) return;
  const now = Date.now();
  const deckId = newDeckId ?? note.deckId;
  const updated: Note = { ...note, fields, noteTypeId: resolvedNoteTypeId, sortField: fields[nt.fields[0]] ?? '', deckId, updatedAt: now, usn: -1 };
  const existingCards = await db.cards.where('noteId').equals(noteId).toArray();

  if (resolvedNoteTypeId !== note.noteTypeId) {
    // Notiztyp gewechselt: alte Karten löschen + neue nach neuem Template generieren.
    // FSRS-Fortschritt der alten Karten geht verloren (analog zu Anki).
    const newCards: Card[] = generateCards(updated, nt).map((s) => {
      const fsrs = createEmptyCard(new Date());
      return {
        id: uuid(),
        noteId,
        deckId,
        noteTypeId: nt.id,
        templateOrd: s.templateOrd,
        clozeNum: s.clozeNum,
        fsrs,
        due: fsrs.due,
        suspended: 0,
        updatedAt: now,
        usn: -1 as const,
      };
    });
    await db.transaction('rw', db.notes, db.cards, db.outbox, async () => {
      await db.notes.put(updated);
      await db.outbox.add({ op: 'upsert', entity: 'note', entityId: noteId, payload: updated, createdAt: now });
      await db.cards.where('noteId').equals(noteId).delete();
      for (const c of existingCards) {
        await db.outbox.add({ op: 'delete', entity: 'card', entityId: c.id, payload: null, createdAt: now });
      }
      await db.cards.bulkAdd(newCards);
      for (const c of newCards) {
        await db.outbox.add({ op: 'upsert', entity: 'card', entityId: c.id, payload: c, createdAt: now });
      }
    });
  } else {
    // Gleichbleibender Notiztyp: Felder + Deck auf bestehenden Karten aktualisieren.
    const updatedCards = existingCards.map((c) => ({ ...c, deckId, updatedAt: now, usn: -1 as const }));
    await db.transaction('rw', db.notes, db.cards, db.outbox, async () => {
      await db.notes.put(updated);
      await db.outbox.add({ op: 'upsert', entity: 'note', entityId: noteId, payload: updated, createdAt: now });
      for (const c of updatedCards) {
        await db.cards.put(c);
        await db.outbox.add({ op: 'upsert', entity: 'card', entityId: c.id, payload: c, createdAt: now });
      }
    });
  }
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
  await gcOrphanedMedia(); // jetzt unreferenzierte Bilder lokal entfernen
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

// Lern-Streak: aufeinanderfolgende lokale Tage mit mindestens einem Review.
// Heute noch nichts gelernt? Streak bleibt bis Tagesende erhalten (ab gestern gezählt).
export async function getReviewStreak(): Promise<number> {
  const keys = (await db.revlog.orderBy('reviewedAt').keys()) as number[];
  if (keys.length === 0) return 0;
  const dayKey = (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  };
  const days = new Set(keys.map(dayKey));
  const cursor = new Date();
  if (!days.has(dayKey(cursor.getTime()))) {
    cursor.setDate(cursor.getDate() - 1);
    if (!days.has(dayKey(cursor.getTime()))) return 0;
  }
  let streak = 0;
  while (days.has(dayKey(cursor.getTime()))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

// Anzahl heute (lokaler Tag) bereits eingeführter neuer Karten dieses Decks.
// Die erste Bewertung einer neuen Karte hat im Revlog state === 0 (State.New).
async function newCardsIntroducedToday(deckCards: Card[]): Promise<number> {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const todays = await db.revlog.where('reviewedAt').aboveOrEqual(midnight.getTime()).toArray();
  if (todays.length === 0) return 0;
  const deckCardIds = new Set(deckCards.map((c) => c.id));
  const introduced = new Set<string>();
  for (const r of todays) {
    if (r.state === 0 && deckCardIds.has(r.cardId)) introduced.add(r.cardId);
  }
  return introduced.size;
}

// Deck-IDs eines Decks inkl. aller Unterdecks (parentId-Adjazenz). So schließt Lernen/Zählen
// eines Eltern-Decks die Karten der Kinder ein, statt sie stillschweigend zu überspringen.
async function descendantDeckIds(deckId: string): Promise<string[]> {
  const all = await db.decks.toArray();
  const childrenByParent = new Map<string, string[]>();
  for (const d of all) {
    if (d.parentId) {
      const arr = childrenByParent.get(d.parentId);
      if (arr) arr.push(d.id);
      else childrenByParent.set(d.parentId, [d.id]);
    }
  }
  const out = [deckId];
  const stack = [deckId];
  while (stack.length) {
    const cur = stack.pop() as string;
    for (const child of childrenByParent.get(cur) ?? []) {
      out.push(child);
      stack.push(child);
    }
  }
  return out;
}

// Lernschlange: fällige Lern-/Review-Karten zuerst, dann neue Karten bis zum Tageslimit
// (deck.newPerDay), abzüglich der heute bereits eingeführten neuen Karten. Inkl. Unterdecks.
export async function getStudyQueue(deckId: string): Promise<Card[]> {
  const now = new Date();
  const [deck, deckIds] = await Promise.all([db.decks.get(deckId), descendantDeckIds(deckId)]);
  const all = (await Promise.all(deckIds.map((id) => db.cards.where('deckId').equals(id).toArray()))).flat();
  const active = all.filter((c) => !c.suspended && !c.deleted);
  const due = active
    .filter((c) => c.fsrs.state !== 0 && c.due <= now)
    .sort((a, b) => a.due.getTime() - b.due.getTime());
  const perDay = typeof deck?.newPerDay === 'number' ? deck.newPerDay : 20;
  const remaining = Math.max(0, perDay - (await newCardsIntroducedToday(all)));
  const fresh = active.filter((c) => c.fsrs.state === 0).slice(0, remaining);
  return [...due, ...fresh];
}

// Wiederholungs-/Cram-Schlange: ALLE aktiven Karten des Decks (inkl. Unterdecks),
// unabhängig von Lernstatus und Fälligkeit. Reihenfolge gemischt (Fisher-Yates), damit
// sich eine erneute Durchsicht nicht immer gleich anfühlt. Suspendierte/gelöschte Karten
// bleiben außen vor. Bewerten in diesem Modus ändert NICHTS am FSRS-Plan (siehe Review).
export async function getCramQueue(deckId: string): Promise<Card[]> {
  const deckIds = await descendantDeckIds(deckId);
  const all = (await Promise.all(deckIds.map((id) => db.cards.where('deckId').equals(id).toArray()))).flat();
  const active = all.filter((c) => !c.suspended && !c.deleted);
  for (let i = active.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [active[i], active[j]] = [active[j], active[i]];
  }
  return active;
}

// Vollständige FSRS-Vorschau für alle vier Bewertungen, EINMAL berechnet (gleiches `now`).
// So entspricht das auf dem Button gezeigte Intervall exakt dem später gespeicherten (vorher
// liefen Vorschau via repeat() und Speichern via next() mit unterschiedlichem now → Fuzz-Drift).
export function scheduleCard(card: Card, retention: number, now: Date = new Date()): RecordLog {
  return makeScheduler(retention).repeat(card.fsrs, now);
}

// Persistiert ein zuvor mit scheduleCard berechnetes Ergebnis (write-behind aus dem Review).
export async function commitReview(card: Card, item: RecordLogItem): Promise<void> {
  const next = item.card;
  const log = item.log;
  const reviewedAt = log.review instanceof Date ? log.review.getTime() : Date.now();
  const updated: Card = { ...card, fsrs: next, due: next.due, updatedAt: reviewedAt, usn: -1 };
  const rev: RevlogEntry = {
    id: uuid(),
    cardId: card.id,
    rating: log.rating,
    state: log.state,
    due: log.due,
    stability: log.stability,
    difficulty: log.difficulty,
    elapsedDays: log.elapsed_days,
    lastElapsedDays: log.last_elapsed_days,
    scheduledDays: log.scheduled_days,
    reviewedAt,
  };
  await db.transaction('rw', db.cards, db.revlog, db.outbox, async () => {
    await db.cards.put(updated);
    await db.revlog.add(rev);
    await db.outbox.add({ op: 'upsert', entity: 'card', entityId: card.id, payload: updated, createdAt: reviewedAt });
    await db.outbox.add({ op: 'upsert', entity: 'revlog', entityId: rev.id, payload: rev, createdAt: reviewedAt });
  });
}

export async function setSuspended(cardId: string, suspended: 0 | 1): Promise<void> {
  const card = await db.cards.get(cardId);
  if (!card) return;
  const updated = { ...card, suspended, updatedAt: Date.now(), usn: -1 };
  await db.cards.put(updated);
  await db.outbox.add({ op: 'upsert', entity: 'card', entityId: cardId, payload: updated, createdAt: Date.now() });
}

// Verwaiste Medien aufräumen: lokale Blobs löschen, die in keinem Notizfeld mehr referenziert
// werden. Geteilte Bilder (in mehreren Notizen) bleiben erhalten. Wird nach Lösch-Operationen
// aufgerufen, damit der IndexedDB-Speicher nicht unbegrenzt wächst.
const FLASHMEDIA_REF_RE = /flashmedia:([a-f0-9]+)/g;
export async function gcOrphanedMedia(): Promise<number> {
  const [notes, hashes] = await Promise.all([
    db.notes.toArray(),
    db.media.orderBy('hash').keys() as Promise<string[]>,
  ]);
  const referenced = new Set<string>();
  for (const n of notes) {
    for (const v of Object.values(n.fields ?? {})) {
      for (const m of String(v).matchAll(FLASHMEDIA_REF_RE)) referenced.add(m[1]);
    }
  }
  const orphans = hashes.filter((h) => !referenced.has(h));
  if (orphans.length) await db.media.bulkDelete(orphans);
  return orphans.length;
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

// data:-URL → Blob (Gegenstück zu blobToDataUrl, für den Backup-Import).
async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return res.blob();
}

interface BackupMedia {
  hash: string;
  mime: string;
  width?: number;
  height?: number;
  dataUrl: string;
}
interface BackupFile {
  decks?: Deck[];
  noteTypes?: NoteType[];
  notes?: Note[];
  cards?: Card[];
  revlog?: RevlogEntry[];
  media?: BackupMedia[];
}

// Spiegelt ein Backup zurück in die lokale DB. JSON serialisiert Date→String, daher
// werden alle Datumsfelder (due / fsrs.due / fsrs.last_review / revlog.due) revived.
// Merge-Semantik: bulkPut (gleiche id überschreibt). Schreibt NICHT in die Outbox – ein
// Restore ist lokal; zum Sync müssen die Einträge danach erneut bearbeitet werden.
export async function importBackup(json: string): Promise<{ decks: number; notes: number; cards: number; media: number }> {
  const data = JSON.parse(json) as BackupFile;
  if (!data || typeof data !== 'object') throw new Error('Ungültige Backup-Datei');

  const reviveCard = (c: Card): Card => {
    const f = c.fsrs as unknown as { due: unknown; last_review?: unknown };
    return {
      ...c,
      due: new Date(c.due as unknown as string),
      fsrs: f
        ? ({
            ...f,
            due: new Date(f.due as string),
            last_review: f.last_review ? new Date(f.last_review as string) : undefined,
          } as unknown as Card['fsrs'])
        : c.fsrs,
    };
  };
  const reviveRev = (r: RevlogEntry): RevlogEntry => ({ ...r, due: new Date(r.due as unknown as string) });

  const cards = (data.cards ?? []).map(reviveCard);
  const revlog = (data.revlog ?? []).map(reviveRev);

  const media: Media[] = [];
  for (const m of data.media ?? []) {
    if (!m?.dataUrl || !m.hash) continue;
    const blob = await dataUrlToBlob(m.dataUrl);
    media.push({
      hash: m.hash,
      blob,
      mime: m.mime || blob.type || 'image/webp',
      size: blob.size,
      width: m.width ?? 0,
      height: m.height ?? 0,
      createdAt: Date.now(),
      usn: -1,
      synced: 0,
    });
  }

  await db.transaction(
    'rw',
    [db.decks, db.noteTypes, db.notes, db.cards, db.revlog, db.media, db.outbox],
    async () => {
      const at = Date.now();
      const enqueue = async (entity: OutboxItem['entity'], rows: { id: string }[]) => {
        for (const r of rows) {
          await db.outbox.add({ op: 'upsert', entity, entityId: r.id, payload: r, createdAt: at });
        }
      };
      if (data.decks?.length) { await db.decks.bulkPut(data.decks); await enqueue('deck', data.decks); }
      if (data.noteTypes?.length) { await db.noteTypes.bulkPut(data.noteTypes); await enqueue('noteType', data.noteTypes); }
      if (data.notes?.length) { await db.notes.bulkPut(data.notes); await enqueue('note', data.notes); }
      if (cards.length) { await db.cards.bulkPut(cards); await enqueue('card', cards); }
      if (revlog.length) { await db.revlog.bulkPut(revlog); await enqueue('revlog', revlog); }
      // Medien: synced:0 → der reguläre Medien-Sync lädt sie beim nächsten Lauf hoch.
      if (media.length) await db.media.bulkPut(media);
    },
  );

  return { decks: data.decks?.length ?? 0, notes: data.notes?.length ?? 0, cards: cards.length, media: media.length };
}

export type { NoteType };

import { db, type Card, type Deck, type Media, type Note, type NoteType, type OutboxItem, type RevlogEntry } from './db';
import { makeScheduler } from '../scheduler/fsrs';
import type { RecordLog, RecordLogItem } from 'ts-fsrs';
import { uuid } from './ids';
import { generateCards } from '../lib/cardgen';
import { freshCardsForNote, reconcileCardsForNote } from './cardReconcile';
import { withLocalDataOperation } from './localDataLock';
import { unzipSafely } from '../lib/zipSafety';

const NO_CARDS_MSG = 'Diese Notiz würde keine Karten erzeugen. Bitte fülle die für die Kartenvorlage benötigten Felder aus.';
const MAX_LEGACY_BACKUP_JSON_BYTES = 100 * 1024 * 1024;
const MAX_BACKUP_ARCHIVE_BYTES = 325 * 1024 * 1024;
const MAX_BACKUP_UNCOMPRESSED_BYTES = 320 * 1024 * 1024;
const MAX_BACKUP_ENTRY_BYTES = 300 * 1024 * 1024;
const MAX_BACKUP_ENTRIES = 10_000;
const BACKUP_MANIFEST = 'backup.json';
const textEncoder = new TextEncoder();

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

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
  return withLocalDataOperation(() => setDesiredRetentionUnlocked(v));
}

async function setDesiredRetentionUnlocked(v: number): Promise<void> {
  await db.meta.put({ key: 'desiredRetention', value: clampRetention(v) });
}

export async function createDeck(name: string): Promise<string> {
  return withLocalDataOperation(() => createDeckUnlocked(name));
}

async function createDeckUnlocked(name: string): Promise<string> {
  const id = uuid();
  const now = Date.now();
  const deck: Deck = { id, name, parentId: null, newPerDay: 20, updatedAt: now };
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
  return withLocalDataOperation(() => addNoteUnlocked(params));
}

async function addNoteUnlocked(params: {
  noteTypeId: string;
  deckId: string;
  fields: Record<string, string>;
  tags?: string[];
}): Promise<void> {
  const [nt, deck] = await Promise.all([
    db.noteTypes.get(params.noteTypeId),
    db.decks.get(params.deckId),
  ]);
  if (!nt) throw new Error('Notiztyp nicht gefunden');
  if (!deck) throw new Error('Ziel-Deck wurde nicht gefunden');
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
  };
  const cards = freshCardsForNote(note, nt, now);
  if (cards.length === 0) throw new Error(NO_CARDS_MSG);
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
  return withLocalDataOperation(() => renameDeckUnlocked(deckId, name));
}

async function renameDeckUnlocked(deckId: string, name: string): Promise<void> {
  const deck = await db.decks.get(deckId);
  if (!deck) return;
  const now = Date.now();
  const updated: Deck = { ...deck, name, updatedAt: now };
  await db.transaction('rw', db.decks, db.outbox, async () => {
    await db.decks.put(updated);
    await db.outbox.add({ op: 'upsert', entity: 'deck', entityId: deckId, payload: updated, createdAt: now });
  });
}

export async function deleteDeck(deckId: string): Promise<void> {
  return withLocalDataOperation(() => deleteDeckUnlocked(deckId));
}

async function deleteDeckUnlocked(deckId: string): Promise<void> {
  const now = Date.now();
  const deckIds = await getDescendantDeckIds(deckId);
  // Notes/Cards ERST innerhalb der Transaktion lesen (nicht vorab): sonst könnte zwischen
  // dem Lesen und dem Löschen eine parallele Schreibung (z. B. ein laufender Sync-Pull)
  // eine neue Notiz/Karte in einem der Decks anlegen, die dann ohne Tombstone lokal
  // gelöscht würde und beim nächsten Sync als Geisterobjekt zurückkäme.
  await db.transaction('rw', db.decks, db.notes, db.cards, db.revlog, db.outbox, async () => {
    const [notes, cards] = await Promise.all([
      Promise.all(deckIds.map((id) => db.notes.where('deckId').equals(id).toArray())).then((rows) => rows.flat()),
      Promise.all(deckIds.map((id) => db.cards.where('deckId').equals(id).toArray())).then((rows) => rows.flat()),
    ]);
    const revlogs = cards.length
      ? await db.revlog.where('cardId').anyOf(cards.map((card) => card.id)).toArray()
      : [];
    await db.decks.bulkDelete(deckIds);
    for (const id of deckIds) {
      await db.notes.where('deckId').equals(id).delete();
      await db.cards.where('deckId').equals(id).delete();
      await db.outbox.add({ op: 'delete', entity: 'deck', entityId: id, payload: null, createdAt: now });
    }
    for (const n of notes) {
      await db.outbox.add({ op: 'delete', entity: 'note', entityId: n.id, payload: null, createdAt: now });
    }
    for (const c of cards) {
      await db.outbox.add({ op: 'delete', entity: 'card', entityId: c.id, payload: null, createdAt: now });
    }
    await db.revlog.bulkDelete(revlogs.map((entry) => entry.id));
    for (const entry of revlogs) {
      await db.outbox.add({ op: 'delete', entity: 'revlog', entityId: entry.id, payload: null, createdAt: now });
    }
  });
  await gcOrphanedMediaUnlocked(); // jetzt unreferenzierte Bilder lokal entfernen
}

export async function updateNote(
  noteId: string,
  fields: Record<string, string>,
  newDeckId?: string,
  newNoteTypeId?: string,
): Promise<void> {
  return withLocalDataOperation(() =>
    updateNoteUnlocked(noteId, fields, newDeckId, newNoteTypeId));
}

async function updateNoteUnlocked(
  noteId: string,
  fields: Record<string, string>,
  newDeckId?: string,
  newNoteTypeId?: string,
): Promise<void> {
  const note = await db.notes.get(noteId);
  // Laut werden statt still zurückkehren: Der Aufrufer (AddCard) würde ein silent return
  // als Erfolg werten und wegnavigieren — die Eingabe wäre kommentarlos verloren, z. B.
  // wenn die Notiz während des Bearbeitens per Sync von einem anderen Gerät gelöscht wurde.
  if (!note) throw new Error('Die Notiz wurde inzwischen gelöscht (z. B. auf einem anderen Gerät).');
  const resolvedNoteTypeId = newNoteTypeId ?? note.noteTypeId;
  const deckId = newDeckId ?? note.deckId;
  const [nt, deck] = await Promise.all([
    db.noteTypes.get(resolvedNoteTypeId),
    db.decks.get(deckId),
  ]);
  if (!nt) throw new Error('Notiztyp nicht gefunden');
  if (!deck) throw new Error('Ziel-Deck wurde nicht gefunden');
  const now = Date.now();
  const updated: Note = { ...note, fields, noteTypeId: resolvedNoteTypeId, sortField: fields[nt.fields[0]] ?? '', deckId, updatedAt: now };
  // Vorab prüfen (vor jeder DB-Schreibung): würde diese Bearbeitung die Notiz auf null
  // Karten bringen (z. B. leeres Pflichtfeld einer Kartenvorlage), lieber ablehnen als
  // eine unsichtbare, nie wieder auffindbare Notiz zu hinterlassen.
  if (generateCards(updated, nt).length === 0) throw new Error(NO_CARDS_MSG);

  if (resolvedNoteTypeId !== note.noteTypeId) {
    // Notiztyp gewechselt: alte Karten löschen + neue nach neuem Template generieren.
    // FSRS-Fortschritt der alten Karten geht verloren (analog zu Anki).
    const newCards = freshCardsForNote(updated, nt, now);
    await db.transaction('rw', db.notes, db.cards, db.outbox, async () => {
      const existingCards = await db.cards.where('noteId').equals(noteId).toArray();
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
    await db.transaction('rw', db.notes, db.cards, db.outbox, async () => {
      const existingCards = await db.cards.where('noteId').equals(noteId).toArray();
      const cardChanges = reconcileCardsForNote(updated, nt, existingCards, now);
      await db.notes.put(updated);
      await db.outbox.add({ op: 'upsert', entity: 'note', entityId: noteId, payload: updated, createdAt: now });
      for (const c of cardChanges.remove) {
        await db.cards.delete(c.id);
        await db.outbox.add({ op: 'delete', entity: 'card', entityId: c.id, payload: null, createdAt: now });
      }
      for (const c of cardChanges.upsert) {
        const latest = await db.cards.get(c.id);
        // Beim parallelen Bewerten kann sich nur der FSRS-State ändern. Metadaten
        // (Deck/NoteType) übernehmen, aber den aktuelleren Scheduler-State bewahren.
        const merged = latest
          ? { ...c, fsrs: latest.fsrs, due: latest.due, updatedAt: Math.max(now, latest.updatedAt) }
          : c;
        await db.cards.put(merged);
        await db.outbox.add({ op: 'upsert', entity: 'card', entityId: merged.id, payload: merged, createdAt: now });
      }
    });
  }
}

export async function deleteNote(noteId: string): Promise<void> {
  return withLocalDataOperation(() => deleteNoteUnlocked(noteId));
}

async function deleteNoteUnlocked(noteId: string): Promise<void> {
  const now = Date.now();
  await db.transaction('rw', db.notes, db.cards, db.revlog, db.outbox, async () => {
    const cards = await db.cards.where('noteId').equals(noteId).toArray();
    const revlogs = cards.length
      ? await db.revlog.where('cardId').anyOf(cards.map((card) => card.id)).toArray()
      : [];
    await db.notes.delete(noteId);
    await db.cards.where('noteId').equals(noteId).delete();
    await db.revlog.bulkDelete(revlogs.map((entry) => entry.id));
    await db.outbox.add({ op: 'delete', entity: 'note', entityId: noteId, payload: null, createdAt: now });
    for (const c of cards) {
      await db.outbox.add({ op: 'delete', entity: 'card', entityId: c.id, payload: null, createdAt: now });
    }
    for (const entry of revlogs) {
      await db.outbox.add({ op: 'delete', entity: 'revlog', entityId: entry.id, payload: null, createdAt: now });
    }
  });
  await gcOrphanedMediaUnlocked();
}

// Massenimport (CSV/TSV): erzeugt Notizen + Karten + Outbox-Einträge in Batches.
export async function importNotes(params: {
  deckId: string;
  noteTypeId: string;
  rows: string[][];
  fieldMap: number[]; // Spaltenindex je Notiztyp-Feld, -1 = leer lassen
  hasHeader: boolean;
}): Promise<{ notes: number; cards: number }> {
  return withLocalDataOperation(() => importNotesUnlocked(params));
}

async function importNotesUnlocked(params: {
  deckId: string;
  noteTypeId: string;
  rows: string[][];
  fieldMap: number[];
  hasHeader: boolean;
}): Promise<{ notes: number; cards: number }> {
  if (!(await db.decks.get(params.deckId))) throw new Error('Ziel-Deck wurde nicht gefunden.');
  const nt = await db.noteTypes.get(params.noteTypeId);
  if (!nt) throw new Error('Notiztyp nicht gefunden');
  const dataRows = params.hasHeader ? params.rows.slice(1) : params.rows;
  let importedNotes = 0;
  let importedCards = 0;
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
        };
        const cards = freshCardsForNote(note, nt, now);
        if (cards.length === 0) continue; // Kartenvorlage bliebe für diese Zeile leer
        await db.notes.add(note);
        await db.cards.bulkAdd(cards);
        await db.outbox.add({ op: 'upsert', entity: 'note', entityId: id, payload: note, createdAt: now });
        for (const c of cards) {
          await db.outbox.add({ op: 'upsert', entity: 'card', entityId: c.id, payload: c, createdAt: now });
        }
        importedNotes++;
        importedCards += cards.length;
      }
    });
  }
  return { notes: importedNotes, cards: importedCards };
}

// Lern-Streak: aufeinanderfolgende lokale Tage mit mindestens einem Review.
// Heute noch nichts gelernt? Streak bleibt bis Tagesende erhalten (ab gestern gezählt).
// Tagesweise rückwärts per indexierter Range-Abfrage prüfen (first() bricht nach dem
// ersten Treffer ab): Kosten O(Streak-Länge) statt alle reviewedAt-Keys zu laden —
// die DeckList fragt den Streak live nach jedem Review erneut ab.
export async function getReviewStreak(): Promise<number> {
  const hasReviewOnDayOf = async (cursor: Date): Promise<boolean> => {
    const start = new Date(cursor);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const first = await db.revlog
      .where('reviewedAt')
      .between(start.getTime(), end.getTime(), true, false)
      .first();
    return first !== undefined;
  };

  const cursor = new Date();
  if (!(await hasReviewOnDayOf(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
    if (!(await hasReviewOnDayOf(cursor))) return 0;
  }
  let streak = 0;
  do {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  } while (await hasReviewOnDayOf(cursor));
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
export async function getDescendantDeckIds(deckId: string): Promise<string[]> {
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
  const seen = new Set(out);
  const stack = [deckId];
  while (stack.length) {
    const cur = stack.pop() as string;
    for (const child of childrenByParent.get(cur) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
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
  const [deck, deckIds] = await Promise.all([db.decks.get(deckId), getDescendantDeckIds(deckId)]);
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
  const deckIds = await getDescendantDeckIds(deckId);
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
  return withLocalDataOperation(() => commitReviewUnlocked(card, item));
}

async function commitReviewUnlocked(card: Card, item: RecordLogItem): Promise<void> {
  const next = item.card;
  const log = item.log;
  const reviewedAt = log.review instanceof Date ? log.review.getTime() : Date.now();
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
    const current = await db.cards.get(card.id);
    if (!current) throw new Error('Karte wurde nicht gefunden.');
    if (current.updatedAt !== card.updatedAt) {
      throw new Error('Karte wurde inzwischen geändert. Bitte erneut bewerten.');
    }
    const updated: Card = { ...current, fsrs: next, due: next.due, updatedAt: reviewedAt };
    await db.cards.put(updated);
    await db.revlog.add(rev);
    await db.outbox.add({ op: 'upsert', entity: 'card', entityId: card.id, payload: updated, createdAt: reviewedAt });
    await db.outbox.add({ op: 'upsert', entity: 'revlog', entityId: rev.id, payload: rev, createdAt: reviewedAt });
  });
}

export async function setSuspended(cardId: string, suspended: 0 | 1): Promise<void> {
  return withLocalDataOperation(async () => {
    await db.transaction('rw', db.cards, db.outbox, async () => {
      const card = await db.cards.get(cardId);
      if (!card) return;
      const now = Date.now();
      const updated = { ...card, suspended, updatedAt: now };
      await db.cards.put(updated);
      await db.outbox.add({
        op: 'upsert',
        entity: 'card',
        entityId: cardId,
        payload: updated,
        createdAt: now,
      });
    });
  });
}

// Verwaiste Medien aufräumen: lokale Blobs löschen, die in keinem Notizfeld mehr referenziert
// werden. Geteilte Bilder (in mehreren Notizen) bleiben erhalten. Wird nach Lösch-Operationen
// aufgerufen, damit der IndexedDB-Speicher nicht unbegrenzt wächst.
const FLASHMEDIA_REF_RE = /flashmedia:([a-f0-9]+)/g;
export async function gcOrphanedMedia(): Promise<number> {
  return withLocalDataOperation(gcOrphanedMediaUnlocked);
}

async function gcOrphanedMediaUnlocked(): Promise<number> {
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

function blobToBytes(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('FileReader-Fehler'));
    reader.readAsArrayBuffer(blob);
  });
}

function blobToText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('FileReader-Fehler'));
    reader.readAsText(blob);
  });
}

async function readBackupSnapshot() {
  // Eine gemeinsame Read-Transaction liefert einen konsistenten Stand über alle Tabellen.
  // Ein paralleler Pull/Review kann damit nicht mehr z. B. eine neue Notiz nach dem
  // Medien-Snapshot einfügen und ein formal erfolgreiches, aber unvollständiges Backup erzeugen.
  return db.transaction(
    'r',
    [db.decks, db.noteTypes, db.notes, db.cards, db.revlog, db.media, db.meta],
    async () => {
      const [decks, noteTypes, notes, cards, revlog, mediaRows, retentionMeta] = await Promise.all([
        db.decks.toArray(),
        db.noteTypes.toArray(),
        db.notes.toArray(),
        db.cards.toArray(),
        db.revlog.toArray(),
        db.media.toArray(),
        db.meta.get('desiredRetention'),
      ]);
      return {
        decks,
        noteTypes,
        notes,
        cards,
        revlog,
        mediaRows,
        retention: clampRetention(
          typeof retentionMeta?.value === 'number' ? retentionMeta.value : 0.9,
        ),
      };
    },
  );
}

export async function exportBackup(): Promise<string> {
  const { decks, noteTypes, notes, cards, revlog, mediaRows, retention } =
    await readBackupSnapshot();
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
  // Nur die Ziel-Retention aus `meta` sichern — NICHT den Rest von `meta` (auth-Token,
  // syncCursor etc.): ein Backup ist eine Datei, die der Nutzer weitergibt/aufbewahrt,
  // ein enthaltenes Auth-Token wäre ein Kontoübernahme-Risiko.
  const json = JSON.stringify(
    {
      version: 1,
      exportedAt: new Date().toISOString(),
      decks,
      noteTypes,
      notes,
      cards,
      revlog,
      media,
      settings: { desiredRetention: retention },
    },
    null,
    2,
  );
  // Der UI-Export verwendet für große/aktuelle Backups das ZIP-Format unten. Die alte
  // JSON-API bleibt für Kompatibilität, erzeugt aber niemals eine Datei, die ihr eigener
  // Import wegen der 100-MiB-Sicherheitsgrenze ablehnen würde.
  if (utf8ByteLength(json) > MAX_LEGACY_BACKUP_JSON_BYTES) {
    throw new Error('JSON-Backup wäre zu groß. Bitte den kompakten ZIP-Backup-Export verwenden.');
  }
  return json;
}

interface ArchiveMedia {
  hash: string;
  mime: string;
  width?: number;
  height?: number;
  file: string;
}

// Vollständiges v2-Backup: Binärmedien liegen als einzelne ZIP-Einträge vor. Dadurch
// entfällt der Base64-Aufschlag, der große selbst erzeugte JSON-Backups unimportierbar machte.
export async function exportBackupArchive(): Promise<Blob> {
  const { decks, noteTypes, notes, cards, revlog, mediaRows, retention } =
    await readBackupSnapshot();
  const media: ArchiveMedia[] = mediaRows.map((row) => ({
    hash: row.hash,
    mime: row.mime,
    width: row.width,
    height: row.height,
    file: `media/${row.hash}`,
  }));
  const manifest = JSON.stringify({
    version: 2,
    exportedAt: new Date().toISOString(),
    decks,
    noteTypes,
    notes,
    cards,
    revlog,
    media,
    settings: { desiredRetention: retention },
  });
  const { strToU8, Zip, ZipDeflate, ZipPassThrough } = await import('fflate');
  const manifestBytes = strToU8(manifest);
  let uncompressedBytes = manifestBytes.byteLength;
  let archiveBytes = 0;
  let settled = false;
  let zip!: InstanceType<typeof Zip>;
  const chunks: ArrayBuffer[] = [];
  const completed = new Promise<Blob>((resolve, reject) => {
    zip = new Zip((zipError, chunk, final) => {
      if (settled) return;
      if (zipError) {
        settled = true;
        reject(zipError);
        return;
      }
      archiveBytes += chunk.byteLength;
      if (archiveBytes > MAX_BACKUP_ARCHIVE_BYTES) {
        settled = true;
        zip.terminate();
        reject(new Error('Backup ist zu groß (max. 325 MiB).'));
        return;
      }
      // fflate darf seinen Ausgabepuffer nach dem Callback wiederverwenden. Jede Scheibe
      // deshalb kopieren, bevor sie als Blob-Part gespeichert wird.
      const copy = new Uint8Array(chunk.byteLength);
      copy.set(chunk);
      chunks.push(copy.buffer);
      if (final) {
        settled = true;
        resolve(new Blob(chunks, { type: 'application/zip' }));
      }
    });
  });

  try {
    const manifestEntry = new ZipDeflate(BACKUP_MANIFEST, { level: 6 });
    zip.add(manifestEntry);
    manifestEntry.push(manifestBytes, true);
    for (const row of mediaRows) {
      const bytes = await blobToBytes(row.blob);
      uncompressedBytes += bytes.byteLength;
      if (uncompressedBytes > MAX_BACKUP_UNCOMPRESSED_BYTES) {
        throw new Error('Backup ist zu groß (max. 320 MiB unkomprimiert).');
      }
      // Bereits komprimierte Bilder nicht erneut deflaten. ZipPassThrough gibt jeden
      // Medienpuffer sofort an den Archiv-Callback weiter, statt alle Dateien parallel
      // im RAM zu halten.
      const mediaEntry = new ZipPassThrough(`media/${row.hash}`);
      zip.add(mediaEntry);
      mediaEntry.push(bytes, true);
    }
    zip.end();
    return await completed;
  } catch (archiveError) {
    if (!settled) {
      settled = true;
      zip.terminate();
    }
    throw archiveError;
  }
}

// data:-URL → Blob (Gegenstück zu blobToDataUrl, für den Backup-Import).
// Bewusst OHNE fetch(): die produktive CSP setzt `connect-src 'self'`, was `fetch("data:…")`
// blockiert (Chrome/Firefox behandeln das als Netzwerk-Request) — ein Backup mit Bildern
// ließ sich dadurch nie wiederherstellen ("Failed to fetch"). atob() ist reine Dekodierung,
// kein Netzwerkzugriff, und bleibt von der CSP unberührt.
function dataUrlToBlob(dataUrl: string): Blob {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error('Ungültige data-URL im Backup');
  const [, mime, isBase64, data] = match;
  if (!isBase64) return new Blob([decodeURIComponent(data)], { type: mime || 'application/octet-stream' });
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'application/octet-stream' });
}

interface BackupMedia {
  hash: string;
  mime: string;
  width?: number;
  height?: number;
  dataUrl?: string;
  file?: string;
}
interface BackupFile {
  version?: number;
  decks?: Deck[];
  noteTypes?: NoteType[];
  notes?: Note[];
  cards?: Card[];
  revlog?: RevlogEntry[];
  media?: BackupMedia[];
  settings?: { desiredRetention?: number };
}

function validBackupShape(data: BackupFile): boolean {
  return Boolean(
    data &&
    typeof data === 'object' &&
    [data.decks, data.noteTypes, data.notes, data.cards, data.revlog, data.media]
      .every((value) => value === undefined || Array.isArray(value)),
  );
}

async function hashBlob(blob: Blob): Promise<string> {
  const bytes = await blobToBytes(blob);
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Spiegelt ein Backup zurück in die lokale DB. JSON serialisiert Date→String, daher
// werden alle Datumsfelder (due / fsrs.due / fsrs.last_review / revlog.due) revived.
// Merge-Semantik: bulkPut (gleiche id überschreibt). Alle Einträge werden in die Outbox
// gestellt, damit ein Restore beim nächsten Sync auch auf die anderen Geräte gelangt.
export async function importBackup(json: string): Promise<{ decks: number; notes: number; cards: number; media: number }> {
  return withLocalDataOperation(() => importLegacyBackup(json));
}

export async function importBackupFile(
  file: File,
): Promise<{ decks: number; notes: number; cards: number; media: number }> {
  return withLocalDataOperation(async () => {
    if (file.size > MAX_BACKUP_ARCHIVE_BYTES) throw new Error('Backup ist zu groß (max. 325 MiB).');
    const signature = await blobToBytes(file.slice(0, 4));
    const isZip =
      signature[0] === 0x50 &&
      signature[1] === 0x4b &&
      (signature[2] === 0x03 || signature[2] === 0x05 || signature[2] === 0x07) &&
      (signature[3] === 0x04 || signature[3] === 0x06 || signature[3] === 0x08);
    if (!isZip) {
      if (file.size > MAX_LEGACY_BACKUP_JSON_BYTES) throw new Error('JSON-Backup ist zu groß (max. 100 MB).');
      return importLegacyBackup(await blobToText(file));
    }

    const archiveBytes = await blobToBytes(file);
    const entries = await unzipSafely(archiveBytes, {
      maxEntries: MAX_BACKUP_ENTRIES,
      maxEntryBytes: MAX_BACKUP_ENTRY_BYTES,
      maxUncompressedBytes: MAX_BACKUP_UNCOMPRESSED_BYTES,
      label: 'Backup',
    });
    const { strFromU8 } = await import('fflate');
    const manifestBytes = entries[BACKUP_MANIFEST];
    if (!manifestBytes) throw new Error(`Backup enthält keine ${BACKUP_MANIFEST}`);
    const data = JSON.parse(strFromU8(manifestBytes)) as BackupFile;
    if (!validBackupShape(data) || data.version !== 2) throw new Error('Ungültiges ZIP-Backup');
    return importBackupData(data, entries);
  });
}

async function importLegacyBackup(
  json: string,
): Promise<{ decks: number; notes: number; cards: number; media: number }> {
  if (utf8ByteLength(json) > MAX_LEGACY_BACKUP_JSON_BYTES) throw new Error('Backup ist zu groß (max. 100 MB).');
  const data = JSON.parse(json) as BackupFile;
  if (!validBackupShape(data)) throw new Error('Ungültige Backup-Datei');
  return importBackupData(data);
}

async function importBackupData(
  data: BackupFile,
  archiveEntries?: Record<string, Uint8Array>,
): Promise<{ decks: number; notes: number; cards: number; media: number }> {

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

  // Ein Restore ist eine neue, explizite Benutzeränderung. Alle konfliktfähigen Entitäten
  // erhalten denselben aktuellen Zeitstempel, damit weder der initiale Pull noch ein
  // serverseitiger Tombstone die gerade wiederhergestellten Daten als "älter" verwirft.
  const restoredAt = Date.now();
  const decks = (data.decks ?? []).map((deck) => ({ ...deck, updatedAt: restoredAt }));
  const noteTypes = (data.noteTypes ?? []).map((noteType) => ({ ...noteType, updatedAt: restoredAt }));
  const notes = (data.notes ?? []).map((note) => ({ ...note, updatedAt: restoredAt }));
  const cards = (data.cards ?? []).map((card) => ({ ...reviveCard(card), updatedAt: restoredAt }));
  const revlog = (data.revlog ?? []).map(reviveRev);

  const media: Media[] = [];
  for (const m of data.media ?? []) {
    if (!m?.hash) continue;
    let blob: Blob | null = null;
    if (archiveEntries) {
      if (!/^[a-f0-9]{64}$/.test(m.hash) || m.file !== `media/${m.hash}`) {
        throw new Error('Ungültiger Medien-Eintrag im ZIP-Backup');
      }
      const bytes = archiveEntries[m.file];
      if (!bytes) throw new Error(`Mediendatei fehlt im Backup: ${m.hash}`);
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      blob = new Blob([copy.buffer], { type: m.mime || 'application/octet-stream' });
    } else if (m.dataUrl) {
      blob = dataUrlToBlob(m.dataUrl);
    }
    if (!blob) continue;
    if (await hashBlob(blob) !== m.hash) {
      throw new Error(`Medien-Prüfsumme stimmt nicht: ${m.hash}`);
    }
    media.push({
      hash: m.hash,
      blob,
      mime: m.mime || blob.type || 'image/webp',
      size: blob.size,
      width: m.width ?? 0,
      height: m.height ?? 0,
      createdAt: restoredAt,
      synced: 0,
    });
  }

  await db.transaction(
    'rw',
    [db.decks, db.noteTypes, db.notes, db.cards, db.revlog, db.media, db.meta, db.outbox],
    async () => {
      const enqueue = async (entity: OutboxItem['entity'], rows: { id: string }[]) => {
        for (const r of rows) {
          await db.outbox.add({ op: 'upsert', entity, entityId: r.id, payload: r, createdAt: restoredAt });
        }
      };
      if (decks.length) { await db.decks.bulkPut(decks); await enqueue('deck', decks); }
      if (noteTypes.length) { await db.noteTypes.bulkPut(noteTypes); await enqueue('noteType', noteTypes); }
      if (notes.length) { await db.notes.bulkPut(notes); await enqueue('note', notes); }
      if (cards.length) { await db.cards.bulkPut(cards); await enqueue('card', cards); }
      if (revlog.length) { await db.revlog.bulkPut(revlog); await enqueue('revlog', revlog); }
      // Medien: synced:0 → der reguläre Medien-Sync lädt sie beim nächsten Lauf hoch.
      if (media.length) await db.media.bulkPut(media);
      if (typeof data.settings?.desiredRetention === 'number') {
        await db.meta.put({ key: 'desiredRetention', value: clampRetention(data.settings.desiredRetention) });
      }
    },
  );

  return { decks: decks.length, notes: notes.length, cards: cards.length, media: media.length };
}

export type { NoteType };

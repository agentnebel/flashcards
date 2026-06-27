import Dexie, { type EntityTable } from 'dexie';
import type { Card as FsrsCard } from 'ts-fsrs';

// ---- Domänen-Typen (Note/Card strikt getrennt wie Anki) ----

export interface Deck {
  id: string;
  name: string;
  parentId: string | null;
  newPerDay: number;
  updatedAt: number;
  usn: number; // -1 = lokal geändert, noch nicht gesynct
  deleted?: 0 | 1;
}

export interface NoteTypeTemplate {
  name: string;
  qfmt: string; // Vorderseiten-HTML mit {{Feld}}-Platzhaltern
  afmt: string; // Rückseiten-HTML, {{FrontSide}} erlaubt
}

export interface NoteType {
  id: string;
  name: string;
  kind: 'standard' | 'cloze';
  fields: string[];
  templates: NoteTypeTemplate[];
  css: string;
  updatedAt: number;
  usn: number;
}

export interface Note {
  id: string;
  guid: string;
  noteTypeId: string;
  deckId: string;
  fields: Record<string, string>;
  tags: string[];
  sortField: string;
  updatedAt: number;
  usn: number;
  deleted?: 0 | 1;
}

export interface Card {
  id: string;
  noteId: string;
  deckId: string;
  noteTypeId: string;
  templateOrd: number;
  clozeNum: number | null;
  fsrs: FsrsCard; // vollständiger FSRS-State (due, stability, difficulty, state, ...)
  due: Date; // gespiegelt aus fsrs.due für Indexierung/Query
  suspended: 0 | 1;
  updatedAt: number;
  usn: number;
  deleted?: 0 | 1;
}

export interface RevlogEntry {
  id: string;
  cardId: string;
  rating: number; // 1=Again .. 4=Easy
  state: number;
  due: Date;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  lastElapsedDays: number;
  scheduledDays: number;
  reviewedAt: number;
}

export interface OutboxItem {
  id?: number;
  op: 'upsert' | 'delete';
  entity: 'deck' | 'note' | 'card' | 'revlog' | 'noteType';
  entityId: string;
  payload: unknown;
  createdAt: number;
}

export interface Meta {
  key: string;
  value: unknown;
}

export interface Media {
  hash: string; // sha256-hex der komprimierten Bytes (Primärschlüssel, dedupliziert)
  blob: Blob;
  mime: string;
  size: number;
  width: number;
  height: number;
  createdAt: number;
  usn: number; // -1 = lokal geändert
  synced: 0 | 1; // 1 = bereits auf R2 hochgeladen
}

// ---- Dexie-Datenbank ----

class FlashcardsDB extends Dexie {
  decks!: EntityTable<Deck, 'id'>;
  noteTypes!: EntityTable<NoteType, 'id'>;
  notes!: EntityTable<Note, 'id'>;
  cards!: EntityTable<Card, 'id'>;
  revlog!: EntityTable<RevlogEntry, 'id'>;
  outbox!: EntityTable<OutboxItem, 'id'>;
  meta!: EntityTable<Meta, 'key'>;
  media!: EntityTable<Media, 'hash'>;

  constructor() {
    super('flashcards');
    this.version(1).stores({
      decks: 'id, parentId, updatedAt',
      noteTypes: 'id, updatedAt',
      notes: 'id, deckId, noteTypeId, updatedAt',
      cards: 'id, noteId, deckId, due, suspended, updatedAt',
      revlog: 'id, cardId, reviewedAt',
      outbox: '++id, entity, createdAt',
      meta: 'key',
    });
    // v2: Medien-Tabelle für Bild-Uploads (lokal als Blob, Dedup via Hash).
    this.version(2).stores({
      decks: 'id, parentId, updatedAt',
      noteTypes: 'id, updatedAt',
      notes: 'id, deckId, noteTypeId, updatedAt',
      cards: 'id, noteId, deckId, due, suspended, updatedAt',
      revlog: 'id, cardId, reviewedAt',
      outbox: '++id, entity, createdAt',
      meta: 'key',
      media: 'hash, createdAt, synced',
    });
  }
}

export const db = new FlashcardsDB();

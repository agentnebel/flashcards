import type { Card, Note, NoteType } from './db';
import { generateCards } from '../lib/cardgen';
import { createEmptyCard } from '../scheduler/fsrs';
import { uuid } from './ids';

type CardIdentity = Pick<Card, 'templateOrd' | 'clozeNum'>;

export interface CardReconciliation {
  upsert: Card[];
  remove: Card[];
}

function cardKey(card: CardIdentity): string {
  return `${card.templateOrd}:${card.clozeNum ?? 'null'}`;
}

function freshCardForSpec(note: Note, nt: NoteType, spec: CardIdentity, now: number): Card {
  const fsrs = createEmptyCard(new Date(now));
  return {
    id: uuid(),
    noteId: note.id,
    deckId: note.deckId,
    noteTypeId: nt.id,
    templateOrd: spec.templateOrd,
    clozeNum: spec.clozeNum,
    fsrs,
    due: fsrs.due,
    suspended: 0,
    updatedAt: now,
  };
}

export function freshCardsForNote(note: Note, nt: NoteType, now: number): Card[] {
  return generateCards(note, nt).map((spec) => freshCardForSpec(note, nt, spec, now));
}

export function reconcileCardsForNote(
  note: Note,
  nt: NoteType,
  existingCards: Card[],
  now: number,
): CardReconciliation {
  const desiredSpecs = generateCards(note, nt);
  const desiredKeys = new Set(desiredSpecs.map(cardKey));
  const retainedByKey = new Map<string, Card>();
  const remove: Card[] = [];

  for (const card of existingCards) {
    const key = cardKey(card);
    if (!desiredKeys.has(key) || retainedByKey.has(key)) {
      remove.push(card);
    } else {
      retainedByKey.set(key, card);
    }
  }

  const upsert: Card[] = [];
  for (const spec of desiredSpecs) {
    const existing = retainedByKey.get(cardKey(spec));
    if (!existing) {
      upsert.push(freshCardForSpec(note, nt, spec, now));
      continue;
    }

    const changed =
      existing.noteId !== note.id ||
      existing.deckId !== note.deckId ||
      existing.noteTypeId !== nt.id ||
      existing.templateOrd !== spec.templateOrd ||
      existing.clozeNum !== spec.clozeNum ||
      existing.deleted === 1;

    if (changed) {
      upsert.push({
        ...existing,
        noteId: note.id,
        deckId: note.deckId,
        noteTypeId: nt.id,
        templateOrd: spec.templateOrd,
        clozeNum: spec.clozeNum,
        deleted: 0,
        updatedAt: now,
      });
    }
  }

  return { upsert, remove };
}

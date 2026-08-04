import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { Card, Deck } from '../db/db';
import { createEmptyCard } from '../scheduler/fsrs';
import { computeDeckStats, descendantDeckIds, shouldActivateDeckRow } from './DeckList';

describe('DeckList-Keyboard-Navigation', () => {
  it('aktiviert die Deck-Zeile nur für deren eigenes Keyboard-Event', () => {
    const row = document.createElement('div');
    const cramButton = document.createElement('button');
    row.append(cramButton);

    expect(shouldActivateDeckRow('Enter', row, row)).toBe(true);
    expect(shouldActivateDeckRow(' ', row, row)).toBe(true);
    expect(shouldActivateDeckRow('Enter', cramButton, row)).toBe(false);
    expect(shouldActivateDeckRow(' ', cramButton, row)).toBe(false);
    expect(shouldActivateDeckRow('Escape', row, row)).toBe(false);
  });
});

describe('Deck-Nachfahren', () => {
  it('terminiert auch bei einem importierten Parent-Zyklus', () => {
    const decks: Deck[] = [
      { id: 'a', name: 'A', parentId: 'b', newPerDay: 20, updatedAt: 1 },
      { id: 'b', name: 'B', parentId: 'a', newPerDay: 20, updatedAt: 1 },
    ];
    expect(descendantDeckIds(decks, 'a')).toEqual(new Set(['a', 'b']));
  });
});

describe('Deck-Statistiken', () => {
  const NOW = Date.UTC(2026, 7, 4, 12);

  function makeCard(
    overrides: Partial<Card> & { id: string; deckId: string },
  ): Card {
    const fsrs = createEmptyCard(new Date(NOW - 1));
    return {
      noteId: 'n1',
      noteTypeId: 'nt',
      templateOrd: 0,
      clozeNum: null,
      fsrs,
      due: fsrs.due,
      suspended: 0,
      updatedAt: 1,
      ...overrides,
    };
  }

  function reviewCard(id: string, deckId: string, dueAt: number, suspended: 0 | 1 = 0): Card {
    const base = makeCard({ id, deckId, suspended });
    return {
      ...base,
      fsrs: { ...base.fsrs, state: 2, due: new Date(dueAt) },
      due: new Date(dueAt),
    };
  }

  function descendants(decks: Deck[]): Map<string, Set<string>> {
    return new Map(decks.map((deck) => [deck.id, descendantDeckIds(decks, deck.id)]));
  }

  it('kappt neue Karten auf newPerDay abzüglich heute bereits eingeführter', () => {
    const decks: Deck[] = [{ id: 'a', name: 'A', parentId: null, newPerDay: 2, updatedAt: 1 }];
    const cards: Card[] = [
      makeCard({ id: 'c1', deckId: 'a' }),
      makeCard({ id: 'c2', deckId: 'a' }),
      makeCard({ id: 'c3', deckId: 'a' }),
      reviewCard('c4', 'a', NOW - 1000),
      reviewCard('c5', 'a', NOW + 1000),
    ];
    const stats = computeDeckStats(decks, cards, new Set(['c4']), NOW, descendants(decks));
    // c4 wurde heute eingeführt → nur noch 1 von newPerDay=2 übrig; c5 ist erst später fällig.
    expect(stats.byDeck.get('a')).toEqual({ due: 1, fresh: 1 });
    expect(stats.dueToday).toBe(2);
  });

  it('zählt Unterdeck-Karten im Eltern-Deck, aber nur einmal in der Tagessumme', () => {
    const decks: Deck[] = [
      { id: 'p', name: 'P', parentId: null, newPerDay: 20, updatedAt: 1 },
      { id: 'k', name: 'K', parentId: 'p', newPerDay: 20, updatedAt: 1 },
    ];
    const cards: Card[] = [
      makeCard({ id: 'c1', deckId: 'k' }),
      reviewCard('c2', 'k', NOW - 1),
    ];
    const stats = computeDeckStats(decks, cards, new Set(), NOW, descendants(decks));
    expect(stats.byDeck.get('p')).toEqual({ due: 1, fresh: 1 });
    expect(stats.byDeck.get('k')).toEqual({ due: 1, fresh: 1 });
    expect(stats.dueToday).toBe(2);
  });

  it('ignoriert suspendierte Karten, zählt sie aber gegen das Tageslimit', () => {
    const decks: Deck[] = [{ id: 'a', name: 'A', parentId: null, newPerDay: 1, updatedAt: 1 }];
    const cards: Card[] = [
      makeCard({ id: 'c1', deckId: 'a', suspended: 1 }),
      makeCard({ id: 'c2', deckId: 'a' }),
      reviewCard('c3', 'a', NOW - 1, 1),
    ];
    // c1 (suspendiert) heute eingeführt → Limit 1 ist verbraucht; c3 suspendiert → nicht fällig.
    const stats = computeDeckStats(decks, cards, new Set(['c1']), NOW, descendants(decks));
    expect(stats.byDeck.get('a')).toEqual({ due: 0, fresh: 0 });
    expect(stats.dueToday).toBe(0);
  });
});

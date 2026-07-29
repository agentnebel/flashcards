import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { Deck } from '../db/db';
import { descendantDeckIds, shouldActivateDeckRow } from './DeckList';

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

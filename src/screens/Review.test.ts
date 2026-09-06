import 'fake-indexeddb/auto';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Rating } from 'ts-fsrs';
import type { Card, Note, NoteType } from '../db/db';
import type { Grade, RecordLog, RecordLogItem } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  commitReview: vi.fn(),
  getCramQueue: vi.fn(),
  getDesiredRetention: vi.fn(),
  getStudyQueue: vi.fn(),
  scheduleCard: vi.fn(),
  getNote: vi.fn(),
  getNoteType: vi.fn(),
  ReviewConflictError: class ReviewConflictError extends Error {},
}));

vi.mock('../db/api', () => ({
  commitReview: mocks.commitReview,
  getCramQueue: mocks.getCramQueue,
  getDesiredRetention: mocks.getDesiredRetention,
  getStudyQueue: mocks.getStudyQueue,
  scheduleCard: mocks.scheduleCard,
  ReviewConflictError: mocks.ReviewConflictError,
}));

vi.mock('../db/db', () => ({
  db: {
    notes: { get: mocks.getNote },
    noteTypes: { get: mocks.getNoteType },
  },
}));

vi.mock('../lib/cardgen', () => ({
  renderCard: () => ({ front: '<p>Frage</p>', back: '<p>Antwort</p>' }),
}));

vi.mock('../lib/media', () => ({
  resolveMediaHtml: async (html: string) => html,
}));

import Review, {
  mergeStudyQueue,
  shouldHandleReviewShortcut,
  typedAnswerMatches,
} from './Review';

function makeCard(id: string): Card {
  const due = new Date('2026-07-29T08:00:00.000Z');
  return {
    id,
    noteId: `note-${id}`,
    deckId: 'deck-1',
    noteTypeId: 'type-1',
    templateOrd: 0,
    clozeNum: null,
    fsrs: { state: 0, due } as Card['fsrs'],
    due,
    suspended: 0,
    updatedAt: 1,
  };
}

function makeSchedule(now: Date): RecordLog {
  const schedule = {} as RecordLog;
  const grades: Grade[] = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy];
  for (const grade of grades) {
    schedule[grade] = {
      card: { due: new Date(now.getTime() + grade * 60_000) },
      log: { review: new Date(now), rating: grade },
    } as unknown as RecordLogItem;
  }
  return schedule;
}

const note: Note = {
  id: 'note-card-1',
  guid: 'guid-1',
  noteTypeId: 'type-1',
  deckId: 'deck-1',
  fields: { Front: 'Frage', Back: 'Antwort' },
  tags: [],
  sortField: 'Frage',
  updatedAt: 1,
};

const noteType: NoteType = {
  id: 'type-1',
  name: 'Einfach',
  kind: 'standard',
  fields: ['Front', 'Back'],
  templates: [{ name: 'Karte', qfmt: '{{Front}}', afmt: '{{Back}}' }],
  css: '',
  updatedAt: 1,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function flushAsyncWork(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function renderReview(mode: 'study' | 'cram'): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const path = `/app/deck/deck-1/${mode}`;

  await act(async () => {
    root?.render(
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: '/app/deck/:deckId/:reviewMode',
            element: createElement(Review, { mode }),
          }),
        ),
      ),
    );
  });
  await flushAsyncWork();
  return container;
}

function buttonWithText(host: ParentNode, text: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(text));
  if (!button) throw new Error(`Button nicht gefunden: ${text}`);
  return button;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  });

  for (const mock of Object.values(mocks)) {
    if (vi.isMockFunction(mock)) mock.mockReset();
  }
  mocks.commitReview.mockResolvedValue(undefined);
  mocks.getDesiredRetention.mockResolvedValue(0.9);
  mocks.getNote.mockResolvedValue(note);
  mocks.getNoteType.mockResolvedValue(noteType);
  mocks.scheduleCard.mockImplementation(
    (_card: Card, _retention: number, now: Date = new Date()) => makeSchedule(now),
  );
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  vi.useRealTimers();
});

describe('Review-Keyboard-Shortcuts', () => {
  it('überlässt Enter/Space fokussierten nativen Controls', () => {
    const button = document.createElement('button');
    const child = document.createElement('span');
    button.append(child);
    const input = document.createElement('input');
    const summary = document.createElement('summary');
    const plain = document.createElement('div');

    expect(shouldHandleReviewShortcut('Enter', child)).toBe(false);
    expect(shouldHandleReviewShortcut(' ', button)).toBe(false);
    expect(shouldHandleReviewShortcut('1', child)).toBe(true);
    expect(shouldHandleReviewShortcut('1', input)).toBe(false);
    expect(shouldHandleReviewShortcut('Enter', summary)).toBe(false);
    expect(shouldHandleReviewShortcut(' ', summary)).toBe(false);
    expect(shouldHandleReviewShortcut('Enter', plain)).toBe(true);
  });

  it('vergleicht Type-Antworten Unicode-normalisiert und whitespace-tolerant', () => {
    expect(typedAnswerMatches('  Café   au lait ', 'Cafe\u0301 au lait')).toBe(true);
    expect(typedAnswerMatches('berlin', 'Berlin')).toBe(false);
  });
});

describe('Review-Queue', () => {
  it('hängt neue Karten an und bewahrt die sichtbare Kartenreferenz', () => {
    const visible = makeCard('visible');
    const added = makeCard('added');
    const queue = [visible];

    const merged = mergeStudyQueue(queue, [visible, added], new Set(), new Set());

    expect(merged).toEqual([visible, added]);
    expect(merged[0]).toBe(visible);
    expect(mergeStudyQueue(merged, [visible, added], new Set(), new Set())).toBe(merged);
  });

  it('dreht eine aufgedeckte Karte beim 20s-Refresh nicht zurück', async () => {
    vi.useFakeTimers();
    const visible = makeCard('visible');
    const added = makeCard('added');
    mocks.getStudyQueue.mockResolvedValueOnce([visible]).mockResolvedValue([visible, added]);

    const host = await renderReview('study');
    await act(async () => buttonWithText(host, 'Antwort zeigen').click());
    expect(host.querySelector('.face')?.textContent).toContain('Antwort');

    await act(async () => {
      vi.advanceTimersByTime(20_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushAsyncWork();

    expect(mocks.getStudyQueue).toHaveBeenCalledTimes(2);
    expect(host.querySelector('.face')?.textContent).toContain('Antwort');
    expect(host.querySelector('.grade-bar')).not.toBeNull();
  });
});

describe('Review-Bewertung', () => {
  it('lädt eine inzwischen geänderte Karte nach und erlaubt die erneute Bewertung', async () => {
    const stale = makeCard('card-1');
    const current = { ...stale, updatedAt: stale.updatedAt + 1 };
    mocks.getStudyQueue.mockResolvedValueOnce([stale]).mockResolvedValueOnce([current]).mockResolvedValue([]);
    mocks.commitReview.mockRejectedValueOnce(new mocks.ReviewConflictError('Karte wurde inzwischen geändert.'));

    const host = await renderReview('study');
    await act(async () => buttonWithText(host, 'Antwort zeigen').click());
    await act(async () => buttonWithText(host, 'Gut').click());
    await flushAsyncWork();

    expect(host.querySelector('[role="alert"]')?.textContent).toContain('inzwischen geändert');
    expect(mocks.getStudyQueue).toHaveBeenCalledTimes(2);
    await act(async () => buttonWithText(host, 'Antwort zeigen').click());
    await act(async () => buttonWithText(host, 'Gut').click());
    await flushAsyncWork();

    expect(mocks.commitReview.mock.calls[1][0]).toBe(current);
    expect(host.textContent).toContain('Alles erledigt');
  });

  it('entfernt inzwischen gelöschte Karten nach einem Speicherkonflikt', async () => {
    mocks.getStudyQueue.mockResolvedValueOnce([makeCard('card-1')]).mockResolvedValue([]);
    mocks.commitReview.mockRejectedValueOnce(new mocks.ReviewConflictError('Karte wurde inzwischen gelöscht.'));
    const host = await renderReview('study');
    await act(async () => buttonWithText(host, 'Antwort zeigen').click());
    await act(async () => buttonWithText(host, 'Gut').click());
    await flushAsyncWork();
    expect(host.textContent).toContain('Alles erledigt');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('gelöscht');
  });

  it('zeigt Speicherfehler auch auf der aufgedeckten Seite an', async () => {
    mocks.getStudyQueue.mockResolvedValue([makeCard('card-1')]);
    mocks.commitReview.mockRejectedValueOnce(new Error('Speicher voll'));
    const host = await renderReview('study');
    await act(async () => buttonWithText(host, 'Antwort zeigen').click());
    await act(async () => buttonWithText(host, 'Gut').click());
    await flushAsyncWork();
    expect(host.querySelector('.grade-bar')).not.toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Speicher voll');
    expect(mocks.getStudyQueue).toHaveBeenCalledTimes(1);
  });

  it('berechnet den persistierten Plan zum tatsächlichen Bewertungszeitpunkt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T23:59:00.000Z'));
    const card = makeCard('card-1');
    mocks.getStudyQueue.mockResolvedValue([card]);

    const host = await renderReview('study');
    await act(async () => buttonWithText(host, 'Antwort zeigen').click());
    vi.setSystemTime(new Date('2026-07-30T00:01:00.000Z'));
    await act(async () => buttonWithText(host, 'Nochmal').click());
    await flushAsyncWork();

    const answerCalls = mocks.scheduleCard.mock.calls.filter((call) => call[2] instanceof Date);
    expect(answerCalls).toHaveLength(1);
    expect((answerCalls[0][2] as Date).toISOString()).toBe('2026-07-30T00:01:00.000Z');
    expect((mocks.commitReview.mock.calls[0][1].log.review as Date).toISOString()).toBe(
      '2026-07-30T00:01:00.000Z',
    );
  });

  it('schaltet erst nach dem gespeicherten Review zur nächsten Karte weiter', async () => {
    let resolveCommit!: () => void;
    mocks.commitReview.mockReturnValue(new Promise<void>((resolve) => {
      resolveCommit = resolve;
    }));
    mocks.getStudyQueue.mockResolvedValue([makeCard('card-1'), makeCard('card-2')]);

    const host = await renderReview('study');
    await act(async () => buttonWithText(host, 'Antwort zeigen').click());
    await act(async () => buttonWithText(host, 'Gut').click());

    expect(host.querySelector('.progress-label')?.textContent).toBe('0/2');
    expect(
      [...host.querySelectorAll<HTMLButtonElement>('.grade-bar button')]
        .every((button) => button.disabled),
    ).toBe(true);

    await act(async () => resolveCommit());
    await flushAsyncWork();

    expect(host.querySelector('.progress-label')?.textContent).toBe('1/2');
  });

  it('holt eine einzelne Cram-Karte nach Again-Swipe sichtbar zurück', async () => {
    vi.useFakeTimers();
    const card = makeCard('card-1');
    mocks.getCramQueue.mockResolvedValue([card]);

    const host = await renderReview('cram');
    await act(async () => buttonWithText(host, 'Antwort zeigen').click());
    const reviewCard = host.querySelector<HTMLElement>('.review-card');
    if (!reviewCard) throw new Error('Review-Karte nicht gefunden');

    await act(async () => {
      reviewCard.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 220, clientY: 100 }));
      reviewCard.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 80, clientY: 100 }));
      reviewCard.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 80, clientY: 100 }));
    });
    expect(reviewCard.style.opacity).toBe('0');

    await act(async () => {
      vi.advanceTimersByTime(180);
    });
    await flushAsyncWork();

    expect(reviewCard.style.opacity).not.toBe('0');
    expect(reviewCard.style.transform).toBe('');
    expect(buttonWithText(host, 'Antwort zeigen')).toBeTruthy();
  });

  it('ignoriert Button und Shortcut während eine Cram-Swipe-Bewertung aussteht', async () => {
    vi.useFakeTimers();
    mocks.getCramQueue.mockResolvedValue([makeCard('card-1'), makeCard('card-2')]);

    const host = await renderReview('cram');
    await act(async () => buttonWithText(host, 'Antwort zeigen').click());
    const reviewCard = host.querySelector<HTMLElement>('.review-card');
    if (!reviewCard) throw new Error('Review-Karte nicht gefunden');

    await act(async () => {
      reviewCard.dispatchEvent(new MouseEvent('pointerdown', {
        bubbles: true,
        clientX: 80,
        clientY: 100,
      }));
      reviewCard.dispatchEvent(new MouseEvent('pointermove', {
        bubbles: true,
        clientX: 220,
        clientY: 100,
      }));
      reviewCard.dispatchEvent(new MouseEvent('pointerup', {
        bubbles: true,
        clientX: 220,
        clientY: 100,
      }));
      // Der Swipe plant "Gut". Weder ein zweiter Shortcut noch der weiterhin im
      // DOM vorhandene Button darf die Queue vor Ablauf der Animation verschieben.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true }));
      buttonWithText(host, 'Gewusst').click();
    });

    expect(buttonWithText(host, 'Gewusst').disabled).toBe(true);
    expect(host.querySelector('.progress-label')?.textContent).toBe('0/2');

    await act(async () => {
      vi.advanceTimersByTime(180);
    });
    await flushAsyncWork();

    expect(host.querySelector('.progress-label')?.textContent).toBe('1/2');
    expect(buttonWithText(host, 'Antwort zeigen')).toBeTruthy();
    expect(host.textContent).not.toContain('Alle Karten durchgegangen');
  });
});

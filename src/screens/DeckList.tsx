import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from 'react-router-dom';
import { useMemo, useState } from 'react';
import { db } from '../db/db';
import type { Card, Deck } from '../db/db';
import { createDeck, deleteDeck, getReviewStreak, renameDeck } from '../db/api';

export function shouldActivateDeckRow(
  key: string,
  target: EventTarget | null,
  currentTarget: EventTarget | null,
): boolean {
  return (key === 'Enter' || key === ' ') && target === currentTarget;
}

export function descendantDeckIds(decks: Deck[], rootId: string): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const deck of decks) {
    if (!deck.parentId) continue;
    const children = childrenByParent.get(deck.parentId);
    if (children) children.push(deck.id);
    else childrenByParent.set(deck.parentId, [deck.id]);
  }
  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const child of childrenByParent.get(current) ?? []) {
      if (!seen.has(child)) stack.push(child);
    }
  }
  return seen;
}

export interface DeckStats {
  due: number;
  fresh: number;
}

// Zählt in EINEM Durchlauf über alle Karten die Zähler je Deck (inkl. Unterdecks) statt
// pro Deck-Zeile erneut alle Karten zu filtern. `fresh` ist auf das Tageslimit gekappt:
// newPerDay abzüglich der heute bereits eingeführten neuen Karten — dieselbe Semantik wie
// getStudyQueue/newCardsIntroducedToday, damit "heute fällig" nicht z. B. direkt nach
// einem Import hunderte neue Karten verspricht, von denen heute nur 20 drankommen.
export function computeDeckStats(
  decks: Deck[],
  cards: Card[],
  introducedTodayIds: ReadonlySet<string>,
  now: number,
  descendantIdsByDeck: ReadonlyMap<string, ReadonlySet<string>>,
): { byDeck: Map<string, DeckStats>; dueToday: number } {
  interface DirectCounts { due: number; fresh: number; introduced: number }
  const direct = new Map<string, DirectCounts>();
  const bucket = (deckId: string): DirectCounts => {
    let counts = direct.get(deckId);
    if (!counts) {
      counts = { due: 0, fresh: 0, introduced: 0 };
      direct.set(deckId, counts);
    }
    return counts;
  };
  let totalDue = 0;
  for (const card of cards) {
    // Heute eingeführte Karten zählen unabhängig vom Aktiv-Status gegen das Tageslimit
    // (wie newCardsIntroducedToday in db/api.ts).
    if (introducedTodayIds.has(card.id)) bucket(card.deckId).introduced += 1;
    if (card.suspended || card.deleted) continue;
    if (card.fsrs.state !== 0) {
      if (card.due.getTime() <= now) {
        bucket(card.deckId).due += 1;
        totalDue += 1;
      }
    } else {
      bucket(card.deckId).fresh += 1;
    }
  }

  const deckIds = new Set(decks.map((deck) => deck.id));
  const byDeck = new Map<string, DeckStats>();
  let freshToday = 0;
  for (const deck of decks) {
    let due = 0;
    let fresh = 0;
    let introduced = 0;
    for (const id of descendantIdsByDeck.get(deck.id) ?? [deck.id]) {
      const counts = direct.get(id);
      if (!counts) continue;
      due += counts.due;
      fresh += counts.fresh;
      introduced += counts.introduced;
    }
    const perDay = typeof deck.newPerDay === 'number' ? deck.newPerDay : 20;
    const cappedFresh = Math.min(fresh, Math.max(0, perDay - introduced));
    byDeck.set(deck.id, { due, fresh: cappedFresh });
    // Für die Kopfzeile nur Wurzeldecks summieren: Unterdeck-Karten stecken bereits im
    // Aggregat ihrer Wurzel. Decks mit fehlendem Parent gelten als Wurzel.
    if (!deck.parentId || !deckIds.has(deck.parentId)) freshToday += cappedFresh;
  }
  return { byDeck, dueToday: totalDue + freshToday };
}

export default function DeckList() {
  const decks = useLiveQuery(() => db.decks.toArray(), []);
  const cards = useLiveQuery(() => db.cards.toArray(), []);
  const streak = useLiveQuery(() => getReviewStreak(), []);
  // IDs der heute bereits eingeführten neuen Karten (erste Bewertung hat state 0).
  // Über den reviewedAt-Index bleibt die Abfrage auch bei großem Revlog klein.
  const introducedToday = useLiveQuery(async () => {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const todays = await db.revlog.where('reviewedAt').aboveOrEqual(midnight.getTime()).toArray();
    return new Set(todays.filter((entry) => entry.state === 0).map((entry) => entry.cardId));
  }, []);
  const [name, setName] = useState('');
  const [editMode, setEditMode] = useState(false);
  const navigate = useNavigate();

  const descendantIdsByDeck = useMemo(() => {
    const allDecks = decks ?? [];
    return new Map(allDecks.map((deck) =>
      [deck.id, descendantDeckIds(allDecks, deck.id)] as const));
  }, [decks]);

  const stats = useMemo(
    () => computeDeckStats(
      decks ?? [],
      cards ?? [],
      introducedToday ?? new Set<string>(),
      Date.now(),
      descendantIdsByDeck,
    ),
    [decks, cards, introducedToday, descendantIdsByDeck],
  );

  if (!decks || !cards) return <p className="muted">Lädt…</p>;

  const dueToday = stats.dueToday;

  async function onCreate() {
    const n = name.trim();
    if (!n) return;
    await createDeck(n);
    setName('');
  }

  async function handleDelete(deck: Deck) {
    const deckIds = descendantIdsByDeck.get(deck.id) ?? new Set([deck.id]);
    const cardCount = cards!.filter((c) => deckIds.has(c.deckId)).length;
    const msg = cardCount > 0
      ? `Deck „${deck.name}" und alle ${cardCount} Karten darin löschen?`
      : `Deck „${deck.name}" löschen?`;
    if (!window.confirm(msg)) return;
    await deleteDeck(deck.id);
  }

  return (
    <div>
      <div className="screen-head">
        <h1 className="screen-title">Decks</h1>
        {decks.length > 0 && (
          <button className="edit-toggle" onClick={() => setEditMode((v) => !v)}>
            {editMode ? 'Fertig' : 'Bearbeiten'}
          </button>
        )}
      </div>

      {decks.length > 0 && (
        <div className="study-summary">
          <span className="summary-stat">
            <span className="summary-flame" aria-hidden="true">🔥</span>
            <span className="summary-num">{streak ?? 0}</span>
            <span className="summary-label">{(streak ?? 0) === 1 ? 'Tag Streak' : 'Tage Streak'}</span>
          </span>
          <span className="summary-divider" aria-hidden="true" />
          <span className="summary-stat">
            <span className="summary-num">{dueToday}</span>
            <span className="summary-label">heute fällig</span>
          </span>
        </div>
      )}

      {decks.length === 0 ? (
        <p className="empty">Noch keine Decks. Lege unten eines an.</p>
      ) : (
        <div className="group">
          {decks.map((deck) => {
            const { due, fresh } = stats.byDeck.get(deck.id) ?? { due: 0, fresh: 0 };
            if (editMode) {
              return (
                <DeckEditRow
                  key={deck.id}
                  deck={deck}
                  onDelete={() => void handleDelete(deck)}
                />
              );
            }
            return (
              <div
                key={deck.id}
                className="row-item tappable"
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/app/deck/${deck.id}/study`)}
                onKeyDown={(e) => {
                  if (shouldActivateDeckRow(e.key, e.target, e.currentTarget)) {
                    e.preventDefault();
                    navigate(`/app/deck/${deck.id}/study`);
                  }
                }}
              >
                <span className="row-grow row-title">{deck.name}</span>
                <span className="pill-group">
                  {due > 0 && <span className="pill due">{due}</span>}
                  {fresh > 0 && <span className="pill fresh">{fresh}</span>}
                  {due === 0 && fresh === 0 && <span className="pill muted">0</span>}
                </span>
                <button
                  className="row-cram"
                  aria-label={`Alle Karten in „${deck.name}" durchgehen`}
                  title="Alle Karten durchgehen (ändert den Lernplan nicht)"
                  onClick={(e) => { e.stopPropagation(); navigate(`/app/deck/${deck.id}/cram`); }}
                >
                  <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                    <path d="M21 4v4h-4" />
                    <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
                    <path d="M3 20v-4h4" />
                  </svg>
                </button>
                <span className="chevron" aria-hidden="true">›</span>
              </div>
            );
          })}
        </div>
      )}

      <div className="new-deck">
        <span className="plus" aria-hidden="true">+</span>
        <input
          placeholder="Neues Deck…"
          aria-label="Neues Deck"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void onCreate()}
        />
      </div>
    </div>
  );
}

// Eine Zeile im Bearbeiten-Modus: roter Löschen-Punkt + direkt editierbarer Name.
function DeckEditRow({ deck, onDelete }: { deck: Deck; onDelete: () => void }) {
  const [value, setValue] = useState(deck.name);

  function commit() {
    const n = value.trim();
    if (n && n !== deck.name) void renameDeck(deck.id, n);
    else if (!n) setValue(deck.name);
  }

  return (
    <div className="row-item editing">
      <button className="row-delete" aria-label={`Deck „${deck.name}" löschen`} onClick={onDelete}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <circle cx="12" cy="12" r="10" fill="var(--again)" />
          <rect x="6.5" y="11" width="11" height="2" rx="1" fill="#fff" />
        </svg>
      </button>
      <input
        className="inline-rename"
        value={value}
        aria-label="Deck umbenennen"
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'Escape') {
            setValue(deck.name);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </div>
  );
}

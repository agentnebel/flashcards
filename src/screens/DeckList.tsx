import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { db } from '../db/db';
import { createDeck } from '../db/api';

export default function DeckList() {
  const decks = useLiveQuery(() => db.decks.toArray(), []);
  const cards = useLiveQuery(() => db.cards.toArray(), []);
  const [name, setName] = useState('');
  const navigate = useNavigate();

  if (!decks || !cards) return <p className="muted">Lädt…</p>;

  const now = Date.now();
  const counts = (deckId: string) => {
    const active = cards.filter((c) => c.deckId === deckId && !c.suspended && !c.deleted);
    return {
      due: active.filter((c) => c.fsrs.state !== 0 && c.due.getTime() <= now).length,
      fresh: active.filter((c) => c.fsrs.state === 0).length,
    };
  };

  async function onCreate() {
    const n = name.trim();
    if (!n) return;
    await createDeck(n);
    setName('');
  }

  return (
    <div>
      <h1 className="screen-title">Decks</h1>

      {decks.length === 0 ? (
        <p className="empty">Noch keine Decks. Lege unten eines an.</p>
      ) : (
        <div className="group">
          {decks.map((deck) => {
            const { due, fresh } = counts(deck.id);
            return (
              <div
                key={deck.id}
                className="row-item tappable"
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/deck/${deck.id}/study`)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    navigate(`/deck/${deck.id}/study`);
                  }
                }}
              >
                <span className="row-grow row-title">{deck.name}</span>
                <span className="pill-group">
                  {due > 0 && <span className="pill due">{due}</span>}
                  {fresh > 0 && <span className="pill fresh">{fresh}</span>}
                  {due === 0 && fresh === 0 && <span className="pill muted">0</span>}
                </span>
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
          onKeyDown={(e) => e.key === 'Enter' && onCreate()}
        />
      </div>
    </div>
  );
}

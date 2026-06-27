import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { db } from '../db/db';
import { createDeck } from '../db/api';

export default function DeckList() {
  const decks = useLiveQuery(() => db.decks.toArray(), []);
  const cards = useLiveQuery(() => db.cards.toArray(), []);
  const [name, setName] = useState('');

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
      {decks.length === 0 && <p className="empty">Noch keine Decks. Lege unten eines an.</p>}

      {decks.map((deck) => {
        const { due, fresh } = counts(deck.id);
        const total = due + fresh;
        return (
          <Link key={deck.id} to={`/deck/${deck.id}/study`} className="card-tile">
            <div>
              <div>{deck.name}</div>
              <div className="meta">
                <span className="badge due">{due}</span> fällig
                <span className="badge fresh">{fresh}</span> neu
              </div>
            </div>
            <button className="primary" disabled={total === 0}>
              {total === 0 ? 'Fertig' : 'Lernen'}
            </button>
          </Link>
        );
      })}

      <div style={{ marginTop: '1.5rem' }} className="row">
        <input
          placeholder="Neues Deck…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onCreate()}
        />
        <button onClick={onCreate}>+</button>
      </div>
    </div>
  );
}

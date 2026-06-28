import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { db } from '../db/db';
import type { Deck } from '../db/db';
import { createDeck, deleteDeck, renameDeck } from '../db/api';

export default function DeckList() {
  const decks = useLiveQuery(() => db.decks.toArray(), []);
  const cards = useLiveQuery(() => db.cards.toArray(), []);
  const [name, setName] = useState('');
  const [editMode, setEditMode] = useState(false);
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

  async function handleDelete(deck: Deck) {
    const cardCount = cards!.filter((c) => c.deckId === deck.id).length;
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

      {decks.length === 0 ? (
        <p className="empty">Noch keine Decks. Lege unten eines an.</p>
      ) : (
        <div className="group">
          {decks.map((deck) => {
            const { due, fresh } = counts(deck.id);
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

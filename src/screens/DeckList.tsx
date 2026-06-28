import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { db } from '../db/db';
import { createDeck, deleteDeck, renameDeck } from '../db/api';

export default function DeckList() {
  const decks = useLiveQuery(() => db.decks.toArray(), []);
  const cards = useLiveQuery(() => db.cards.toArray(), []);
  const [name, setName] = useState('');
  const [menuId, setMenuId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const menuRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  // Menü schließen bei Klick außerhalb
  useEffect(() => {
    if (!menuId) return;
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuId(null);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuId]);

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

  function startEdit(id: string, currentName: string) {
    setMenuId(null);
    setEditingId(id);
    setEditName(currentName);
  }

  async function commitRename(id: string) {
    const n = editName.trim();
    if (n) await renameDeck(id, n);
    setEditingId(null);
  }

  async function handleDelete(id: string) {
    setMenuId(null);
    const deck = (decks ?? []).find((d) => d.id === id);
    const cardCount = (cards ?? []).filter((c) => c.deckId === id).length;
    const msg = cardCount > 0
      ? `Deck „${deck?.name}" und alle ${cardCount} Karten darin löschen?`
      : `Deck „${deck?.name}" löschen?`;
    if (!window.confirm(msg)) return;
    await deleteDeck(id);
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
            const isEditing = editingId === deck.id;
            const menuOpen = menuId === deck.id;
            return (
              <div key={deck.id} className="row-item" style={{ position: 'relative' }}>
                {isEditing ? (
                  <input
                    className="inline-rename"
                    autoFocus
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commitRename(deck.id);
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                    onBlur={() => void commitRename(deck.id)}
                  />
                ) : (
                  <span
                    className="row-grow row-title tappable"
                    role="button"
                    tabIndex={0}
                    style={{ cursor: 'pointer' }}
                    onClick={() => navigate(`/deck/${deck.id}/study`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        navigate(`/deck/${deck.id}/study`);
                      }
                    }}
                  >
                    {deck.name}
                  </span>
                )}

                {!isEditing && (
                  <span className="pill-group">
                    {due > 0 && <span className="pill due">{due}</span>}
                    {fresh > 0 && <span className="pill fresh">{fresh}</span>}
                    {due === 0 && fresh === 0 && <span className="pill muted">0</span>}
                  </span>
                )}

                {!isEditing && (
                  <div ref={menuOpen ? menuRef : undefined} style={{ position: 'relative' }}>
                    <button
                      className="icon-btn"
                      aria-label="Deck-Optionen"
                      onClick={(e) => { e.stopPropagation(); setMenuId(menuOpen ? null : deck.id); }}
                    >
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
                        <circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>
                      </svg>
                    </button>

                    {menuOpen && (
                      <div className="action-menu">
                        <button onClick={() => startEdit(deck.id, deck.name)}>Umbenennen</button>
                        <button className="destructive" onClick={() => void handleDelete(deck.id)}>Löschen</button>
                      </div>
                    )}
                  </div>
                )}

                {!isEditing && (
                  <span className="chevron" aria-hidden="true" style={{ pointerEvents: 'none' }}>›</span>
                )}
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

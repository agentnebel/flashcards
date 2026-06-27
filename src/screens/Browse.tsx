import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { db } from '../db/db';
import { deleteNote } from '../db/api';
import { State } from 'ts-fsrs';

const STATE_LABEL: Record<number, string> = {
  [State.New]: 'neu',
  [State.Learning]: 'lernt',
  [State.Review]: 'review',
  [State.Relearning]: 'relearn',
};

export default function Browse() {
  const notes = useLiveQuery(() => db.notes.orderBy('updatedAt').reverse().toArray(), []);
  const cards = useLiveQuery(() => db.cards.toArray(), []);
  const [q, setQ] = useState('');

  if (!notes || !cards) return <p className="muted">Lädt…</p>;

  const filtered = notes.filter(
    (n) => !n.deleted && (!q || JSON.stringify(n.fields).toLowerCase().includes(q.toLowerCase())),
  );

  return (
    <div>
      <input placeholder="Suchen…" value={q} onChange={(e) => setQ(e.target.value)} />

      {filtered.length === 0 && <p className="empty">Keine Karten.</p>}

      <div style={{ marginTop: '1rem' }}>
        {filtered.map((n) => {
          const noteCards = cards.filter((c) => c.noteId === n.id && !c.deleted);
          const states = noteCards.map((c) => STATE_LABEL[c.fsrs.state] ?? '?');
          return (
            <div key={n.id} className="card-tile">
              <div style={{ minWidth: 0 }}>
                <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {n.sortField || <span className="muted">(leer)</span>}
                </div>
                <div className="meta">
                  {noteCards.length} Karte(n) · {states.join(', ')}
                </div>
              </div>
              <button onClick={() => deleteNote(n.id)} title="Löschen">🗑</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

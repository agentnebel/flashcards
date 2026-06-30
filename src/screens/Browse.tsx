import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '../db/db';
import { deleteNote } from '../db/api';
import { stripMarkdown } from '../lib/markdown';
import { State } from 'ts-fsrs';

const STATE_LABEL: Record<number, string> = {
  [State.New]: 'neu',
  [State.Learning]: 'lernt',
  [State.Review]: 'review',
  [State.Relearning]: 'relearn',
};

// chip-*-Präfix bewusst: ein nackter Klassenname wie „review" kollidiert mit der
// gleichnamigen .review-Klasse des Lern-Screens (Layout-Bug, siehe index.css).
const STATE_CHIP: Record<number, string> = {
  [State.New]: 'chip-new',
  [State.Learning]: 'chip-learning',
  [State.Review]: 'chip-review',
  [State.Relearning]: 'chip-relearn',
};

const PAGE = 50; // Fenstergröße fürs schrittweise Nachladen

// HTML-Tags (z. B. eingebettete <img>-Bilder) und Markdown-Marker für die Listen-Vorschau
// entfernen, damit dort weder Roh-HTML noch *Sternchen*/`Backticks` im Klartext auftauchen.
function stripTags(s: string): string {
  return stripMarkdown(s.replace(/<[^>]*>/g, '')).trim();
}

export default function Browse() {
  const notes = useLiveQuery(() => db.notes.orderBy('updatedAt').reverse().toArray(), []);
  const cards = useLiveQuery(() => db.cards.toArray(), []);
  const [q, setQ] = useState('');
  const [visible, setVisible] = useState(PAGE);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  // Bei neuer Suche das Fenster zurücksetzen.
  useEffect(() => { setVisible(PAGE); }, [q]);

  const filtered = (notes ?? []).filter(
    (n) => !n.deleted && (!q || JSON.stringify(n.fields).toLowerCase().includes(q.toLowerCase())),
  );
  const shown = filtered.slice(0, visible);
  const hasMore = filtered.length > visible;

  // Sentinel am Listenende lädt schrittweise nach, statt alles auf einmal zu rendern.
  useEffect(() => {
    if (!hasMore) return;
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) setVisible((v) => v + PAGE);
    }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, shown.length]);

  if (!notes || !cards) return <p className="muted">Lädt…</p>;

  return (
    <div>
      <h1 className="screen-title">Karten</h1>

      <div className="search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" />
        </svg>
        <input placeholder="Suchen…" aria-label="Karten suchen" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {filtered.length === 0 ? (
        <p className="empty">Keine Karten.</p>
      ) : (
        <div className="group">
          {shown.map((n) => {
            const noteCards = cards.filter((c) => c.noteId === n.id && !c.deleted);
            const seen = new Set<number>();
            const distinctStates = noteCards
              .map((c) => c.fsrs.state)
              .filter((s) => (seen.has(s) ? false : (seen.add(s), true)));
            return (
              <div key={n.id} className="row-item">
                <div className="row-grow">
                  <div className="row-title">
                    {stripTags(n.sortField) || <span className="muted">(leer)</span>}
                  </div>
                  <div className="row-sub">
                    {noteCards.length} Karte(n)
                    {distinctStates.length > 0 && ' · '}
                    {distinctStates.map((s) => (
                      <span key={s} className={`chip ${STATE_CHIP[s] ?? 'chip-new'}`} style={{ marginLeft: 4 }}>
                        {STATE_LABEL[s] ?? '?'}
                      </span>
                    ))}
                  </div>
                </div>
                <button className="icon-btn" onClick={() => navigate(`/edit/${n.id}`)} title="Bearbeiten" aria-label="Karte bearbeiten" style={{ minWidth: 44, minHeight: 44 }}>
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>
                <button className="icon-btn destructive" onClick={() => void deleteNote(n.id)} title="Löschen" aria-label="Karte löschen" style={{ minWidth: 44, minHeight: 44 }}>
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
                  </svg>
                </button>
              </div>
            );
          })}
          {hasMore && <div ref={sentinel} className="list-sentinel" aria-hidden="true" />}
        </div>
      )}
    </div>
  );
}

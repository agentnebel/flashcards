import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { db, type Card, type Deck, type Note } from '../db/db';
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

// Deck-Pfad „Eltern › Kind" für eindeutige Sektionsüberschriften (auch bei Unterdecks).
function deckPath(deckId: string, byId: Map<string, Deck>): string {
  const parts: string[] = [];
  let cur: Deck | undefined = byId.get(deckId);
  let guard = 0;
  while (cur && guard++ < 20) {
    parts.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return parts.length ? parts.join(' › ') : 'Ohne Deck';
}

function distinctStates(noteCards: Card[]): number[] {
  const seen = new Set<number>();
  return noteCards.map((c) => c.fsrs.state).filter((s) => (seen.has(s) ? false : (seen.add(s), true)));
}

export default function Browse() {
  const notes = useLiveQuery(() => db.notes.orderBy('updatedAt').reverse().toArray(), []);
  const cards = useLiveQuery(() => db.cards.toArray(), []);
  const decks = useLiveQuery(() => db.decks.toArray(), []);
  const [q, setQ] = useState('');
  const [visible, setVisible] = useState(PAGE);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const sentinel = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  // Bei neuer Suche das Fenster zurücksetzen.
  useEffect(() => { setVisible(PAGE); }, [q]);

  const deckById = useMemo(() => {
    const m = new Map<string, Deck>();
    for (const d of decks ?? []) m.set(d.id, d);
    return m;
  }, [decks]);

  // Karten je Notiz (für Anzahl + Status-Chips in der Unterzeile).
  const cardsByNote = useMemo(() => {
    const m = new Map<string, Card[]>();
    for (const c of cards ?? []) {
      if (c.deleted) continue;
      const arr = m.get(c.noteId);
      if (arr) arr.push(c);
      else m.set(c.noteId, [c]);
    }
    return m;
  }, [cards]);

  const filtered = useMemo(
    () =>
      (notes ?? []).filter(
        (n) => !n.deleted && (!q || JSON.stringify(n.fields).toLowerCase().includes(q.toLowerCase())),
      ),
    [notes, q],
  );

  // Notizen nach Deck gruppieren; Sektionen alphabetisch nach Deck-Pfad. Innerhalb einer
  // Sektion bleibt die „zuletzt bearbeitet"-Reihenfolge erhalten (filtered ist so sortiert).
  const groups = useMemo(() => {
    const byDeck = new Map<string, Note[]>();
    for (const n of filtered) {
      const arr = byDeck.get(n.deckId);
      if (arr) arr.push(n);
      else byDeck.set(n.deckId, [n]);
    }
    return [...byDeck.entries()]
      .map(([deckId, ns]) => ({ deckId, path: deckPath(deckId, deckById), notes: ns }))
      .sort((a, b) => a.path.localeCompare(b.path, 'de'));
  }, [filtered, deckById]);

  // Gruppen in eine flache Item-Liste (Header + Notizen) auflösen, damit das bestehende
  // Windowing (Sentinel) über Sektionsgrenzen hinweg funktioniert. Eingeklappte Sektionen
  // tragen nur ihren Header bei.
  type Item =
    | { kind: 'header'; deckId: string; path: string; count: number }
    | { kind: 'note'; note: Note };
  // Bei aktiver Suche das Einklappen überstimmen, sonst blieben Treffer in einer zuvor
  // eingeklappten Sektion unsichtbar.
  const searching = q.trim() !== '';
  const items = useMemo(() => {
    const out: Item[] = [];
    for (const g of groups) {
      out.push({ kind: 'header', deckId: g.deckId, path: g.path, count: g.notes.length });
      if (searching || !collapsed.has(g.deckId)) for (const n of g.notes) out.push({ kind: 'note', note: n });
    }
    return out;
  }, [groups, collapsed, searching]);

  const sliced = items.slice(0, visible);
  const hasMore = items.length > visible;

  // Sentinel am Listenende lädt schrittweise nach.
  useEffect(() => {
    if (!hasMore) return;
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) setVisible((v) => v + PAGE);
    }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, sliced.length]);

  function toggle(deckId: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(deckId)) next.delete(deckId);
      else next.add(deckId);
      return next;
    });
  }

  if (!notes || !cards || !decks) return <p className="muted">Lädt…</p>;

  // Aus der gefensterten Item-Liste die Blöcke bauen: jede Notiz-Folge landet in einer
  // eigenen .group-Karte (Inset-Grouped-Look), jeder Header steht darüber.
  const blocks: ReactNode[] = [];
  let buf: ReactNode[] = [];
  let bufKey = '';
  const flush = () => {
    if (buf.length) {
      blocks.push(<div className="group" key={`g-${bufKey}`}>{buf}</div>);
      buf = [];
    }
  };
  for (const it of sliced) {
    if (it.kind === 'header') {
      flush();
      const isCollapsed = !searching && collapsed.has(it.deckId);
      blocks.push(
        <button
          key={`h-${it.deckId}`}
          className={`browse-sec${isCollapsed ? '' : ' open'}`}
          aria-expanded={!isCollapsed}
          onClick={() => toggle(it.deckId)}
        >
          <svg className="sec-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 6l6 6-6 6" />
          </svg>
          <svg className="sec-folder" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
          <span className="sec-name">{it.path}</span>
          <span className="sec-count">{it.count}</span>
        </button>,
      );
      bufKey = it.deckId;
    } else {
      const n = it.note;
      const noteCards = cardsByNote.get(n.id) ?? [];
      const states = distinctStates(noteCards);
      buf.push(
        <div key={n.id} className="row-item">
          <div className="row-grow">
            <div className="row-title">
              {stripTags(n.sortField) || <span className="muted">(leer)</span>}
            </div>
            <div className="row-sub">
              {noteCards.length} Karte(n)
              {states.length > 0 && ' · '}
              {states.map((s) => (
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
        </div>,
      );
    }
  }
  flush();

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

      {items.length === 0 ? (
        <p className="empty">Keine Karten.</p>
      ) : (
        <>
          {blocks}
          {hasMore && <div ref={sentinel} className="list-sentinel" aria-hidden="true" />}
        </>
      )}
    </div>
  );
}

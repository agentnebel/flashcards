import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Rating } from 'ts-fsrs';
import type { Grade } from 'ts-fsrs';
import { db, type Card } from '../db/db';
import {
  answerCard,
  getDesiredRetention,
  getStudyQueue,
  previewDueDates,
} from '../db/api';
import { renderCard } from '../lib/cardgen';
import { resolveMediaHtml } from '../lib/media';
import { fmtInterval } from '../scheduler/fsrs';

const GRADES: { grade: Grade; label: string; cls: string; key: string }[] = [
  { grade: Rating.Again, label: 'Nochmal', cls: 'again', key: '1' },
  { grade: Rating.Hard, label: 'Schwer', cls: 'hard', key: '2' },
  { grade: Rating.Good, label: 'Gut', cls: 'good', key: '3' },
  { grade: Rating.Easy, label: 'Einfach', cls: 'easy', key: '4' },
];

export default function Review() {
  const { deckId } = useParams<{ deckId: string }>();
  const [queue, setQueue] = useState<Card[] | null>(null);
  const [rendered, setRendered] = useState<{ front: string; back: string } | null>(null);
  const [previews, setPreviews] = useState<Record<number, Date>>({});
  const [revealed, setRevealed] = useState(false);
  const [retention, setRetention] = useState(0.9);

  const current = queue?.[0] ?? null;

  const reload = useCallback(async () => {
    if (!deckId) return;
    const q = await getStudyQueue(deckId);
    setQueue(q);
  }, [deckId]);

  useEffect(() => {
    getDesiredRetention().then(setRetention);
    reload();
  }, [reload]);

  // Aktuelle Karte rendern + Intervallvorschau berechnen.
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!current) {
        setRendered(null);
        return;
      }
      const note = await db.notes.get(current.noteId);
      const nt = await db.noteTypes.get(current.noteTypeId);
      if (!alive || !note || !nt) return;
      const raw = renderCard(note, nt, current);
      // flashmedia:HASH-Referenzen in Object-URLs der lokalen Blobs auflösen.
      const [front, back] = await Promise.all([
        resolveMediaHtml(raw.front),
        resolveMediaHtml(raw.back),
      ]);
      if (!alive) return;
      setRendered({ front, back });
      setPreviews(previewDueDates(current, retention));
      setRevealed(false);
    })();
    return () => {
      alive = false;
    };
  }, [current, retention]);

  const onAnswer = useCallback(
    async (grade: Grade) => {
      if (!current) return;
      await answerCard(current, grade, retention);
      setQueue((q) => {
        const rest = (q ?? []).slice(1);
        return rest;
      });
    },
    [current, retention],
  );

  // Wenn die Schlange leer wird: ggf. neu fällige Lernkarten nachladen.
  useEffect(() => {
    if (queue && queue.length === 0) {
      reload();
    }
  }, [queue, reload]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!current) return;
      if (!revealed && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault();
        setRevealed(true);
        return;
      }
      if (revealed) {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          onAnswer(Rating.Good);
        }
        const g = GRADES.find((x) => x.key === e.key);
        if (g) onAnswer(g.grade);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, revealed, onAnswer]);

  if (!queue) return <p className="muted">Lädt…</p>;

  if (!current) {
    return (
      <div className="empty stack">
        <p>🎉 Alles erledigt für jetzt!</p>
        <Link to="/" className="btn primary">Zurück zu den Decks</Link>
      </div>
    );
  }

  return (
    <div className="review">
      <div className="review-head">
        <Link to="/" className="tint-text">‹ Decks</Link>
        <span className="queue">{queue.length} in der Schlange</span>
      </div>

      <div className="review-card">
        <div
          key={revealed ? 'back' : 'front'}
          className={`face${revealed ? ' back' : ''}`}
          dangerouslySetInnerHTML={{ __html: revealed ? rendered?.back ?? '' : rendered?.front ?? '' }}
        />
      </div>

      {!revealed ? (
        <div className="answer-cta">
          <button className="primary block" onClick={() => setRevealed(true)}>
            Antwort zeigen
          </button>
          <p className="reveal-hint">(Leertaste)</p>
        </div>
      ) : (
        <div className="grade-bar">
          {GRADES.map(({ grade, label, cls }) => (
            <button key={grade} className={cls} onClick={() => onAnswer(grade)}>
              <span className="glabel">{label}</span>
              <span className="givl">{previews[grade] ? fmtInterval(previews[grade]) : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

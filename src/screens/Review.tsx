import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Rating } from 'ts-fsrs';
import type { Grade, RecordLog } from 'ts-fsrs';
import { db, type Card } from '../db/db';
import {
  commitReview,
  getCramQueue,
  getDesiredRetention,
  getStudyQueue,
  scheduleCard,
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

// Kurze haptische Rückmeldung (sofern unterstützt).
function buzz(ms: number) {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try { navigator.vibrate(ms); } catch { /* ignore */ }
  }
}

const SWIPE_THRESHOLD = 90; // px bis eine Geste als Bewertung zählt

export default function Review({ mode = 'study' }: { mode?: 'study' | 'cram' }) {
  const { deckId } = useParams<{ deckId: string }>();
  const cram = mode === 'cram';
  const [queue, setQueue] = useState<Card[] | null>(null);
  const [rendered, setRendered] = useState<{ front: string; back: string } | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [retention, setRetention] = useState(0.9);
  const [done, setDone] = useState(0);
  const [drag, setDrag] = useState(0); // aktuelle horizontale Swipe-Verschiebung
  const [leaving, setLeaving] = useState<'left' | 'right' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const current = queue?.[0] ?? null;

  // FSRS-Plan EINMAL pro Karte berechnen (gleiches `now` für Vorschau und späteres Speichern).
  // Im Cram-Modus nicht nötig – dort wird nichts geplant/gespeichert.
  const schedule = useMemo<RecordLog | null>(
    () => (current && !cram ? scheduleCard(current, retention) : null),
    [current, retention, cram],
  );
  // Sitzungsgröße für den Fortschrittsring: erledigt + verbleibend.
  const total = done + (queue?.length ?? 0);

  // In dieser Session bereits beantwortete Karten – schützt vor Doppelbewertung und
  // verhindert, dass ein Reload eine gerade (write-behind) beantwortete Karte zurückholt,
  // bevor der DB-Write committet ist.
  const answeredIds = useRef<Set<string>>(new Set());

  const reload = useCallback(async () => {
    if (!deckId) return;
    if (cram) {
      // Cram: einmal ALLE Karten laden; kein answeredIds-Filter (Re-Queue erlaubt Wiedersehen).
      setQueue(await getCramQueue(deckId));
      return;
    }
    const q = await getStudyQueue(deckId);
    setQueue(q.filter((c) => !answeredIds.current.has(c.id)));
  }, [deckId, cram]);

  useEffect(() => {
    getDesiredRetention().then(setRetention);
    reload();
  }, [reload]);

  // Periodisch neu fällige Karten in die laufende Session mischen (nur Study, nicht Cram):
  // eine mit "Nochmal" bewertete Karte wird in ~1–10 Min wieder fällig (FSRS Learning-Step),
  // taucht aber sonst nie wieder auf — die Session lädt die Schlange nach dem ersten Laden
  // nie erneut nach, außer wenn sie ganz leer wird (siehe unten). Alle 20s die aktuelle
  // Schlange mit frisch fälligen Karten ergänzen (anhängen, nicht ersetzen: Reihenfolge/
  // aktuelle Karte bleiben unangetastet).
  useEffect(() => {
    if (cram || !deckId) return;
    const timer = window.setInterval(async () => {
      const fresh = await getStudyQueue(deckId);
      setQueue((q) => {
        const cur = q ?? [];
        const existing = new Set(cur.map((c) => c.id));
        const toAdd = fresh.filter((c) => !existing.has(c.id) && !answeredIds.current.has(c.id));
        return toAdd.length ? [...cur, ...toAdd] : cur;
      });
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [deckId, cram]);

  // Screen Wake Lock: Bildschirm bleibt während der Session an.
  useEffect(() => {
    let lock: { release(): Promise<void> } | null = null;
    let released = false;
    type WakeLockSentinel = { release(): Promise<void>; addEventListener?: (t: string, cb: () => void) => void };
    const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinel> } };
    const acquire = async () => {
      try {
        if (nav.wakeLock && document.visibilityState === 'visible') {
          const l = await nav.wakeLock.request('screen');
          if (released) { void l.release().catch(() => {}); return; } // zwischenzeitlich unmounted
          lock = l;
          // Gibt das System den Lock frei (Akku etc.), während die Seite sichtbar ist → erneut anfordern.
          l.addEventListener?.('release', () => {
            lock = null;
            if (!released && document.visibilityState === 'visible') void acquire();
          });
        }
      } catch { /* nicht kritisch */ }
    };
    void acquire();
    const onVisible = () => { if (document.visibilityState === 'visible' && !released) void acquire(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      released = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => {});
    };
  }, []);

  // Medien einer Karte rendern (für aktuelle Karte + Prefetch der nächsten).
  const renderFor = useCallback(async (card: Card) => {
    const note = await db.notes.get(card.noteId);
    const nt = await db.noteTypes.get(card.noteTypeId);
    if (!note || !nt) return null;
    const raw = renderCard(note, nt, card);
    const [front, back] = await Promise.all([
      resolveMediaHtml(raw.front),
      resolveMediaHtml(raw.back),
    ]);
    return { front, back };
  }, []);

  // Aktuelle Karte rendern; nächste Karte vorab laden.
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!current) { setRendered(null); return; }
      setRendered(null);
      setRevealed(false);
      setDrag(0);
      setLeaving(null);
      const r = await renderFor(current);
      if (!alive) return;
      if (!r) {
        // Notiz/Notiztyp fehlt lokal (z. B. auf einem anderen Gerät gelöscht, oder ein
        // Notiztyp aus dem Sync noch nicht angekommen) — Karte überspringen statt die
        // Session mit einem dauerhaften "Lädt…" zu blockieren.
        console.warn('Karte ohne lokale Notiz/Notiztyp übersprungen:', current.id);
        setQueue((q) => (q ?? []).slice(1));
        return;
      }
      setRendered(r);
      // Prefetch: Medien der nächsten Karte im Hintergrund auflösen (Cache wärmt sich).
      const next = queue?.[1];
      if (next) void renderFor(next);
    })();
    return () => { alive = false; };
  }, [current, renderFor, queue]);

  const onAnswer = useCallback(
    (grade: Grade) => {
      if (!current) return;
      buzz(grade === Rating.Again ? 18 : 10);

      // Cram-/Wiederholungsmodus: KEINE FSRS-/Revlog-Änderung. „Nochmal" hängt die Karte ans
      // Ende der Session-Schlange (später erneut zeigen), alles andere geht weiter.
      if (cram) {
        setRevealed(false); // deckt den 1-Karten-Fall ab, in dem `current` gleich bleibt
        if (grade === Rating.Again) {
          setQueue((q) => {
            const a = q ?? [];
            return a.length > 1 ? [...a.slice(1), a[0]] : a; // bei nur 1 Karte vorne lassen
          });
        } else {
          setDone((n) => n + 1);
          setQueue((q) => (q ?? []).slice(1));
        }
        return;
      }

      if (!schedule) return;
      setError(null);
      // Re-Entrancy-Schutz: dieselbe Karte nie zweimal bewerten (schneller Doppeltipp,
      // Tasten-Autorepeat, Swipe+Klick) – sonst doppelter Revlog-Eintrag + übersprungene Folgekarte.
      if (answeredIds.current.has(current.id)) return;
      answeredIds.current.add(current.id);
      // Optimistisch: Schlange sofort weiterschalten, DB-Write (vorab berechneter Plan) läuft write-behind.
      // Schlägt der Write fehl (z. B. Speicher-Quota), Karte wieder freigeben — sie kommt
      // beim nächsten Nachladen der Schlange zurück, statt still verloren zu gehen.
      commitReview(current, schedule[grade])
        .then(() => {
          // Erst NACH dem committeten Write freigeben: eine mit "Nochmal" bewertete Karte
          // wird (Learning-Step) in ein paar Minuten wieder fällig und muss dann über den
          // periodischen Re-Check (oben) in dieser Session erneut auftauchen können — bliebe
          // sie dauerhaft in answeredIds, würde sie erst beim nächsten Deck-Öffnen wiederkommen.
          answeredIds.current.delete(current.id);
        })
        .catch((err) => {
          console.error('Bewertung konnte nicht gespeichert werden:', err);
          answeredIds.current.delete(current.id);
          setDone((n) => Math.max(0, n - 1));
          setError((err as Error).message || 'Bewertung konnte nicht gespeichert werden.');
          void reload();
        });
      setDone((n) => n + 1);
      setQueue((q) => (q ?? []).slice(1));
    },
    [current, schedule, cram, reload],
  );

  // Wenn die Schlange leer wird: einmal neu fällige Lernkarten nachladen.
  // Im Cram-Modus NICHT – leere Schlange bedeutet dort: Durchlauf fertig.
  // Guard per Ref: reload() liefert bei weiterhin nichts Fälligem wieder ein leeres Array
  // (neue Referenz) → ohne den Guard würde dieser Effekt sich selbst endlos erneut auslösen
  // (Dauerschleife von IndexedDB-Abfragen, solange der Screen offen bleibt). Der periodische
  // Re-Check oben übernimmt das weitere Nachladen, sobald tatsächlich etwas fällig wird.
  const emptyReloadedRef = useRef(false);
  useEffect(() => {
    if (cram || !queue) return;
    if (queue.length > 0) { emptyReloadedRef.current = false; return; }
    if (emptyReloadedRef.current) return;
    emptyReloadedRef.current = true;
    reload();
  }, [queue, reload, cram]);

  const reveal = useCallback(() => {
    if (revealed || !rendered) return;
    setError(null);
    buzz(8);
    setRevealed(true);
  }, [revealed, rendered]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!current || !rendered) return;
      if (e.repeat) return; // gedrückt gehaltene Taste nicht als Mehrfachbewertung werten
      if (!revealed && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault();
        reveal();
        return;
      }
      if (revealed) {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          onAnswer(Rating.Good);
          return;
        }
        const g = GRADES.find((x) => x.key === e.key);
        if (g) onAnswer(g.grade);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, rendered, revealed, onAnswer, reveal]);

  // --- Swipe (Pointer) ---
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const dragging = useRef(false);
  const dragXRef = useRef(0); // Live-Delta (zuverlässiger als der ggf. veraltete drag-State)

  const onPointerDown = (e: React.PointerEvent) => {
    if (!revealed || leaving) return;
    dragStart.current = { x: e.clientX, y: e.clientY };
    dragging.current = false;
    dragXRef.current = 0;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragStart.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    if (!dragging.current) {
      // Geste erst als horizontalen Swipe werten, wenn klar horizontal.
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy)) return;
      dragging.current = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    dragXRef.current = dx;
    setDrag(dx);
  };
  const endDrag = () => {
    if (!dragStart.current) return;
    const dx = dragXRef.current;
    dragStart.current = null;
    if (dragging.current && Math.abs(dx) >= SWIPE_THRESHOLD) {
      const dir = dx > 0 ? 'right' : 'left';
      setLeaving(dir);
      // Karte rausfliegen lassen, dann bewerten.
      setDrag(dx > 0 ? window.innerWidth : -window.innerWidth);
      window.setTimeout(() => onAnswer(dir === 'right' ? Rating.Good : Rating.Again), 180);
    } else {
      setDrag(0);
    }
    dragging.current = false;
  };

  if (!queue) {
    return (
      <div className="review">
        <div className="review-head">
          <Link to="/app" className="tint-text">‹ Decks</Link>
        </div>
        <p className="muted">Lädt…</p>
      </div>
    );
  }

  if (!current) {
    return (
      <div className="empty stack">
        {cram ? (
          <>
            <p>✅ Alle Karten durchgegangen!</p>
            <button
              className="btn primary"
              onClick={() => { setDone(0); answeredIds.current.clear(); reload(); }}
            >
              Noch einmal von vorn
            </button>
            <Link to="/app" className="tint-text">Zurück zu den Decks</Link>
          </>
        ) : (
          <>
            <p>🎉 Alles erledigt für jetzt!</p>
            <Link to="/app" className="btn primary">Zurück zu den Decks</Link>
            {deckId && (
              <Link to={`/app/deck/${deckId}/cram`} className="tint-text">Trotzdem alle Karten wiederholen</Link>
            )}
          </>
        )}
      </div>
    );
  }

  const pct = total > 0 ? done / total : 0;
  const swipeHint = drag > 24 ? 'good' : drag < -24 ? 'again' : null;
  const faceHtml = rendered ? (revealed ? rendered.back : rendered.front) : null;
  const cardStyle: React.CSSProperties = drag !== 0 || leaving
    ? {
        transform: `translateX(${drag}px) rotate(${drag * 0.04}deg)`,
        transition: dragStart.current ? 'none' : 'transform .18s var(--ease)',
        opacity: leaving ? 0 : 1,
        userSelect: 'none', // während des Wischens keine Textauswahl (Geste vs. Selektion)
      }
    : {};

  return (
    <div className="review">
      <div className="review-head">
        <Link to="/app" className="tint-text">‹ Decks</Link>
        {cram && <span className="cram-tag" title="Ändert deinen Lernplan nicht">Wiederholung</span>}
        <ProgressRing pct={pct} label={`${done}/${total}`} />
      </div>

      <div className="review-stage">
        {swipeHint && <div className={`swipe-hint ${swipeHint}`}>{swipeHint === 'good' ? 'Gut' : 'Nochmal'}</div>}
        <div
          className="review-card"
          style={cardStyle}
          onClick={!revealed ? reveal : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div
            key={faceHtml ? (revealed ? 'back' : 'front') : 'loading'}
            className="face"
            dangerouslySetInnerHTML={faceHtml ? { __html: faceHtml } : undefined}
          >
            {!faceHtml ? <span className="muted">Lädt…</span> : null}
          </div>
        </div>
      </div>

      {!revealed ? (
        <div className="answer-cta">
          <button className="primary block" disabled={!rendered} onClick={reveal}>
            Antwort zeigen
          </button>
          {error && <p className="feedback err">{error}</p>}
          <p className="reveal-hint">Leertaste · Tippen</p>
        </div>
      ) : cram ? (
        <div className="grade-bar cram">
          <button className="again" onClick={() => onAnswer(Rating.Again)}>
            <span className="glabel">Nochmal</span>
          </button>
          <button className="good" onClick={() => onAnswer(Rating.Good)}>
            <span className="glabel">Gewusst</span>
          </button>
        </div>
      ) : (
        <div className="grade-bar">
          {GRADES.map(({ grade, label, cls }) => (
            <button key={grade} className={cls} onClick={() => onAnswer(grade)}>
              <span className="glabel">{label}</span>
              <span className="givl">{schedule ? fmtInterval(schedule[grade].card.due) : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Kleiner SVG-Fortschrittsring für die Session.
function ProgressRing({ pct, label }: { pct: number; label: string }) {
  const r = 11;
  const c = 2 * Math.PI * r;
  return (
    <span className="progress-ring" aria-label={`Fortschritt ${label}`}>
      <svg viewBox="0 0 28 28" width="28" height="28">
        <circle cx="14" cy="14" r={r} fill="none" stroke="var(--separator)" strokeWidth="3" />
        <circle
          cx="14" cy="14" r={r} fill="none"
          stroke="var(--tint)" strokeWidth="3" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - pct)}
          transform="rotate(-90 14 14)"
          style={{ transition: 'stroke-dashoffset .3s var(--ease)' }}
        />
      </svg>
      <span className="progress-label">{label}</span>
    </span>
  );
}

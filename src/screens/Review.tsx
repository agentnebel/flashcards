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
import { scopeImportedCardCss } from '../lib/cardCss';
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

const TEXT_INPUT_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const NATIVE_ACTION_SELECTOR = 'a, button, summary, details, [role="button"], [role="link"]';

// Globale Lern-Shortcuts dürfen native Keyboard-Aktionen nicht übersteuern:
// Enter auf „Decks" muss navigieren und Enter auf einem Bewertungsbutton dessen eigene
// Bewertung auslösen. In Textfeldern sind sämtliche Lern-Shortcuts deaktiviert.
export function shouldHandleReviewShortcut(key: string, target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  if (target.closest(TEXT_INPUT_SELECTOR)) return false;
  if ((key === 'Enter' || key === ' ') && target.closest(NATIVE_ACTION_SELECTOR)) return false;
  return true;
}

export function typedAnswerMatches(given: string, expected: string): boolean {
  const normalize = (value: string) =>
    value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  return normalize(given) === normalize(expected);
}

// Frisch fällige Karten anhängen, ohne die bereits sichtbare Karte zu ersetzen. Bleibt
// nichts hinzuzufügen, wird bewusst dieselbe Array-Referenz zurückgegeben.
export function mergeStudyQueue(
  currentQueue: Card[],
  fresh: Card[],
  answeredIds: ReadonlySet<string>,
  skippedIds: ReadonlySet<string>,
): Card[] {
  const existing = new Set(currentQueue.map((card) => card.id));
  const toAdd = fresh.filter(
    (card) => !existing.has(card.id) && !answeredIds.has(card.id) && !skippedIds.has(card.id),
  );
  return toAdd.length ? [...currentQueue, ...toAdd] : currentQueue;
}

export default function Review({ mode = 'study' }: { mode?: 'study' | 'cram' }) {
  const { deckId } = useParams<{ deckId: string }>();
  const cram = mode === 'cram';
  const [queue, setQueue] = useState<Card[] | null>(null);
  const [rendered, setRendered] = useState<{
    front: string;
    back: string;
    css: string;
    typeAnswer?: string;
  } | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [typedAnswer, setTypedAnswer] = useState('');
  const [committing, setCommitting] = useState(false);
  const [retention, setRetention] = useState(0.9);
  const [done, setDone] = useState(0);
  const [drag, setDrag] = useState(0); // aktuelle horizontale Swipe-Verschiebung
  const [leaving, setLeaving] = useState<'left' | 'right' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const current = queue?.[0] ?? null;

  // FSRS-Vorschau pro Karte berechnen. Beim tatsächlichen Bewerten wird der Plan mit dem
  // dann aktuellen Zeitpunkt erneut berechnet, damit Revlog und Fälligkeit nicht auf dem
  // Zeitpunkt hängen bleiben, zu dem die Karte erstmals angezeigt wurde.
  const schedule = useMemo<RecordLog | null>(
    () => (current && !cram ? scheduleCard(current, retention) : null),
    [current, retention, cram],
  );
  // Sitzungsgröße für den Fortschrittsring: erledigt + verbleibend.
  const total = done + (queue?.length ?? 0);
  // Nur bei Kartenwechsel neu scopen: der Parser liefe sonst bei jedem Swipe-Pointer-Move
  // (setDrag → Re-Render) über das komplette Notiztyp-CSS importierter Decks.
  const scopedCardCss = useMemo(() => scopeImportedCardCss(rendered?.css ?? ''), [rendered]);

  // In dieser Session bereits beantwortete Karten – schützt vor Doppelbewertung und
  // verhindert, dass ein Reload eine gerade (write-behind) beantwortete Karte zurückholt,
  // bevor der DB-Write committet ist.
  const answeredIds = useRef<Set<string>>(new Set());
  // Ein gemeinsamer Guard sperrt direkte Bewertungen und die verzögerte Swipe-
  // Bewertung. Auch Cram darf durch Swipe + Button/Shortcut nicht zwei Karten
  // in einem Übergang weiterschalten.
  const answeringRef = useRef(false);
  const swipeTimerRef = useRef<number | null>(null);
  const unlockTimerRef = useRef<number | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  // Lokal kaputte/orphan Karten (fehlende Note oder NoteType) pro Session merken. Sonst lädt
  // die Empty-Queue-Logik dieselbe Karte sofort wieder und der Screen skippt im Kreis.
  const skippedIds = useRef<Set<string>>(new Set());

  const reload = useCallback(async () => {
    if (!deckId) return;
    if (cram) {
      // Cram: einmal ALLE Karten laden; kein answeredIds-Filter (Re-Queue erlaubt Wiedersehen).
      const q = await getCramQueue(deckId);
      setQueue(q.filter((c) => !skippedIds.current.has(c.id)));
      return;
    }
    const q = await getStudyQueue(deckId);
    setQueue(q.filter((c) => !answeredIds.current.has(c.id) && !skippedIds.current.has(c.id)));
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
        return mergeStudyQueue(cur, fresh, answeredIds.current, skippedIds.current);
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
    return { front, back, css: nt.css, typeAnswer: raw.typeAnswer };
  }, []);

  // Nur ein Wechsel der aktuellen Karte setzt Reveal-/Swipe-State zurück. Ein bloßes
  // Anhängen neu fälliger Karten an die Queue darf die sichtbare Karte nicht umdrehen.
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!current) { setRendered(null); return; }
      setRendered(null);
      setRevealed(false);
      setTypedAnswer('');
      setCommitting(false);
      setDrag(0);
      setLeaving(null);
      const r = await renderFor(current);
      if (!alive) return;
      if (!r) {
        // Notiz/Notiztyp fehlt lokal (z. B. auf einem anderen Gerät gelöscht, oder ein
        // Notiztyp aus dem Sync noch nicht angekommen) — Karte überspringen statt die
        // Session mit einem dauerhaften "Lädt…" zu blockieren.
        console.warn('Karte ohne lokale Notiz/Notiztyp übersprungen:', current.id);
        skippedIds.current.add(current.id);
        setQueue((q) => (q ?? []).filter((c) => c.id !== current.id));
        return;
      }
      setRendered(r);
    })();
    return () => { alive = false; };
  }, [current, renderFor]);

  // Prefetch getrennt vom Render-State: die nächste Karte darf sich durch einen Queue-
  // Refresh ändern, ohne `revealed` der aktuellen Karte zurückzusetzen.
  const next = queue?.[1] ?? null;
  useEffect(() => {
    if (next) void renderFor(next);
  }, [next, renderFor]);

  const releaseAnswerLock = useCallback(() => {
    answeringRef.current = false;
    setTransitioning(false);
  }, []);

  useEffect(
    () => () => {
      if (swipeTimerRef.current !== null) window.clearTimeout(swipeTimerRef.current);
      if (unlockTimerRef.current !== null) window.clearTimeout(unlockTimerRef.current);
      answeringRef.current = false;
    },
    [],
  );

  const onAnswer = useCallback(
    (grade: Grade, swipeLockHeld = false) => {
      if (!current) {
        if (swipeLockHeld) releaseAnswerLock();
        return;
      }
      if (answeringRef.current && !swipeLockHeld) return;
      if (!swipeLockHeld) answeringRef.current = true;

      // Cram-/Wiederholungsmodus: KEINE FSRS-/Revlog-Änderung. „Nochmal" hängt die Karte ans
      // Ende der Session-Schlange (später erneut zeigen), alles andere geht weiter.
      if (cram) {
        setTransitioning(true);
        buzz(grade === Rating.Again ? 18 : 10);
        setRevealed(false); // deckt den 1-Karten-Fall ab, in dem `current` gleich bleibt
        setTypedAnswer('');
        if (grade === Rating.Again) {
          // Bei genau einer Karte bleibt `current` identisch; deshalb würde der Render-
          // Effekt nicht erneut laufen. Swipe-State hier explizit zurücksetzen.
          setDrag(0);
          setLeaving(null);
          setQueue((q) => {
            const a = q ?? [];
            return a.length > 1 ? [...a.slice(1), a[0]] : a; // bei nur 1 Karte vorne lassen
          });
        } else {
          setDone((n) => n + 1);
          setQueue((q) => (q ?? []).slice(1));
        }
        // Bis zum nächsten Event-Loop-Turn gesperrt lassen: React rendert zuerst die
        // neue Queue, erst danach darf die nächste Karte bewertet werden.
        if (unlockTimerRef.current !== null) window.clearTimeout(unlockTimerRef.current);
        unlockTimerRef.current = window.setTimeout(() => {
          unlockTimerRef.current = null;
          releaseAnswerLock();
        }, 0);
        return;
      }

      if (!schedule) {
        releaseAnswerLock();
        return;
      }
      setError(null);
      // Re-Entrancy-Schutz: dieselbe Karte nie zweimal bewerten (schneller Doppeltipp,
      // Tasten-Autorepeat, Swipe+Klick) – sonst doppelter Revlog-Eintrag + übersprungene Folgekarte.
      if (answeredIds.current.has(current.id)) {
        releaseAnswerLock();
        return;
      }
      answeredIds.current.add(current.id);
      setCommitting(true);
      buzz(grade === Rating.Again ? 18 : 10);
      // Der Vorschauplan kann schon länger sichtbar sein. Für Persistenz immer den
      // tatsächlichen Bewertungszeitpunkt verwenden.
      const answerSchedule = scheduleCard(current, retention, new Date());
      // Erst nach dem erfolgreichen Transaktions-Commit weiterschalten. So kann ein
      // Tab-Schließen direkt nach dem Klick keine nur visuell gezählte Bewertung verlieren.
      commitReview(current, answerSchedule[grade])
        .then(() => {
          setDone((n) => n + 1);
          setQueue((q) => (q ?? []).slice(1));
          // Erst NACH dem committeten Write freigeben: eine mit "Nochmal" bewertete Karte
          // wird (Learning-Step) in ein paar Minuten wieder fällig und muss dann über den
          // periodischen Re-Check (oben) in dieser Session erneut auftauchen können — bliebe
          // sie dauerhaft in answeredIds, würde sie erst beim nächsten Deck-Öffnen wiederkommen.
          answeredIds.current.delete(current.id);
        })
        .catch((err) => {
          console.error('Bewertung konnte nicht gespeichert werden:', err);
          answeredIds.current.delete(current.id);
          setDrag(0);
          setLeaving(null);
          setError((err as Error).message || 'Bewertung konnte nicht gespeichert werden.');
        })
        .finally(() => {
          setCommitting(false);
          releaseAnswerLock();
        });
    },
    [current, schedule, cram, retention, releaseAnswerLock],
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

  const onCardClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (revealed) return;
    const target = event.target;
    if (target instanceof Element && target.closest('input, button, select, textarea, a, summary')) {
      return;
    }
    reveal();
  };

  const onCardInput = (event: React.FormEvent<HTMLDivElement>) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.classList.contains('type-answer')) {
      setTypedAnswer(target.value);
    }
  };

  const onCardKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      !revealed &&
      event.key === 'Enter' &&
      event.target instanceof HTMLInputElement &&
      event.target.classList.contains('type-answer')
    ) {
      event.preventDefault();
      reveal();
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!current || !rendered) return;
      if (answeringRef.current) return;
      if (e.repeat) return; // gedrückt gehaltene Taste nicht als Mehrfachbewertung werten
      if (!shouldHandleReviewShortcut(e.key, e.target)) return;
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
    if (!revealed || leaving || answeringRef.current) return;
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
      if (answeringRef.current) {
        setDrag(0);
        dragging.current = false;
        return;
      }
      answeringRef.current = true;
      setTransitioning(true);
      const dir = dx > 0 ? 'right' : 'left';
      setLeaving(dir);
      // Karte rausfliegen lassen, dann bewerten.
      setDrag(dx > 0 ? window.innerWidth : -window.innerWidth);
      if (swipeTimerRef.current !== null) window.clearTimeout(swipeTimerRef.current);
      swipeTimerRef.current = window.setTimeout(() => {
        swipeTimerRef.current = null;
        onAnswer(dir === 'right' ? Rating.Good : Rating.Again, true);
      }, 180);
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
              onClick={() => { setDone(0); answeredIds.current.clear(); skippedIds.current.clear(); reload(); }}
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
          onClick={!revealed ? onCardClick : undefined}
          onInput={onCardInput}
          onKeyDown={onCardKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <style>{scopedCardCss}</style>
          <div
            key={faceHtml ? (revealed ? 'back' : 'front') : 'loading'}
            className={`face card card${(current?.templateOrd ?? 0) + 1}`}
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
          <button
            className="again"
            disabled={transitioning}
            onClick={() => onAnswer(Rating.Again)}
          >
            <span className="glabel">Nochmal</span>
          </button>
          <button
            className="good"
            disabled={transitioning}
            onClick={() => onAnswer(Rating.Good)}
          >
            <span className="glabel">Gewusst</span>
          </button>
        </div>
      ) : (
        <>
          {rendered?.typeAnswer !== undefined && (
            <div
              className={`type-answer-result ${
                typedAnswerMatches(typedAnswer, rendered.typeAnswer) ? 'correct' : 'incorrect'
              }`}
              aria-live="polite"
            >
              <span>Deine Antwort: {typedAnswer || '—'}</span>
              <strong>
                {typedAnswerMatches(typedAnswer, rendered.typeAnswer) ? 'Richtig' : 'Abweichend'}
              </strong>
            </div>
          )}
          <div className="grade-bar" aria-busy={committing}>
            {GRADES.map(({ grade, label, cls }) => (
              <button
                key={grade}
                className={cls}
                disabled={committing || transitioning}
                onClick={() => onAnswer(grade)}
              >
                <span className="glabel">{committing ? 'Speichert…' : label}</span>
                <span className="givl">{schedule ? fmtInterval(schedule[grade].card.due) : ''}</span>
              </button>
            ))}
          </div>
        </>
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

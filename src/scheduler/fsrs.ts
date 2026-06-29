import { fsrs, generatorParameters, createEmptyCard, Rating, State } from 'ts-fsrs';
import type { Card as FsrsCard, FSRS } from 'ts-fsrs';

export { Rating, State, createEmptyCard };
export type { FsrsCard };

// FSRS-Scheduler mit nutzergewählter Ziel-Retention (Default 90 %) + Fuzz.
// Default-Gewichte; Parameter-Optimierung aus dem Revlog folgt in einer späteren Phase.
export function makeScheduler(requestRetention = 0.9): FSRS {
  return fsrs(
    generatorParameters({
      request_retention: requestRetention,
      enable_fuzz: true,
    }),
  );
}

// Menschlich lesbares Intervall zwischen jetzt und Fälligkeit.
export function fmtInterval(due: Date, now: Date = new Date()): string {
  const ms = due.getTime() - now.getTime();
  if (ms <= 0) return 'fällig';
  const min = ms / 60000;
  if (min < 60) return `${Math.max(1, Math.round(min))} min`;
  const h = min / 60;
  // Vor dem Vergleich runden, damit z. B. 23,6 h als "1 d" statt "24 h" erscheint.
  if (Math.round(h) < 24) return `${Math.round(h)} h`;
  const d = h / 24;
  if (Math.round(d) < 30) return `${Math.round(d)} d`;
  const mo = d / 30;
  if (Math.round(mo) < 12) return `${Math.round(mo)} mo`;
  return `${(d / 365).toFixed(1)} y`;
}

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
  const min = ms / 60000;
  if (min < 60) return `${Math.max(1, Math.round(min))} min`;
  const h = min / 60;
  if (h < 24) return `${Math.round(h)} h`;
  const d = h / 24;
  if (d < 30) return `${Math.round(d)} d`;
  const mo = d / 30;
  if (mo < 12) return `${Math.round(mo)} mo`;
  return `${(d / 365).toFixed(1)} y`;
}

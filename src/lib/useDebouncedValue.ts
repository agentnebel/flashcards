import { useEffect, useState } from 'react';

/**
 * Liefert `value` erst, nachdem es `delayMs` lang unverändert blieb. Für Eingaben, deren
 * Auswertung pro Tastendruck zu teuer ist (Volltextsuche, CSV-Parse) — das Eingabefeld
 * selbst bleibt dabei sofort reaktiv, nur die abgeleitete Berechnung wird entprellt.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

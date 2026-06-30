import { useSyncExternalStore } from 'react';

// Reaktiver Online-Status auf Basis der Browser-Events `online`/`offline`.
// Funktioniert identisch auf Mobile und Desktop und erfordert keine Netzwerk-Pings:
// der Browser pflegt navigator.onLine selbst und feuert die Events bei jedem Wechsel.

function subscribe(cb: () => void): () => void {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

function getSnapshot(): boolean {
  // navigator.onLine === false ist verlässlich „offline"; true heißt nur „evtl. online".
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

function getServerSnapshot(): boolean {
  return true; // SSR/Build: optimistisch online annehmen
}

/** Liefert `true`, solange der Browser eine Netzverbindung meldet. */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

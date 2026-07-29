// Originweiter Daten-Lock für alle länger laufenden oder schreibenden lokalen Operationen.
// Die Web Locks API koordiniert Tabs/PWA-Fenster; die Promise-Kette ist der Fallback für
// Tests/ältere Browser und bewahrt innerhalb eines Tabs die Aufrufreihenfolge.
const ORIGIN_LOCK_NAME = 'flashcards-local-data-v1';
const RESET_STATE_KEY = 'flashcards-local-data-reset-v1';

interface ResetState {
  token: string;
  pending: boolean;
}

let fallbackState: ResetState = { token: 'initial', pending: false };

function readResetState(): ResetState {
  try {
    const raw = globalThis.localStorage?.getItem(RESET_STATE_KEY);
    if (!raw) return fallbackState;
    const parsed = JSON.parse(raw) as Partial<ResetState>;
    if (typeof parsed.token === 'string' && typeof parsed.pending === 'boolean') {
      fallbackState = { token: parsed.token, pending: parsed.pending };
    }
  } catch {
    // localStorage kann in restriktiven Browser-Kontexten gesperrt sein; Prozess-Fallback.
  }
  return fallbackState;
}

function writeResetState(state: ResetState): void {
  fallbackState = state;
  try {
    globalThis.localStorage?.setItem(RESET_STATE_KEY, JSON.stringify(state));
  } catch {
    // Der lokale Fallback bleibt auch ohne Storage wirksam.
  }
}

function newResetToken(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

let contextToken: string | null = (() => {
  const state = readResetState();
  return state.pending ? null : state.token;
})();
let tail: Promise<void> = Promise.resolve();
let resetPending = 0;

async function originExclusive<T>(operation: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks) {
    return locks.request(ORIGIN_LOCK_NAME, { mode: 'exclusive' }, operation);
  }
  return operation();
}

async function queuedExclusive<T>(operation: () => Promise<T>): Promise<T> {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await originExclusive(operation);
  } finally {
    release();
  }
}

export class LocalDataResetError extends Error {}

// Normale Datenoperation: Nach Erhalt des originweiten Locks nochmals prüfen, ob ein
// anderes Fenster die lokale Sitzung seit dem Seitenstart zurückgesetzt hat.
export async function withLocalDataOperation<T>(operation: () => Promise<T>): Promise<T> {
  if (resetPending > 0) {
    throw new LocalDataResetError('Operation wegen laufender Abmeldung abgebrochen.');
  }
  const expectedToken = contextToken;
  return queuedExclusive(async () => {
    const state = readResetState();
    if (!expectedToken || state.pending || state.token !== expectedToken) {
      throw new LocalDataResetError(
        'Lokale Sitzung wurde in einem anderen Fenster zurückgesetzt. Bitte Seite neu laden.',
      );
    }
    return operation();
  });
}

// Destruktiver Konto-Reset: Token schon VOR dem Warten veröffentlichen. Andere Tabs
// können dadurch keine neue Operation hinter den Reset einreihen und mit altem UI-State
// anschließend Daten des vorherigen Kontos zurückschreiben.
export async function withLocalDataReset<T>(operation: () => Promise<T>): Promise<T> {
  resetPending += 1;
  const token = newResetToken();
  try {
    return await queuedExclusive(async () => {
      // Token innerhalb desselben originweiten Locks publizieren und abschließen. Zwei
      // gleichzeitige Resets können sich dadurch nicht gegenseitig per lost update wieder
      // freischalten.
      writeResetState({ token, pending: true });
      try {
        return await operation();
      } finally {
        writeResetState({ token, pending: false });
        contextToken = token;
      }
    });
  } finally {
    resetPending -= 1;
  }
}

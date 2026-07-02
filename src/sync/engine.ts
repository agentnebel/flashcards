// Client-Sync-Schleife (M2): Auth + Delta-Sync gegen die eigene JSON-API.
//
// Ablauf von sync(): pull (remote anwenden) → push (Outbox senden) → pull (Cursor
// settlen) → Medien-Sync. Konflikte: Last-Write-Wins per `updatedAt`. Reviews/Revlog
// sind append-only. Der Cursor (change_log-seq) und das Auth-Token liegen in `meta`.

import type { Table } from 'dexie';
import { db } from '../db/db';
import type { Card, Note, RevlogEntry } from '../db/db';
import { ensureMediaForHtml, uploadPendingMedia } from './media';

type Row = Record<string, unknown>;

export interface Auth {
  token: string;
  userId: string;
  email: string;
}

export interface SyncState {
  syncing: boolean;
  lastSyncAt: number | null;
  error: string | null;
}

interface PullChange {
  entity: string;
  entityId: string;
  deleted: boolean;
  payload: unknown;
  seq: number;
}

class AuthError extends Error {}

// API ist same-origin (der Worker serviert auch das Frontend); im Dev proxyt Vite /api.
const BASE = '';

// ---- Status-Emitter (für UI) ----
let state: SyncState = { syncing: false, lastSyncAt: null, error: null };
const listeners = new Set<() => void>();

export function getSyncState(): SyncState {
  return state;
}
export function subscribeSync(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function setState(patch: Partial<SyncState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

// ---- Auth ----
export async function getAuth(): Promise<Auth | null> {
  const m = await db.meta.get('auth');
  return (m?.value as Auth) ?? null;
}

async function apiPost(path: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function authResult(res: Response): Promise<Auth> {
  if (!res.ok) {
    const msg = ((await res.json().catch(() => ({}))) as { error?: string }).error;
    throw new Error(msg || `Fehler ${res.status}`);
  }
  const { token, user } = (await res.json()) as { token: string; user: { id: string; email: string } };
  const auth: Auth = { token, userId: user.id, email: user.email };
  // Kontowechsel erkennen: Meldet sich ein ANDERES Konto an als das, dem die lokalen
  // Daten zuletzt gehörten, werden diese vorher gelöscht — sonst würde die Outbox des
  // alten Kontos unter dem neuen Token hochgeladen (Kontamination). Gleiches Konto
  // (z. B. nach Session-Ablauf) behält Daten, Cursor und Outbox. Ohne lastAccountId
  // (nie gesynct) bleiben lokale Karten erhalten und werden hochgeladen (wie beworben).
  const prev = await db.meta.get('lastAccountId');
  if (typeof prev?.value === 'string' && prev.value !== user.id) {
    await wipeLocalData();
  }
  await db.meta.put({ key: 'lastAccountId', value: user.id });
  await db.meta.put({ key: 'auth', value: auth });
  setState({ error: null });
  return auth;
}

export async function register(email: string, password: string): Promise<Auth> {
  return authResult(await apiPost('/api/auth/register', { email, password }));
}
export async function login(email: string, password: string): Promise<Auth> {
  return authResult(await apiPost('/api/auth/login', { email, password }));
}
// Lokale Daten vollständig löschen (Tabellen + Sync-Zustand). Wird nur beim expliziten
// Logout und beim Kontowechsel aufgerufen — NICHT bei abgelaufener Session, sonst wären
// alle seit dem letzten Sync entstandenen (ungesyncten) Änderungen unwiderruflich weg.
async function wipeLocalData(): Promise<void> {
  await db.transaction(
    'rw',
    [db.decks, db.noteTypes, db.notes, db.cards, db.revlog, db.outbox, db.media, db.meta],
    async () => {
      await Promise.all([
        db.decks.clear(),
        db.noteTypes.clear(),
        db.notes.clear(),
        db.cards.clear(),
        db.revlog.clear(),
        db.outbox.clear(),
        db.media.clear(),
      ]);
      await db.meta.delete('auth');
      await db.meta.delete('syncCursor'); // nächste Anmeldung startet mit vollständigem Pull
      await db.meta.delete('lastSyncAt');
      await db.meta.delete('lastAccountId');
    },
  );
}

export async function logout(): Promise<void> {
  // Explizites Abmelden: lokale Daten vollständig löschen. Sonst blieben auf einem
  // geteilten Gerät die Karten/Notizen des Vorkontos sichtbar und – schlimmer – die noch
  // nicht gesyncte Outbox würde beim nächsten Login unter fremdem Token hochgeladen.
  // Synchronisierte Daten gehen nicht verloren: Login pullt ab Cursor 0 alles erneut.
  await wipeLocalData();
  setState({ lastSyncAt: null });
}

// ---- Cursor ----
async function getCursor(): Promise<number> {
  const m = await db.meta.get('syncCursor');
  return typeof m?.value === 'number' ? m.value : 0;
}
async function setCursor(c: number): Promise<void> {
  await db.meta.put({ key: 'syncCursor', value: c });
}

// ---- Anwenden eingehender Änderungen ----
function tableFor(entity: string): Table<Row, string> | null {
  switch (entity) {
    case 'deck': return db.decks as unknown as Table<Row, string>;
    case 'note': return db.notes as unknown as Table<Row, string>;
    case 'card': return db.cards as unknown as Table<Row, string>;
    case 'revlog': return db.revlog as unknown as Table<Row, string>;
    case 'noteType': return db.noteTypes as unknown as Table<Row, string>;
    default: return null;
  }
}

// JSON-Transport serialisiert Date → String; hier wieder zu Date-Objekten machen.
function revive(entity: string, payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (entity === 'card') {
    const c = p as unknown as Card;
    c.due = new Date(c.due as unknown as string);
    if (c.fsrs) {
      const f = c.fsrs as unknown as { due: unknown; last_review?: unknown };
      if (f.due) f.due = new Date(f.due as string);
      if (f.last_review) f.last_review = new Date(f.last_review as string);
    }
  } else if (entity === 'revlog') {
    const r = p as unknown as RevlogEntry;
    if (r.due) r.due = new Date(r.due as unknown as string);
  }
  return p;
}

async function applyChange(ch: PullChange, touchedHtml: string[]): Promise<void> {
  const table = tableFor(ch.entity);
  if (!table) return;

  if (ch.deleted) {
    await table.delete(ch.entityId);
    return;
  }
  const payload = revive(ch.entity, ch.payload);
  if (!payload) return;

  // Revlog ist unveränderlich – nur einfügen, wenn noch nicht vorhanden.
  if (ch.entity === 'revlog') {
    if (!(await table.get(ch.entityId))) await table.add(payload);
    return;
  }

  // Last-Write-Wins: lokale, neuere Änderung nicht durch ältere Remote-Version überschreiben.
  const local = (await table.get(ch.entityId)) as { updatedAt?: number } | undefined;
  const remoteAt = typeof payload.updatedAt === 'number' ? payload.updatedAt : 0;
  if (local && typeof local.updatedAt === 'number' && local.updatedAt > remoteAt) return;

  await table.put(payload);

  if (ch.entity === 'note') {
    const note = payload as unknown as Note;
    for (const v of Object.values(note.fields ?? {})) touchedHtml.push(v);
  }
}

async function pullAll(token: string, touchedHtml: string[]): Promise<void> {
  let cursor = await getCursor();
  for (let guard = 0; guard < 5000; guard++) {
    const res = await apiPost('/api/sync/pull', { cursor }, token);
    if (res.status === 401) throw new AuthError();
    if (!res.ok) throw new Error(`Pull fehlgeschlagen (${res.status})`);
    const data = (await res.json()) as { cursor: number; changes: PullChange[]; hasMore: boolean };
    for (const ch of data.changes) await applyChange(ch, touchedHtml);
    cursor = data.cursor;
    await setCursor(cursor);
    if (!data.hasMore) return;
  }
  // Schutzgrenze erreicht, obwohl der Server noch mehr Änderungen hat → Fehler sichtbar machen,
  // statt das Gerät stillschweigend unvollständig zu lassen.
  throw new Error('Sync unvollständig (zu viele Änderungen). Bitte erneut synchronisieren.');
}

async function pushOutbox(token: string): Promise<void> {
  const CHUNK = 500;
  for (let guard = 0; guard < 10000; guard++) {
    const items = await db.outbox.orderBy('id').limit(CHUNK).toArray();
    if (items.length === 0) break;
    const maxId = items[items.length - 1].id as number;
    const mutations = items.map((i) => ({
      op: i.op,
      entity: i.entity,
      entityId: i.entityId,
      payload: i.payload,
    }));
    const res = await apiPost('/api/sync/push', { mutations }, token);
    if (res.status === 401) throw new AuthError();
    if (!res.ok) throw new Error(`Push fehlgeschlagen (${res.status})`);
    await db.outbox.where('id').belowOrEqual(maxId).delete();
    if (items.length < CHUNK) break;
  }
}

let inFlight: Promise<void> | null = null;

// Vollständiger Sync-Durchlauf (idempotent, überlappungsfrei).
export function sync(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = runSync().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runSync(): Promise<void> {
  const auth = await getAuth();
  if (!auth) return;
  setState({ syncing: true, error: null });
  try {
    const touchedHtml: string[] = [];
    await pullAll(auth.token, touchedHtml);
    await pushOutbox(auth.token);
    await pullAll(auth.token, touchedHtml); // Cursor über eigene Writes hinweg settlen

    // Medien: lokale Blobs hochladen (R2; 503-tolerant) + fehlende Bilder nachladen.
    await uploadPendingMedia(BASE, auth.token);
    const seen = new Set<string>();
    for (const html of touchedHtml) {
      if (seen.has(html)) continue;
      seen.add(html);
      await ensureMediaForHtml(BASE, auth.token, html);
    }

    const now = Date.now();
    await db.meta.put({ key: 'lastSyncAt', value: now });
    setState({ syncing: false, lastSyncAt: now, error: null });
  } catch (e) {
    if (e instanceof AuthError) {
      // Session abgelaufen (JWT hat 30 Tage TTL): NUR das Token verwerfen. Daten, Cursor
      // und Outbox bleiben erhalten — beim erneuten Login mit demselben Konto wird die
      // Outbox normal gepusht. Ein Wipe hier würde ungesyncte Arbeit vernichten.
      await db.meta.delete('auth');
      setState({ syncing: false, error: 'Sitzung abgelaufen – bitte neu anmelden.' });
    } else {
      setState({ syncing: false, error: (e as Error).message || 'Sync fehlgeschlagen.' });
    }
  }
}

// Letzten Sync-Zeitpunkt aus der DB laden (für Anzeige nach App-Start).
export async function loadLastSyncAt(): Promise<void> {
  const m = await db.meta.get('lastSyncAt');
  if (typeof m?.value === 'number') setState({ lastSyncAt: m.value });
}

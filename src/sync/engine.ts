// Client-Sync-Schleife (M2): Auth + Delta-Sync gegen die eigene JSON-API.
//
// Ablauf von sync(): pull (remote anwenden) → push (Outbox senden) → pull (Cursor
// settlen) → Medien-Sync. Konflikte: Last-Write-Wins per `updatedAt`. Revlogs werden nur
// beim Löschen ihrer Notiz bzw. ihres Decks entfernt. Cursor und Auth-Token liegen in `meta`.

import type { Table } from 'dexie';
import { db } from '../db/db';
import type { Card, RevlogEntry } from '../db/db';
import { ensureSeed } from '../db/seed';
import {
  LocalDataResetError,
  withLocalDataOperation,
  withLocalDataReset,
} from '../db/localDataLock';
import {
  MAX_SYNC_MUTATIONS,
  MAX_SYNC_REQUEST_BYTES,
  type SyncMutation,
  validateSyncMutations,
} from '../lib/syncProtocol';
import {
  downloadReferencedMedia,
  garbageCollectRemoteMedia,
  revalidateReferencedMedia,
  uploadPendingMedia,
} from './media';

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
  updatedAt?: number;
}

class AuthError extends Error {}
class SyncCancelled extends Error {}
class PushBudgetReached extends Error {}
class MediaGcDeferred extends Error {}

// API ist same-origin (der Worker serviert auch das Frontend); im Dev proxyt Vite /api.
const BASE = '';
const MEDIA_REVALIDATION_INTERVAL_MS = 24 * 60 * 60_000;
const MAX_PUSH_REQUESTS_PER_SYNC = 240;
const DEFERRED_OUTBOX_CURSOR_KEY = 'deferredOutboxCursor';
const syncEncoder = new TextEncoder();
const SYNC_BODY_FIXED_BYTES =
  syncEncoder.encode('{"mutations":[').byteLength + syncEncoder.encode(']}').byteLength;

// ---- Status-Emitter (für UI) ----
let state: SyncState = { syncing: false, lastSyncAt: null, error: null };
const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;
let activeController: AbortController | null = null;
let syncEpoch = 0;
let syncBlocked = false;

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

function assertSyncActive(epoch: number, signal: AbortSignal): void {
  if (signal.aborted || epoch !== syncEpoch) throw new SyncCancelled();
}

// Destruktive Konto-Übergänge sperren neue Sync-Läufe, invalidieren den aktuellen
// Lauf und warten ihn vollständig ab. Ein bereits gestarteter IndexedDB-Schreibvorgang
// darf noch enden, wird aber garantiert vor dem anschließenden Wipe abgeschlossen.
async function pauseSyncAndWait(): Promise<void> {
  syncBlocked = true;
  syncEpoch += 1;
  activeController?.abort();
  const pending = inFlight;
  if (pending) await pending.catch(() => undefined);
  setState({ syncing: false });
}

function resumeSync(): void {
  syncBlocked = false;
}

// ---- Auth ----
export async function getAuth(): Promise<Auth | null> {
  const m = await db.meta.get('auth');
  return (m?.value as Auth) ?? null;
}

async function apiPost(path: string, body: unknown, token?: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
}

async function authResult(
  res: Response,
  confirmedPreviousAccountId?: string,
): Promise<Auth> {
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
    // Destruktiv (löscht lokale, ggf. ungesyncte Daten) — vorher bestätigen lassen, statt
    // z. B. einen Vertipper bei der E-Mail oder ein falsches gespeichertes Passwort auf
    // einem Gerät mit noch offenen Änderungen stillschweigend Daten vernichten zu lassen.
    const proceed =
      confirmedPreviousAccountId === prev.value ||
      typeof window === 'undefined' ||
      window.confirm(
        'Dieses Konto unterscheidet sich vom zuletzt auf diesem Gerät genutzten. ' +
          'Lokale, noch nicht synchronisierte Änderungen werden dabei gelöscht. Fortfahren?',
    );
    if (!proceed) throw new Error('Anmeldung abgebrochen (anderes Konto).');
    await pauseSyncAndWait();
    try {
      return await withLocalDataReset(async () => {
        await wipeLocalData();
        await db.meta.put({ key: 'lastAccountId', value: user.id });
        await db.meta.put({ key: 'auth', value: auth });
        setState({ syncing: false, lastSyncAt: null, error: null });
        return auth;
      });
    } finally {
      resumeSync();
    }
  }
  return withLocalDataOperation(async () => {
    await db.meta.put({ key: 'lastAccountId', value: user.id });
    await db.meta.put({ key: 'auth', value: auth });
    setState({ error: null });
    return auth;
  });
}

async function confirmRegistrationAccountSwitch(): Promise<string | undefined> {
  const prev = await db.meta.get('lastAccountId');
  if (typeof prev?.value !== 'string') return undefined;
  const proceed =
    typeof window === 'undefined' ||
    window.confirm(
      'Die Registrierung erstellt ein neues Konto. Lokale Daten des zuletzt auf diesem ' +
        'Gerät genutzten Kontos werden beim Wechsel gelöscht. Fortfahren?',
    );
  if (!proceed) throw new Error('Registrierung abgebrochen (neues Konto).');
  return prev.value;
}

export async function register(email: string, password: string, inviteCode: string): Promise<Auth> {
  // Vor dem mutierenden Server-Request bestätigen. Sonst wären bei einem anschließenden
  // Abbruch bereits ein Konto erstellt und der Einmal-Einladungscode verbraucht.
  const confirmedPreviousAccountId = await confirmRegistrationAccountSwitch();
  return authResult(
    await apiPost('/api/auth/register', { email, password, inviteCode }),
    confirmedPreviousAccountId,
  );
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
      await db.meta.delete('lastMediaGcAt');
      await db.meta.delete('lastMediaRevalidationAt');
      await db.meta.delete('mediaRevalidationCursor');
      await db.meta.delete('mediaDownloadCursor');
      await db.meta.delete(DEFERRED_OUTBOX_CURSOR_KEY);
    },
  );
  // Ohne dies bliebe die App bis zum nächsten harten Reload ohne Standard-Deck/-Notiztypen
  // (z. B. "Hinzufügen" dauerhaft unbenutzbar, weil kein Notiztyp zur Auswahl steht).
  await ensureSeed();
}

export async function logout(): Promise<void> {
  // Explizites Abmelden: lokale Daten vollständig löschen. Sonst blieben auf einem
  // geteilten Gerät die Karten/Notizen des Vorkontos sichtbar und – schlimmer – die noch
  // nicht gesyncte Outbox würde beim nächsten Login unter fremdem Token hochgeladen.
  // Synchronisierte Daten gehen nicht verloren: Login pullt ab Cursor 0 alles erneut.
  await pauseSyncAndWait();
  try {
    await withLocalDataReset(async () => {
      await wipeLocalData();
      setState({ syncing: false, lastSyncAt: null, error: null });
    });
  } finally {
    resumeSync();
  }
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

// Minimale Schemaprüfung je Entität NACH revive: Der Server validiert nur generische
// JSON-Sicherheit, nicht die Fachstruktur. Ein defekter Payload eines anderen Clients
// (z. B. Karte ohne `due` → Invalid Date → nie fällig) würde sonst still übernommen und
// wäre lokal kaum noch auffindbar. Kaputte Datensätze werden übersprungen und geloggt;
// der Cursor läuft weiter, damit ein Einzelfall nicht den ganzen Sync blockiert.
function isValidSyncedEntity(entity: string, p: Record<string, unknown>): boolean {
  const validDate = (value: unknown): boolean =>
    value instanceof Date && !Number.isNaN(value.getTime());
  const isString = (value: unknown): boolean => typeof value === 'string';
  switch (entity) {
    case 'deck':
      return isString(p.name);
    case 'note':
      return isString(p.deckId) && isString(p.noteTypeId) &&
        Boolean(p.fields) && typeof p.fields === 'object' && !Array.isArray(p.fields);
    case 'card': {
      const fsrs = p.fsrs as { due?: unknown } | undefined;
      return isString(p.noteId) && isString(p.deckId) && validDate(p.due) &&
        Boolean(fsrs) && typeof fsrs === 'object' && validDate(fsrs?.due);
    }
    case 'revlog':
      return isString(p.cardId) && validDate(p.due) &&
        typeof p.reviewedAt === 'number' && Number.isFinite(p.reviewedAt);
    case 'noteType':
      return isString(p.name) && Array.isArray(p.fields) && Array.isArray(p.templates);
    default:
      return true;
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

async function applyChange(ch: PullChange): Promise<void> {
  const table = tableFor(ch.entity);
  if (!table) return;

  const local = (await table.get(ch.entityId)) as {
    updatedAt?: number;
    reviewedAt?: number;
  } | undefined;
  const localAt =
    typeof local?.updatedAt === 'number'
      ? local.updatedAt
      : typeof local?.reviewedAt === 'number'
        ? local.reviewedAt
        : 0;
  const pending = await db.outbox
    .where('[entity+entityId]')
    .equals([ch.entity, ch.entityId])
    .count();
  const payloadAt =
    ch.payload && typeof ch.payload === 'object' &&
      typeof (ch.payload as Record<string, unknown>).updatedAt === 'number'
      ? (ch.payload as Record<string, unknown>).updatedAt as number
      : 0;
  const remoteAt = typeof ch.updatedAt === 'number' ? ch.updatedAt : payloadAt;

  if (ch.deleted) {
    if (pending > 0 && localAt > remoteAt) return;
    await table.delete(ch.entityId);
    return;
  }
  const payload = revive(ch.entity, ch.payload);
  if (!payload) return;
  if (!isValidSyncedEntity(ch.entity, payload)) {
    console.warn('Ungültigen Sync-Datensatz übersprungen:', ch.entity, ch.entityId);
    return;
  }

  // Revlog ist unveränderlich – nur einfügen, wenn noch nicht vorhanden.
  if (ch.entity === 'revlog') {
    if (!(await table.get(ch.entityId))) await table.add(payload);
    return;
  }

  // Last-Write-Wins: lokale, neuere Änderung nicht durch ältere Remote-Version überschreiben.
  // Nur eine noch nicht gepushte lokale Änderung darf einen älteren Pull überstimmen.
  // Ohne Outbox ist der Serverstand autoritativ (u. a. nach serverseitigem Future-Clock-Clamp).
  if (pending > 0 && localAt > remoteAt) return;

  await table.put(payload);
}

async function pullAll(token: string, epoch: number, signal: AbortSignal): Promise<void> {
  assertSyncActive(epoch, signal);
  let cursor = await getCursor();
  assertSyncActive(epoch, signal);
  for (let guard = 0; guard < 5000; guard++) {
    const res = await apiPost('/api/sync/pull', { cursor }, token, signal);
    assertSyncActive(epoch, signal);
    if (res.status === 401) throw new AuthError();
    if (!res.ok) throw new Error(`Pull fehlgeschlagen (${res.status})`);
    const data = (await res.json()) as { cursor: number; changes: PullChange[]; hasMore: boolean };
    assertSyncActive(epoch, signal);
    await withLocalDataOperation(async () => {
      assertSyncActive(epoch, signal);
      for (const ch of data.changes) {
        assertSyncActive(epoch, signal);
        await applyChange(ch);
      }
      cursor = data.cursor;
      assertSyncActive(epoch, signal);
      await setCursor(cursor);
    });
    assertSyncActive(epoch, signal);
    if (!data.hasMore) return;
  }
  // Schutzgrenze erreicht, obwohl der Server noch mehr Änderungen hat → Fehler sichtbar machen,
  // statt das Gerät stillschweigend unvollständig zu lassen.
  throw new Error('Sync unvollständig (zu viele Änderungen). Bitte erneut synchronisieren.');
}

function rejectedSyncMessage(count: number): string | null {
  if (count === 0) return null;
  return `${count} lokale Änderung${count === 1 ? '' : 'en'} überschreiten den Sync-Vertrag ` +
    'oder sind ungültig. Sie bleiben lokal und blockieren spätere Änderungen nicht; ' +
    'bitte den betroffenen Inhalt verkleinern bzw. erneut speichern.';
}

async function markOutboxRejected(item: import('../db/db').OutboxItem, reason: string): Promise<void> {
  if (item.id === undefined) return;
  await withLocalDataOperation(() =>
    db.outbox.put({ ...item, syncError: reason }).then(() => undefined));
}

interface PushContext {
  requests: number;
  pushed: number;
  deferred: Map<number, string>;
  // Frühere Läufe haben diese IDs bereits geprüft und wegen Quota zurückgestellt.
  initialCursor: number;
}

async function removePushedOutbox(
  items: import('../db/db').OutboxItem[],
  context: PushContext,
): Promise<void> {
  const sentIds = new Set(items.flatMap((item) => item.id === undefined ? [] : [item.id]));
  const newestSentByEntity = new Map<string, number>();
  for (const item of items) {
    if (item.id === undefined) continue;
    const key = `${item.entity}\u0000${item.entityId}`;
    newestSentByEntity.set(key, Math.max(newestSentByEntity.get(key) ?? 0, item.id));
  }
  await withLocalDataOperation(() =>
    db.transaction('rw', db.outbox, async () => {
      const queued = await db.outbox.toArray();
      const deleteIds = queued.flatMap((item) => {
        if (item.id === undefined) return [];
        if (sentIds.has(item.id)) return [item.id];
        const supersededBy = newestSentByEntity.get(`${item.entity}\u0000${item.entityId}`);
        const deferred = context.deferred.has(item.id) || item.id <= context.initialCursor;
        // Eine später akzeptierte Vollversion ersetzt ältere zurückgestellte Snapshots.
        // Sonst könnte der Retry bei gleichem updatedAt die neuere Version zurückdrehen.
        return (item.syncError || deferred) && supersededBy !== undefined && item.id < supersededBy
          ? [item.id] : [];
      });
      if (deleteIds.length > 0) await db.outbox.bulkDelete(deleteIds);
      for (const id of deleteIds) context.deferred.delete(id);
    }));
}

async function pushBatchWithIsolation(
  token: string,
  epoch: number,
  signal: AbortSignal,
  items: import('../db/db').OutboxItem[],
  mutations: SyncMutation[],
  context: PushContext,
): Promise<number> {
  if (context.requests >= MAX_PUSH_REQUESTS_PER_SYNC) throw new PushBudgetReached();
  context.requests += 1;
  const res = await apiPost('/api/sync/push', { mutations }, token, signal);
  assertSyncActive(epoch, signal);
  if (res.status === 401) throw new AuthError();
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    throw new MediaGcDeferred(typeof body.error === 'string'
      ? body.error : 'Medien werden gerade bereinigt. Der nächste Sync versucht es erneut.');
  }
  if (res.status === 413) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: unknown;
      code?: unknown;
    };
    // Quota-Fehler bleiben sendbar. Auch bei unverändertem Limit müssen spätere
    // Löschungen/Verkleinerungen im selben oder einem späteren Batch erreichbar bleiben.
    const quotaDeferred =
      body.code === 'SYNC_STORAGE_LIMIT' || body.code === 'SYNC_OBJECT_LIMIT';
    if (items.length > 1) {
      const middle = Math.ceil(items.length / 2);
      const first = await pushBatchWithIsolation(
        token, epoch, signal, items.slice(0, middle), mutations.slice(0, middle), context,
      );
      const second = await pushBatchWithIsolation(
        token, epoch, signal, items.slice(middle), mutations.slice(middle), context,
      );
      return first + second;
    }
    if (quotaDeferred) {
      const id = items[0].id;
      if (id !== undefined) {
        context.deferred.set(id, typeof body.error === 'string' ? body.error : 'Sync-Quota erreicht');
        // Den Fortschritt auch vor einem Rate-/Request-Limit sichern. Ein großer Import
        // beginnt beim nächsten Sync dann hinter den bereits erfolglos geprüften Einträgen.
        await withLocalDataOperation(() =>
          db.meta.put({ key: DEFERRED_OUTBOX_CURSOR_KEY, value: id }).then(() => undefined));
      }
      return 0;
    }
    const reason = typeof body.error === 'string' ? body.error : 'Server lehnt diese Änderung als zu groß ab';
    await markOutboxRejected(items[0], reason);
    return 0;
  }
  if (!res.ok) throw new Error(`Push fehlgeschlagen (${res.status})`);
  await removePushedOutbox(items, context);
  assertSyncActive(epoch, signal);
  context.pushed += mutations.length;
  return mutations.length;
}

async function pushOutbox(
  token: string,
  epoch: number,
  signal: AbortSignal,
): Promise<{
  pushed: number;
  rejected: number;
  deferredMessage: string | null;
  forceMediaGc: boolean;
}> {
  const cursorMeta = await db.meta.get(DEFERRED_OUTBOX_CURSOR_KEY);
  const initialCursor = typeof cursorMeta?.value === 'number' ? cursorMeta.value : 0;
  const context: PushContext = { requests: 0, pushed: 0, deferred: new Map(), initialCursor };
  let scanFrom = initialCursor;
  let wrapped = initialCursor === 0;
  let retried = false;
  let budgetReached = false;
  let mediaGcMessage: string | null = null;
  let pushed = 0;
  for (let guard = 0; guard < 10000; guard++) {
    assertSyncActive(epoch, signal);
    const items = await withLocalDataOperation(() =>
      db.outbox
        .where('id').above(scanFrom)
        .filter((item) => !item.syncError && !context.deferred.has(item.id!))
        .limit(MAX_SYNC_MUTATIONS)
        .toArray());
    assertSyncActive(epoch, signal);
    if (items.length === 0) {
      if (!wrapped) {
        wrapped = true;
        scanFrom = 0;
        continue;
      }
      if (context.deferred.size > 0 && pushed > 0 && !retried) {
        // Spätere erfolgreiche Änderungen können Speicher freigegeben haben. Genau
        // ein weiterer Durchlauf verhindert eine Endlosschleife bei unveränderter Quota.
        retried = true;
        context.deferred.clear();
        scanFrom = 0;
        continue;
      }
      break;
    }

    const mutations: SyncMutation[] = [];
    const batchedItems: import('../db/db').OutboxItem[] = [];
    let requestBytes = SYNC_BODY_FIXED_BYTES;
    for (const item of items) {
      const mutation = {
        op: item.op,
        entity: item.entity,
        entityId: item.entityId,
        ...(item.op === 'upsert' ? { payload: item.payload } : {}),
        createdAt: item.createdAt,
      } as SyncMutation;
      try {
        const validation = validateSyncMutations([mutation]);
        if (!validation.ok) {
          await markOutboxRejected(item, validation.message);
          continue;
        }
        const mutationBytes = syncEncoder.encode(JSON.stringify(mutation)).byteLength;
        const candidateBytes = requestBytes + (mutations.length > 0 ? 1 : 0) + mutationBytes;
        if (candidateBytes > MAX_SYNC_REQUEST_BYTES) {
          if (mutations.length === 0) {
            await markOutboxRejected(item, 'Mutation überschreitet das maximale Sync-Request-Limit');
            continue;
          }
          // Der aktuelle Batch ist voll; dieser gültige Eintrag wird im nächsten Durchlauf
          // zuerst verarbeitet. Ein einzelner gültiger Payload passt wegen des 256-KiB-Limits.
          break;
        }
        requestBytes = candidateBytes;
        mutations.push(validation.mutations[0]);
        batchedItems.push(item);
      } catch {
        await markOutboxRejected(item, 'Payload kann nicht als JSON serialisiert werden');
      }
    }
    if (mutations.length === 0) continue;

    try {
      await pushBatchWithIsolation(
        token, epoch, signal, batchedItems, mutations, context,
      );
    } catch (errorValue) {
      if (errorValue instanceof MediaGcDeferred) mediaGcMessage = errorValue.message;
      else if (errorValue instanceof PushBudgetReached) budgetReached = true;
      else throw errorValue;
      pushed = context.pushed;
      break;
    }
    pushed = context.pushed;
    scanFrom = batchedItems[batchedItems.length - 1].id ?? scanFrom;
  }
  const rejected = await withLocalDataOperation(() =>
    db.outbox.filter((item) => Boolean(item.syncError)).count());
  const deferredMessage = mediaGcMessage ?? context.deferred.values().next().value ??
    (budgetReached ? 'Weitere Änderungen werden beim nächsten Sync fortgesetzt.' : null);
  if (!deferredMessage) {
    await withLocalDataOperation(() => db.meta.delete(DEFERRED_OUTBOX_CURSOR_KEY));
  }
  return { pushed, rejected, deferredMessage, forceMediaGc: mediaGcMessage !== null };
}

// Vollständiger Sync-Durchlauf (idempotent, überlappungsfrei).
export function sync(): Promise<void> {
  if (syncBlocked) return Promise.resolve();
  if (inFlight) return inFlight;
  const epoch = syncEpoch;
  const controller = new AbortController();
  activeController = controller;
  const current = runSync(epoch, controller.signal).finally(() => {
    if (inFlight === current) inFlight = null;
    if (activeController === controller) activeController = null;
  });
  inFlight = current;
  return current;
}

async function runSync(epoch: number, signal: AbortSignal): Promise<void> {
  try {
    const auth = await getAuth();
    assertSyncActive(epoch, signal);
    if (!auth) return;
    setState({ syncing: true, error: null });

    await pullAll(auth.token, epoch, signal);
    const pushResult = await pushOutbox(auth.token, epoch, signal);
    if (pushResult.pushed > 0) {
      await pullAll(auth.token, epoch, signal); // Cursor über eigene Writes hinweg settlen
    }

    // Referenzierte, vermeintlich bereits hochgeladene Medien einmal täglich gegen R2
    // prüfen. Große Sammlungen setzen ihren Cursor in den nächsten Minuten fort; ein
    // vollständiger Lauf wird dagegen nicht durch den 1-Minuten-Autosync wiederholt.
    const [lastMediaRevalidation, mediaRevalidationCursor] = await Promise.all([
      db.meta.get('lastMediaRevalidationAt'),
      db.meta.get('mediaRevalidationCursor'),
    ]);
    assertSyncActive(epoch, signal);
    const revalidationDue =
      typeof mediaRevalidationCursor?.value === 'string' ||
      typeof lastMediaRevalidation?.value !== 'number' ||
      Date.now() - lastMediaRevalidation.value >= MEDIA_REVALIDATION_INTERVAL_MS;
    if (revalidationDue) {
      const revalidated = await revalidateReferencedMedia(BASE, auth.token, signal);
      if (revalidated.complete) {
        assertSyncActive(epoch, signal);
        await withLocalDataOperation(() =>
          db.meta.put({ key: 'lastMediaRevalidationAt', value: Date.now() })
            .then(() => undefined));
      }
    }
    assertSyncActive(epoch, signal);
    const mediaResult = await uploadPendingMedia(BASE, auth.token, signal);
    assertSyncActive(epoch, signal);
    // Der Server muss dafür alle Notizen und Medien des Kontos lesen. Ein täglicher Lauf
    // genügt wegen der 30-tägigen Quarantäne und verhindert den bisherigen Vollscan pro Minute.
    const lastMediaGc = await db.meta.get('lastMediaGcAt');
    assertSyncActive(epoch, signal);
    // Ein abgebrochener GC kann einen Lösch-Claim hinterlassen. Ein dadurch mit 409
    // zurückgestellter Push muss den GC fortsetzen können, auch vor dem Tagesintervall.
    if (pushResult.forceMediaGc || typeof lastMediaGc?.value !== 'number' || Date.now() - lastMediaGc.value >= 24 * 60 * 60_000) {
      const gc = await garbageCollectRemoteMedia(BASE, auth.token, signal);
      if (gc.available && gc.complete) {
        assertSyncActive(epoch, signal);
        await withLocalDataOperation(() =>
          db.meta.put({ key: 'lastMediaGcAt', value: Date.now() }).then(() => undefined));
      }
      assertSyncActive(epoch, signal);
    }
    // Fehlende Cross-Device-Bilder mit globalem per-Sync-Budget und rotierendem Cursor
    // laden. So erzeugt ein neues Gerät mit großer Sammlung keinen GET-/429-Sturm.
    await downloadReferencedMedia(BASE, auth.token, signal);
    assertSyncActive(epoch, signal);
    // Erst nach Revalidierung, GC und Downloads melden: Ein dauerhaft nicht hochladbares
    // Bild darf die Bereinigung nicht blockieren, die eine volle Remote-Quota freigeben kann.
    if (mediaResult.failed > 0) {
      throw new Error(`${mediaResult.failed} Bild(er) konnten nicht synchronisiert werden.`);
    }

    const now = Date.now();
    assertSyncActive(epoch, signal);
    await withLocalDataOperation(() =>
      db.meta.put({ key: 'lastSyncAt', value: now }).then(() => undefined));
    assertSyncActive(epoch, signal);
    setState({
      syncing: false,
      lastSyncAt: now,
      error: pushResult.deferredMessage ?? rejectedSyncMessage(pushResult.rejected),
    });
  } catch (e) {
    if (e instanceof SyncCancelled || signal.aborted || epoch !== syncEpoch) return;
    if (e instanceof LocalDataResetError) {
      setState({ syncing: false, error: e.message });
      return;
    }
    if (e instanceof AuthError) {
      // Session abgelaufen (JWT hat 30 Tage TTL): NUR das Token verwerfen. Daten, Cursor
      // und Outbox bleiben erhalten — beim erneuten Login mit demselben Konto wird die
      // Outbox normal gepusht. Ein Wipe hier würde ungesyncte Arbeit vernichten.
      try {
        await withLocalDataOperation(() => db.meta.delete('auth'));
      } catch (resetError) {
        // Ein paralleler Logout/Kontowechsel besitzt jetzt die Reset-Sperre und löscht
        // den Auth-Eintrag selbst. Dessen Invalidierung ist kein neuer Sync-Fehler.
        if (resetError instanceof LocalDataResetError) return;
        throw resetError;
      }
      setState({ syncing: false, error: 'Sitzung abgelaufen – bitte neu anmelden.' });
    } else {
      setState({ syncing: false, error: (e as Error).message || 'Sync fehlgeschlagen.' });
    }
  }
}

// Letzten Sync-Zeitpunkt aus der DB laden (für Anzeige nach App-Start).
export async function loadLastSyncAt(): Promise<void> {
  const [m, rejected] = await Promise.all([
    db.meta.get('lastSyncAt'),
    db.outbox.filter((item) => Boolean(item.syncError)).count(),
  ]);
  setState({
    ...(typeof m?.value === 'number' ? { lastSyncAt: m.value } : {}),
    error: rejectedSyncMessage(rejected),
  });
}

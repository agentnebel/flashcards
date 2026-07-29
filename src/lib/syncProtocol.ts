export const MAX_SYNC_MUTATIONS = 100;
export const MAX_SYNC_REQUEST_BYTES = 2 * 1024 * 1024;
export const MAX_SYNC_PAYLOAD_BYTES = 256 * 1024;
export const MAX_SYNC_IDENTIFIER_LENGTH = 128;
export const MAX_SYNC_PAYLOAD_DEPTH = 64;

export const SYNC_ENTITIES = ['deck', 'note', 'card', 'revlog', 'noteType'] as const;
export type SyncEntity = (typeof SYNC_ENTITIES)[number];

export interface SyncMutation {
  op: 'upsert' | 'delete';
  entity: SyncEntity;
  entityId: string;
  payload?: Record<string, unknown>;
  createdAt?: number;
}

type ValidationResult =
  | { ok: true; mutations: SyncMutation[] }
  | { ok: false; status: 400 | 413; message: string };

const ALLOWED_ENTITIES = new Set<string>(SYNC_ENTITIES);
const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export function isSafeSyncPayload(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const root = value as Record<string, unknown>;
  const pending: Array<
    { value: unknown; depth: number; leave?: false } |
    { value: object; depth: number; leave: true }
  > = [{ value: root, depth: 0 }];
  const ancestors = new WeakSet<object>();

  while (pending.length > 0) {
    const current = pending.pop()!;
    const { value, depth } = current;
    if (current.leave) {
      ancestors.delete(current.value);
      continue;
    }
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (typeof value !== 'object' || depth > MAX_SYNC_PAYLOAD_DEPTH) return false;
    // Nur Referenzen auf einen aktuellen Vorfahren sind Zyklen. Dieselbe Date-/Objektinstanz
    // darf dagegen in zwei Geschwisterfeldern vorkommen; JSON.stringify serialisiert beide
    // unabhängig (normale Cards teilen z. B. `due` und `fsrs.due`).
    if (ancestors.has(value)) return false;
    ancestors.add(value);
    pending.push({ value, depth, leave: true });
    for (const child of Object.values(value)) {
      pending.push({ value: child, depth: depth + 1 });
    }
  }

  return true;
}

export function validateSyncMutations(value: unknown): ValidationResult {
  if (!Array.isArray(value)) return { ok: false, status: 400, message: 'mutations muss ein Array sein' };
  if (value.length > MAX_SYNC_MUTATIONS) {
    return { ok: false, status: 413, message: `Zu viele Mutationen pro Batch (max. ${MAX_SYNC_MUTATIONS})` };
  }

  const mutations: SyncMutation[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return { ok: false, status: 400, message: 'Ungültige Mutation' };
    }
    const raw = candidate as Record<string, unknown>;
    if (raw.op !== 'upsert' && raw.op !== 'delete') {
      return { ok: false, status: 400, message: 'Ungültige Mutation-Operation' };
    }
    if (typeof raw.entity !== 'string' || !ALLOWED_ENTITIES.has(raw.entity)) {
      return { ok: false, status: 400, message: 'Unbekannte Sync-Entität' };
    }
    if (
      typeof raw.entityId !== 'string' ||
      raw.entityId.length === 0 ||
      raw.entityId.length > MAX_SYNC_IDENTIFIER_LENGTH
    ) {
      return { ok: false, status: 400, message: 'Ungültige entityId' };
    }
    if (raw.createdAt !== undefined && (typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt))) {
      return { ok: false, status: 400, message: 'Ungültiger createdAt-Zeitstempel' };
    }

    if (raw.op === 'upsert') {
      if (!raw.payload || typeof raw.payload !== 'object' || Array.isArray(raw.payload)) {
        return { ok: false, status: 400, message: 'Upsert benötigt ein Objekt als payload' };
      }
      const payload = raw.payload as Record<string, unknown>;
      if (payload.id !== raw.entityId) {
        return { ok: false, status: 400, message: 'payload.id muss entityId entsprechen' };
      }
      // JSON.parse selbst verarbeitet sehr tiefe Strukturen iterativ; JSON.stringify
      // wirft dagegen ab einigen tausend Ebenen einen RangeError. Ohne diese iterative
      // Vorprüfung könnte ein authentifizierter Request vor den D1-Tagesbudgets 500er und
      // unnötige Worker-CPU erzeugen. Zyklen und Nicht-JSON-Werte werden zugleich abgelehnt.
      if (!isSafeSyncPayload(payload)) {
        return { ok: false, status: 400, message: 'Payload ist zu tief verschachtelt oder kein gültiges JSON' };
      }
      let serialized: string;
      try {
        serialized = JSON.stringify(payload);
      } catch {
        return { ok: false, status: 400, message: 'Payload kann nicht als JSON serialisiert werden' };
      }
      if (byteLength(serialized) > MAX_SYNC_PAYLOAD_BYTES) {
        return { ok: false, status: 413, message: `Payload ist zu groß (max. ${MAX_SYNC_PAYLOAD_BYTES} Bytes)` };
      }
      mutations.push({
        op: raw.op,
        entity: raw.entity as SyncEntity,
        entityId: raw.entityId,
        payload,
        createdAt: raw.createdAt as number | undefined,
      });
    } else {
      mutations.push({
        op: raw.op,
        entity: raw.entity as SyncEntity,
        entityId: raw.entityId,
        createdAt: raw.createdAt as number | undefined,
      });
    }
  }
  return { ok: true, mutations };
}

import { describe, expect, it } from 'vitest';
import {
  MAX_SYNC_MUTATIONS,
  MAX_SYNC_PAYLOAD_BYTES,
  MAX_SYNC_PAYLOAD_DEPTH,
  isSafeSyncPayload,
  validateSyncMutations,
} from './syncProtocol';

function mutation(id = 'note-1') {
  return {
    op: 'upsert',
    entity: 'note',
    entityId: id,
    payload: { id, updatedAt: 1, fields: { Front: 'Frage' } },
    createdAt: 1,
  };
}

describe('Sync-Protokollgrenzen', () => {
  it('akzeptiert einen normalen, konsistenten Upsert', () => {
    expect(validateSyncMutations([mutation()])).toEqual({
      ok: true,
      mutations: [mutation()],
    });
  });

  it('weist Batches oberhalb der Client-Chunkgröße vollständig zurück', () => {
    const result = validateSyncMutations(
      Array.from({ length: MAX_SYNC_MUTATIONS + 1 }, (_, index) => mutation(`note-${index}`)),
    );
    expect(result).toMatchObject({ ok: false, status: 413 });
  });

  it('weist fehlende und abweichende payload IDs zurück', () => {
    expect(validateSyncMutations([
      { ...mutation(), payload: { updatedAt: 1 } },
    ])).toMatchObject({ ok: false, status: 400 });
    expect(validateSyncMutations([
      { ...mutation(), payload: { id: 'anderer-id', updatedAt: 1 } },
    ])).toMatchObject({ ok: false, status: 400 });
  });

  it('weist einzelne übergroße Payloads zurück', () => {
    const result = validateSyncMutations([
      {
        ...mutation(),
        payload: { id: 'note-1', value: 'x'.repeat(MAX_SYNC_PAYLOAD_BYTES) },
      },
    ]);
    expect(result).toMatchObject({ ok: false, status: 413 });
  });

  it('weist extrem verschachtelte und zyklische Payloads ohne RangeError zurück', () => {
    const deeplyNested: Record<string, unknown> = { id: 'note-1' };
    let cursor = deeplyNested;
    for (let depth = 0; depth <= MAX_SYNC_PAYLOAD_DEPTH; depth++) {
      const child: Record<string, unknown> = {};
      cursor.child = child;
      cursor = child;
    }
    expect(() => validateSyncMutations([
      { ...mutation(), payload: deeplyNested },
    ])).not.toThrow();
    expect(validateSyncMutations([
      { ...mutation(), payload: deeplyNested },
    ])).toMatchObject({ ok: false, status: 400 });

    const cyclic: Record<string, unknown> = { id: 'note-1' };
    cyclic.self = cyclic;
    expect(validateSyncMutations([
      { ...mutation(), payload: cyclic },
    ])).toMatchObject({ ok: false, status: 400 });
    expect(isSafeSyncPayload(deeplyNested)).toBe(false);
    expect(isSafeSyncPayload(cyclic)).toBe(false);
  });

  it('akzeptiert normale Card-Payloads mit geteilter Date-Instanz', () => {
    const due = new Date('2026-07-29T12:00:00.000Z');
    const cardPayload = {
      id: 'card-1',
      noteId: 'note-1',
      deckId: 'deck-1',
      noteTypeId: 'type-1',
      templateOrd: 0,
      clozeNum: null,
      fsrs: { due, stability: 0, difficulty: 0 },
      due,
      suspended: 0,
      updatedAt: 1,
    };

    expect(isSafeSyncPayload(cardPayload)).toBe(true);
    expect(validateSyncMutations([{
      op: 'upsert',
      entity: 'card',
      entityId: 'card-1',
      payload: cardPayload,
      createdAt: 1,
    }])).toMatchObject({ ok: true });
  });
});

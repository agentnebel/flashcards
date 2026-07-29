import { describe, expect, it, vi } from 'vitest';
import type { IRequest } from 'itty-router';
import { MAX_SYNC_PAYLOAD_DEPTH } from '../src/lib/syncProtocol';
import { handlePull } from './sync';
import type { Env } from './index';

function deeplyNestedPayload(): string {
  let payload = '{"id":"note-1","child":';
  payload += '{"child":'.repeat(MAX_SYNC_PAYLOAD_DEPTH + 1);
  payload += 'null';
  payload += '}'.repeat(MAX_SYNC_PAYLOAD_DEPTH + 1);
  return `${payload}}`;
}

describe('Sync-Pull mit Legacy-Daten', () => {
  it('antwortet definiert statt beim JSON-Response-Stringify zu crashen', async () => {
    const budgetStatement = {
      bind: vi.fn(),
    };
    budgetStatement.bind.mockReturnValue(budgetStatement);
    const pullStatement = {
      bind: vi.fn(),
      all: vi.fn().mockResolvedValue({
        results: [{
          entity: 'note',
          entity_id: 'note-1',
          payload: deeplyNestedPayload(),
          deleted: 0,
          seq: 1,
          updated_at: 1,
        }],
      }),
    };
    pullStatement.bind.mockReturnValue(pullStatement);
    const env = {
      SYNC_LIMITER: {
        limit: vi.fn().mockResolvedValue({ success: true }),
      },
      DB: {
        batch: vi.fn().mockResolvedValue([]),
        prepare: vi.fn((sql: string) =>
          sql.startsWith('SELECT entity') ? pullStatement : budgetStatement),
      },
    } as unknown as Env;
    const request = new Request('https://flashcards.test/api/sync/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"cursor":0}',
    }) as unknown as IRequest & { userId: string };
    request.userId = 'user-1';

    const response = await handlePull(request, env);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: 'SYNC_STORED_PAYLOAD_INVALID',
      entity: 'note',
      entityId: 'note-1',
    });
  });
});

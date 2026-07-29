import { describe, expect, it, vi } from 'vitest';
import type { IRequest } from 'itty-router';
import { handleMediaGet } from './media';
import type { Env } from './index';

describe('authentifizierter Medienabruf', () => {
  it('verbietet Browser-Caching über Kontowechsel hinweg', async () => {
    const statement = {
      bind: vi.fn(),
    };
    statement.bind.mockReturnValue(statement);
    const env = {
      DB: {
        prepare: vi.fn().mockReturnValue(statement),
        batch: vi.fn().mockResolvedValue([]),
      },
      MEDIA: {
        get: vi.fn().mockResolvedValue({
          body: new Uint8Array([1, 2, 3]),
          httpMetadata: { contentType: 'image/png' },
        }),
      },
      MEDIA_LIMITER: {
        limit: vi.fn().mockResolvedValue({ success: true }),
      },
    } as unknown as Env;
    const request = {
      userId: 'user-a',
      params: { hash: 'a'.repeat(64) },
    } as unknown as IRequest & { userId: string };

    const response = await handleMediaGet(request, env);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Cache-Control')).not.toContain('max-age');
  });
});

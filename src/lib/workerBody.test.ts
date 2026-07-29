import { describe, expect, it, vi } from 'vitest';
import { readBodyBytes } from '../../worker/body';

describe('begrenztes Einlesen von Worker-Request-Bodies', () => {
  it('lehnt eine zu große Content-Length ab, ohne den Body zu lesen', async () => {
    const getReader = vi.fn();
    const result = await readBodyBytes({
      headers: new Headers({ 'Content-Length': '6' }),
      body: { getReader } as unknown as ReadableStream<Uint8Array>,
    }, 5);

    expect(result).toEqual({ ok: false, reason: 'too-large' });
    expect(getReader).not.toHaveBeenCalled();
  });

  it('bricht einen chunked Body ab, sobald die gelesenen Chunks das Limit überschreiten', async () => {
    const cancel = vi.fn();
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
    ];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel,
    });

    const result = await readBodyBytes({
      headers: new Headers({ 'Transfer-Encoding': 'chunked' }),
      body,
    }, 5);

    expect(result).toEqual({ ok: false, reason: 'too-large' });
    expect(cancel).toHaveBeenCalledOnce();
  });
});

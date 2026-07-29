interface BodyRequest {
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

export type BoundedBodyResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'too-large' | 'invalid' };

// Liest einen Request-Body streamend und bricht unmittelbar oberhalb des fachlichen
// Limits ab. Content-Length ist nur ein Fast-Path; HTTP/2/chunked muss ohne Header ebenso
// sicher bleiben, statt zuerst bis zum 100-MB-Edge-Limit in den Worker-Heap zu puffern.
export async function readBodyBytes(
  request: BodyRequest,
  maxBytes: number,
): Promise<BoundedBodyResult<Uint8Array<ArrayBuffer>>> {
  const declared = Number(request.headers.get('Content-Length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, reason: 'too-large' };
  }
  if (!request.body) return { ok: true, value: new Uint8Array(0) };

  const reader = request.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, reason: 'too-large' };
    }
    const copy = new Uint8Array(value.byteLength);
    copy.set(value);
    chunks.push(copy);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, value: bytes };
}

export async function readJsonBody<T>(
  request: BodyRequest,
  maxBytes: number,
): Promise<BoundedBodyResult<T>> {
  const body = await readBodyBytes(request, maxBytes);
  if (!body.ok) return body;
  try {
    return {
      ok: true,
      value: JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body.value),
      ) as T,
    };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

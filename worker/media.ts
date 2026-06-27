import { error, json } from 'itty-router';
import type { IRequest } from 'itty-router';
import type { Env } from './index';

type AuthedRequest = IRequest & { userId: string };

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Content-addressed Medien: Upload speichert unter {userId}/{sha256} in R2 + Metazeile in D1.
export async function handleMediaUpload(req: AuthedRequest, env: Env): Promise<Response> {
  const buf = await req.arrayBuffer();
  if (buf.byteLength === 0) return error(400, 'Leerer Upload');
  if (buf.byteLength > 25 * 1024 * 1024) return error(413, 'Datei zu groß (max 25 MB)');
  const hash = await sha256Hex(buf);
  const mime = req.headers.get('Content-Type') || 'application/octet-stream';
  const key = `${req.userId}/${hash}`;
  await env.MEDIA.put(key, buf, { httpMetadata: { contentType: mime } });
  await env.DB.prepare(
    `INSERT INTO media (id, user_id, sha256, mime, size, r2_key, created_at)
     VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id, sha256) DO NOTHING`,
  )
    .bind(crypto.randomUUID(), req.userId, hash, mime, buf.byteLength, key, Date.now())
    .run();
  return json({ hash, size: buf.byteLength });
}

export async function handleMediaGet(req: AuthedRequest, env: Env): Promise<Response> {
  const hash = req.params?.hash;
  if (!hash) return error(400, 'Hash fehlt');
  const obj = await env.MEDIA.get(`${req.userId}/${hash}`);
  if (!obj) return error(404, 'Nicht gefunden');
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
}

import { error, json } from 'itty-router';
import type { IRequest } from 'itty-router';
import type { Env } from './index';

type AuthedRequest = IRequest & { userId: string };

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB
const MAX_EXISTS_HASHES = 500;

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Content-addressed Medien: Upload speichert unter {userId}/{sha256} in R2 + Metazeile in D1.
export async function handleMediaUpload(req: AuthedRequest, env: Env): Promise<Response> {
  // R2 noch nicht aktiviert -> Binding ist zur Laufzeit undefined.
  if (!env.MEDIA) return json({ error: 'R2 storage not enabled' }, { status: 503 });

  const mime = req.headers.get('Content-Type') || '';
  if (!mime.startsWith('image/')) return error(415, 'Nur Bilder erlaubt (Content-Type image/*)');

  const buf = await req.arrayBuffer();
  if (buf.byteLength === 0) return error(400, 'Leerer Upload');
  if (buf.byteLength > MAX_UPLOAD_BYTES) return error(413, 'Datei zu groß (max 15 MB)');

  const hash = await sha256Hex(buf);
  const key = `${req.userId}/${hash}`;
  await env.MEDIA.put(key, buf, { httpMetadata: { contentType: mime } });
  await env.DB.prepare(
    `INSERT INTO media (id, user_id, sha256, mime, size, r2_key, created_at)
     VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id, sha256) DO NOTHING`,
  )
    .bind(crypto.randomUUID(), req.userId, hash, mime, buf.byteLength, key, Date.now())
    .run();

  return json({ hash, size: buf.byteLength, mime });
}

export async function handleMediaGet(req: AuthedRequest, env: Env): Promise<Response> {
  if (!env.MEDIA) return json({ error: 'R2 storage not enabled' }, { status: 503 });

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

// Client-Vorabprüfung: welche Hashes liegen serverseitig bereits vor?
// Spart redundante Uploads. Funktioniert auch ohne R2 (rein D1-basiert).
export async function handleMediaExists(req: AuthedRequest, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { hashes?: unknown };
  const hashes = Array.isArray(body.hashes) ? body.hashes.filter((h): h is string => typeof h === 'string') : [];
  if (hashes.length > MAX_EXISTS_HASHES) return error(413, `Zu viele Hashes (max ${MAX_EXISTS_HASHES})`);

  // Eindeutige, nicht-leere Hashes für die Abfrage.
  const unique = [...new Set(hashes.filter((h) => h.length > 0))];
  if (unique.length === 0) return json({ have: [], missing: [] });

  const placeholders = unique.map(() => '?').join(',');
  const res = await env.DB.prepare(
    `SELECT sha256 FROM media WHERE user_id = ? AND sha256 IN (${placeholders})`,
  )
    .bind(req.userId, ...unique)
    .all<{ sha256: string }>();

  const haveSet = new Set(res.results.map((r) => r.sha256));
  const have = unique.filter((h) => haveSet.has(h));
  const missing = unique.filter((h) => !haveSet.has(h));

  return json({ have, missing });
}

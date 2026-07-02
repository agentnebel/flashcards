import { error, json } from 'itty-router';
import type { IRequest } from 'itty-router';
import type { Env } from './index';

type AuthedRequest = IRequest & { userId: string };

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB
const MAX_USER_STORAGE_BYTES = 500 * 1024 * 1024; // 500 MB Gesamtspeicher pro Konto
// Jeder R2-head() zählt als Subrequest (Free-Plan-Limit: 50/Request) — deshalb deutlich
// weniger Hashes pro Anfrage zulassen; der Client chunkt entsprechend.
const MAX_EXISTS_HASHES = 40;

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Content-addressed Medien: Upload speichert unter {userId}/{sha256} in R2 + Metazeile in D1.
export async function handleMediaUpload(req: AuthedRequest, env: Env): Promise<Response> {
  // R2 noch nicht aktiviert -> Binding ist zur Laufzeit undefined.
  if (!env.MEDIA) return json({ error: 'R2 storage not enabled' }, { status: 503 });

  const mime = req.headers.get('Content-Type') || '';
  // SVG ausschließen: kann aktives Skript enthalten (Stored-XSS, wenn direkt aufgerufen).
  if (!mime.startsWith('image/') || mime === 'image/svg+xml') {
    return error(415, 'Nur Rasterbilder erlaubt (kein SVG)');
  }

  const buf = await req.arrayBuffer();
  if (buf.byteLength === 0) return error(400, 'Leerer Upload');
  if (buf.byteLength > MAX_UPLOAD_BYTES) return error(413, 'Datei zu groß (max 15 MB)');

  // Speicher-Quota pro Konto: ohne Obergrenze könnte ein einzelnes (ggf. massenhaft
  // registriertes) Konto R2 unbegrenzt füllen — reines Kostenrisiko, kein Featureverlust.
  const usage = await env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS used FROM media WHERE user_id = ?')
    .bind(req.userId)
    .first<{ used: number }>();
  if ((usage?.used ?? 0) + buf.byteLength > MAX_USER_STORAGE_BYTES) {
    return error(413, 'Speicherlimit erreicht (500 MB pro Konto)');
  }

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
  // Gespeicherten Content-Type nur zulassen, wenn es ein Rasterbild ist; sonst neutralisieren.
  const stored = obj.httpMetadata?.contentType || '';
  const ct = stored.startsWith('image/') && stored !== 'image/svg+xml' ? stored : 'application/octet-stream';
  return new Response(obj.body, {
    headers: {
      'Content-Type': ct,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
}

// Client-Vorabprüfung: welche Hashes liegen serverseitig WIRKLICH vor (Bytes in R2)?
// Spart redundante Uploads. Wichtig: nicht die bloße D1-Zeile als "vorhanden" werten — eine
// Metazeile ohne zugehöriges R2-Objekt würde den Client fälschlich als synced markieren,
// und das Bild käme nie auf andere Geräte. Ohne R2 wird nichts als vorhanden gemeldet.
export async function handleMediaExists(req: AuthedRequest, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { hashes?: unknown };
  const hashes = Array.isArray(body.hashes) ? body.hashes.filter((h): h is string => typeof h === 'string') : [];
  if (hashes.length > MAX_EXISTS_HASHES) return error(413, `Zu viele Hashes (max ${MAX_EXISTS_HASHES})`);

  // Eindeutige, nicht-leere, plausibel geformte Hashes (Hex).
  const unique = [...new Set(hashes.filter((h) => /^[a-f0-9]{64}$/.test(h)))];
  if (unique.length === 0 || !env.MEDIA) return json({ have: [], missing: unique });

  const heads = await Promise.all(unique.map((h) => env.MEDIA!.head(`${req.userId}/${h}`)));
  const have = unique.filter((_, i) => heads[i] !== null);
  const missing = unique.filter((_, i) => heads[i] === null);

  return json({ have, missing });
}

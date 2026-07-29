import { error, json } from 'itty-router';
import type { IRequest } from 'itty-router';
import { readJsonBody } from './body';
import type { Env } from './index';

const enc = new TextEncoder();

// ---- base64url ----
function b64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str: string): Uint8Array {
  const norm = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm.length % 4 ? 4 - (norm.length % 4) : 0;
  const s = atob(norm + '='.repeat(pad));
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

// ---- JWT (HS256) ----
export async function signJwt(
  payload: Record<string, unknown>,
  secret: string,
  expSec = 60 * 60 * 24 * 30,
): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expSec };
  const data =
    b64urlEncode(enc.encode(JSON.stringify(header))) + '.' + b64urlEncode(enc.encode(JSON.stringify(body)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return data + '.' + b64urlEncode(sig);
}

export async function verifyJwt(token: string, secret: string): Promise<Record<string, unknown> | null> {
  // Komplett defensiv: ein fehlerhaftes Token (kein base64url, kaputtes JSON) darf
  // niemals als unbehandelte Exception nach oben durchschlagen (sonst 500 statt 401).
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const data = parts[0] + '.' + parts[1];
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify('HMAC', key, b64urlDecode(parts[2]), enc.encode(data));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))) as Record<string, unknown>;
    if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---- Passwort-Hashing (PBKDF2-SHA256) ----
async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
}
async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iter = 100000;
  const bits = await pbkdf2(password, salt, iter);
  return `pbkdf2$${iter}$${b64urlEncode(salt)}$${b64urlEncode(bits)}`;
}
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterStr, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'pbkdf2') return false;
  const bits = await pbkdf2(password, b64urlDecode(saltB64), parseInt(iterStr, 10));
  return timingSafeEqual(b64urlEncode(bits), hashB64);
}

// Konstantzeit-Stringvergleich (vermeidet Timing-Seitenkanal beim Hash-Abgleich).
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function normalizeEmail(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}
function secretOk(env: Env): boolean {
  return typeof env.JWT_SECRET === 'string' && env.JWT_SECRET.length >= 16;
}
const MAX_PW = 1024;
const MAX_AUTH_BODY_BYTES = 8 * 1024;
const MAX_REGISTERED_USERS = 100;

interface Creds {
  email?: string;
  password?: string;
  inviteCode?: string;
}

// Bruteforce-/Massenregistrierungs-Schutz: 10 Auth-Versuche pro IP und Minute
// (Rate-Limiting-Binding, siehe wrangler.jsonc). Gibt bei Überschreitung 429 zurück.
async function rateLimited(req: IRequest, env: Env): Promise<Response | null> {
  if (!env.AUTH_LIMITER) return null;
  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
  const { success } = await env.AUTH_LIMITER.limit({ key: ip });
  return success ? null : error(429, 'Zu viele Versuche – bitte kurz warten.');
}

async function registrationIpKey(req: IRequest, env: Env, fallback: string): Promise<string> {
  // Keine Roh-IP persistieren. Cloudflare setzt CF-Connecting-IP unverfälschbar am Edge;
  // lokale Entwicklung ohne Header bleibt über das globale Tagesbudget begrenzt.
  const ip = req.headers.get('CF-Connecting-IP') ?? `unknown:${fallback}`;
  const key = await hmacKey(env.JWT_SECRET);
  return b64urlEncode(await crypto.subtle.sign('HMAC', key, enc.encode(`register:${ip}`)));
}

export async function handleRegister(req: IRequest, env: Env): Promise<Response> {
  if (!secretOk(env)) return error(500, 'Server fehlkonfiguriert');
  const limited = await rateLimited(req, env);
  if (limited) return limited;
  const parsed = await readJsonBody<Creds>(req, MAX_AUTH_BODY_BYTES);
  if (!parsed.ok) {
    return error(parsed.reason === 'too-large' ? 413 : 400, 'Ungültige Auth-Anfrage');
  }
  const creds = parsed.value;
  const email = normalizeEmail(creds.email);
  const password = creds.password ?? '';
  const inviteCode = typeof creds.inviteCode === 'string' ? creds.inviteCode.trim() : '';
  if (!email || !email.includes('@') || email.length > 320) return error(400, 'Gültige E-Mail erforderlich');
  if (password.length < 8 || password.length > MAX_PW) return error(400, 'Passwort muss 8–1024 Zeichen lang sein');
  if (inviteCode.length < 16 || inviteCode.length > 256) {
    return error(403, 'Gültiger Einladungscode erforderlich');
  }
  // Case-insensitiver Duplikat-Check, damit User@x.com und user@x.com nicht zwei Konten werden.
  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').bind(email).first();
  if (existing) return error(409, 'E-Mail bereits registriert');
  const id = crypto.randomUUID();
  const inviteHash = b64urlEncode(
    await crypto.subtle.digest('SHA-256', enc.encode(inviteCode)),
  );
  const now = Date.now();
  // Fail-closed vor der teuren Passwortableitung. Der spätere bedingte INSERT prüft
  // denselben Token innerhalb der D1-Transaktion erneut und konsumiert ihn atomar.
  const invite = await env.DB.prepare(
    `SELECT token_hash FROM registration_invites
      WHERE token_hash = ? AND used_at IS NULL AND expires_at >= ?`,
  )
    .bind(inviteHash, now)
    .first<{ token_hash: string }>();
  if (!invite) return error(403, 'Einladungscode ist ungültig oder bereits verwendet');
  const day = new Date().toISOString().slice(0, 10);
  const ipKey = await registrationIpKey(req, env, id);
  const quota = await env.DB.prepare(
    `SELECT
       COALESCE((SELECT users FROM registration_total_usage WHERE id = 1), 0) AS users,
       COALESCE((SELECT CASE WHEN day = ? THEN registrations ELSE 0 END
                   FROM registration_daily_usage WHERE id = 1), 0) AS global_today,
       COALESCE((SELECT CASE WHEN day = ? THEN registrations ELSE 0 END
                   FROM registration_ip_daily_usage WHERE ip_key = ?), 0) AS ip_today`,
  )
    .bind(day, day, ipKey)
    .first<{ users: number; global_today: number; ip_today: number }>();
  if ((quota?.users ?? 0) >= MAX_REGISTERED_USERS) {
    return error(503, 'Registrierung ist vorübergehend geschlossen.');
  }
  if ((quota?.global_today ?? 0) >= 5 || (quota?.ip_today ?? 0) >= 1) {
    return error(429, 'Tägliches Registrierungslimit erreicht. Bitte später erneut versuchen.');
  }
  const hash = await hashPassword(password);
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, email, password_hash, created_at)
         SELECT ?,?,?,?
          WHERE COALESCE((SELECT users FROM registration_total_usage WHERE id = 1), 0) < ?
            AND EXISTS (
              SELECT 1 FROM registration_invites
               WHERE token_hash = ? AND used_at IS NULL AND expires_at >= ?
            )
         RETURNING id`,
      ).bind(id, email, hash, now, MAX_REGISTERED_USERS, inviteHash, now),
      env.DB.prepare(
        `UPDATE registration_invites
            SET used_at = ?, used_by = ?
          WHERE token_hash = ? AND used_at IS NULL AND expires_at >= ?
            AND changes() > 0
          RETURNING token_hash`,
      ).bind(now, id, inviteHash, now),
      env.DB.prepare(
        `INSERT INTO registration_daily_usage (id, day, registrations)
         SELECT 1,?,1 WHERE changes() > 0
         ON CONFLICT(id) DO UPDATE SET
           day = excluded.day,
           registrations = CASE WHEN registration_daily_usage.day = excluded.day
             THEN registration_daily_usage.registrations + 1 ELSE 1 END`,
      ).bind(day),
      env.DB.prepare(
        `INSERT INTO registration_ip_daily_usage (ip_key, day, registrations)
         SELECT ?,?,1 WHERE changes() > 0
         ON CONFLICT(ip_key) DO UPDATE SET
           day = excluded.day,
           registrations = CASE WHEN registration_ip_daily_usage.day = excluded.day
             THEN registration_ip_daily_usage.registrations + 1 ELSE 1 END`,
      ).bind(ipKey, day),
    ]);
    const inserted = (results[0]?.results?.[0] as { id?: string } | undefined)?.id;
    if (!inserted) return error(503, 'Registrierung ist vorübergehend geschlossen.');
    const consumed = (results[1]?.results?.[0] as { token_hash?: string } | undefined)?.token_hash;
    if (consumed !== inviteHash) {
      throw new Error('Einladungscode konnte nicht atomar konsumiert werden');
    }
  } catch (e) {
    // Race zwischen dem obigen SELECT und diesem INSERT (zwei gleichzeitige Registrierungen
    // derselben E-Mail): die UNIQUE-Constraint schlägt zu statt des vorherigen Checks.
    // Ohne dieses catch würde D1 hier einen 500er werfen statt der erwarteten 409.
    if (/unique/i.test((e as Error).message ?? '')) return error(409, 'E-Mail bereits registriert');
    if (/registration_(global|ip)_daily_limit/i.test((e as Error).message ?? '')) {
      return error(429, 'Tägliches Registrierungslimit erreicht. Bitte später erneut versuchen.');
    }
    throw e;
  }
  const token = await signJwt({ sub: id }, env.JWT_SECRET);
  return json({ token, user: { id, email } });
}

export async function handleLogin(req: IRequest, env: Env): Promise<Response> {
  if (!secretOk(env)) return error(500, 'Server fehlkonfiguriert');
  const limited = await rateLimited(req, env);
  if (limited) return limited;
  const parsed = await readJsonBody<Creds>(req, MAX_AUTH_BODY_BYTES);
  if (!parsed.ok) {
    return error(parsed.reason === 'too-large' ? 413 : 400, 'Ungültige Auth-Anfrage');
  }
  const creds = parsed.value;
  const email = normalizeEmail(creds.email);
  const password = creds.password ?? '';
  if (!email || !password || password.length > MAX_PW) return error(400, 'email und password erforderlich');
  // COLLATE NOCASE matcht auch Altkonten, deren E-Mail in gemischter Schreibweise gespeichert ist.
  const row = await env.DB.prepare('SELECT id, email, password_hash FROM users WHERE email = ? COLLATE NOCASE')
    .bind(email)
    .first<{ id: string; email: string; password_hash: string }>();
  if (!row || !(await verifyPassword(password, row.password_hash))) return error(401, 'Ungültige Anmeldedaten');
  const token = await signJwt({ sub: row.id }, env.JWT_SECRET);
  return json({ token, user: { id: row.id, email: row.email } });
}

// Middleware: setzt req.userId oder bricht mit 401 ab.
export async function requireAuth(req: IRequest, env: Env): Promise<Response | void> {
  if (!secretOk(env)) return error(500, 'Server fehlkonfiguriert');
  const header = req.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = token ? await verifyJwt(token, env.JWT_SECRET) : null;
  if (!payload || typeof payload.sub !== 'string') return error(401, 'Nicht autorisiert');
  (req as IRequest & { userId: string }).userId = payload.sub;
}

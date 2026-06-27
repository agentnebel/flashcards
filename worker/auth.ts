import { error, json } from 'itty-router';
import type { IRequest } from 'itty-router';
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
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const data = parts[0] + '.' + parts[1];
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify('HMAC', key, b64urlDecode(parts[2]), enc.encode(data));
  if (!ok) return null;
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))) as Record<string, unknown>;
  if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
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
  return b64urlEncode(bits) === hashB64;
}

interface Creds {
  email?: string;
  password?: string;
}

export async function handleRegister(req: IRequest, env: Env): Promise<Response> {
  const { email, password } = (await req.json().catch(() => ({}))) as Creds;
  if (!email || !password || password.length < 8) return error(400, 'email und password (min. 8 Zeichen) erforderlich');
  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) return error(409, 'E-Mail bereits registriert');
  const id = crypto.randomUUID();
  const hash = await hashPassword(password);
  await env.DB.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?,?,?,?)')
    .bind(id, email, hash, Date.now())
    .run();
  const token = await signJwt({ sub: id }, env.JWT_SECRET);
  return json({ token, user: { id, email } });
}

export async function handleLogin(req: IRequest, env: Env): Promise<Response> {
  const { email, password } = (await req.json().catch(() => ({}))) as Creds;
  if (!email || !password) return error(400, 'email und password erforderlich');
  const row = await env.DB.prepare('SELECT id, password_hash FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string; password_hash: string }>();
  if (!row || !(await verifyPassword(password, row.password_hash))) return error(401, 'Ungültige Anmeldedaten');
  const token = await signJwt({ sub: row.id }, env.JWT_SECRET);
  return json({ token, user: { id: row.id, email } });
}

// Middleware: setzt req.userId oder bricht mit 401 ab.
export async function requireAuth(req: IRequest, env: Env): Promise<Response | void> {
  const header = req.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = token ? await verifyJwt(token, env.JWT_SECRET) : null;
  if (!payload || typeof payload.sub !== 'string') return error(401, 'Nicht autorisiert');
  (req as IRequest & { userId: string }).userId = payload.sub;
}

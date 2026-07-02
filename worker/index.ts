import { AutoRouter, json } from 'itty-router';
import type { IRequest } from 'itty-router';
import { handleLogin, handleRegister, requireAuth } from './auth';
import { handlePull, handlePush } from './sync';
import { handleMediaExists, handleMediaGet, handleMediaUpload } from './media';

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  // R2 ist noch nicht aktiviert -> Binding ist in wrangler.jsonc auskommentiert und
  // zur Laufzeit undefined. Handler müssen das abfangen (503). Optional getypt.
  MEDIA?: R2Bucket;
  // Rate-Limiting-Binding (wrangler.jsonc "unsafe"). Optional getypt, damit Umgebungen
  // ohne Binding (ältere lokale Setups) nicht crashen — dann greift kein Limit.
  AUTH_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  JWT_SECRET: string;
}

// Eigene, stabile JSON-API. /api/* wird per run_worker_first vor den Static Assets ausgeführt.
const router = AutoRouter<IRequest, [Env, ExecutionContext]>({ base: '/api' });

router
  .get('/health', () => json({ ok: true, ts: Date.now() }))
  .post('/auth/register', handleRegister)
  .post('/auth/login', handleLogin)
  .post('/sync/pull', requireAuth, handlePull)
  .post('/sync/push', requireAuth, handlePush)
  .post('/media/upload', requireAuth, handleMediaUpload)
  .post('/media/exists', requireAuth, handleMediaExists)
  .get('/media/:hash', requireAuth, handleMediaGet);

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => router.fetch(request, env, ctx),
};

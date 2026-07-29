import { AutoRouter, error, json } from 'itty-router';
import type { IRequest } from 'itty-router';
import { handleLogin, handleRegister, requireAuth } from './auth';
import { handlePull, handlePush } from './sync';
import { handleMediaExists, handleMediaGc, handleMediaGet, handleMediaUpload } from './media';

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  // R2 ist noch nicht aktiviert -> Binding ist in wrangler.jsonc auskommentiert und
  // zur Laufzeit undefined. Handler müssen das abfangen (503). Optional getypt.
  MEDIA?: R2Bucket;
  AUTH_LIMITER: RateLimit;
  SYNC_LIMITER: RateLimit;
  MEDIA_LIMITER: RateLimit;
  JWT_SECRET: string;
  MIGRATION_WRITE_PAUSE?: string;
}

// Eigene, stabile JSON-API. /api/* wird per run_worker_first vor den Static Assets ausgeführt.
const router = AutoRouter<IRequest, [Env, ExecutionContext]>({ base: '/api' });

router
  .get('/health', () => json({ ok: true, ts: Date.now() }))
  // Sicherer Schema-Cutover: Diese Worker-Version kann vor 0003 einmal mit
  // `--var MIGRATION_WRITE_PAUSE:1` deployt werden. Dann erreicht kein API-Request
  // Handler, die bereits das neue Schema voraussetzen.
  .all('*', (_req, env) =>
    env.MIGRATION_WRITE_PAUSE === '1'
      ? error(503, 'Wartungsfenster – bitte in wenigen Minuten erneut versuchen.')
      : undefined)
  .post('/auth/register', handleRegister)
  .post('/auth/login', handleLogin)
  .post('/sync/pull', requireAuth, handlePull)
  .post('/sync/push', requireAuth, handlePush)
  .post('/media/upload', requireAuth, handleMediaUpload)
  .post('/media/exists', requireAuth, handleMediaExists)
  .post('/media/gc', requireAuth, handleMediaGc)
  .get('/media/:hash', requireAuth, handleMediaGet);

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => router.fetch(request, env, ctx),
};

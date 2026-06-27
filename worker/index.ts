import { AutoRouter, json } from 'itty-router';
import type { IRequest } from 'itty-router';
import { handleLogin, handleRegister, requireAuth } from './auth';
import { handlePull, handlePush } from './sync';
import { handleMediaGet, handleMediaUpload } from './media';

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  MEDIA: R2Bucket;
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
  .get('/media/:hash', requireAuth, handleMediaGet);

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => router.fetch(request, env, ctx),
};

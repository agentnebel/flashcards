import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const mode = process.argv[2];
if (mode !== '--local' && mode !== '--remote') {
  console.error('Aufruf: node scripts/d1-finalize.mjs --local|--remote');
  process.exit(2);
}

const sql = readFileSync(
  new URL('../worker/migrations/0004_finalize_sync_allocator.sql', import.meta.url),
  'utf8',
);
const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(
  command,
  ['wrangler', 'd1', 'execute', 'flashcards-db', mode, '--command', sql, '--json'],
  { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
);
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}

const executions = JSON.parse(result.stdout);
if (!Array.isArray(executions) || executions.some((entry) => entry.success === false)) {
  console.error('Finalisierung wurde nicht vollständig bestätigt.');
  process.exit(1);
}
console.log('D1-Finalisierung und einmaliger Backfill abgeschlossen.');

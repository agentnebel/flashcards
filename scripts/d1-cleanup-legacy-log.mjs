import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const mode = process.argv[2];
if (mode !== '--local' && mode !== '--remote') {
  console.error('Aufruf: node scripts/d1-cleanup-legacy-log.mjs --local|--remote');
  process.exit(2);
}

const sql = readFileSync(
  new URL('../worker/migrations/0005_cleanup_legacy_change_log_batch.sql', import.meta.url),
  'utf8',
);
const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(
  command,
  ['wrangler', 'd1', 'execute', 'flashcards-db', mode, `--command=${sql}`, '--json'],
  { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
);
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}

const executions = JSON.parse(result.stdout);
const status = executions
  .flatMap((entry) => entry.results ?? [])
  .find((row) => typeof row.has_more === 'number');
if (!status) {
  console.error('Cleanup-Status fehlt in der Wrangler-Antwort.');
  process.exit(1);
}
console.log(`Historische Feed-Zeilen in diesem Batch entfernt: ${status.removed}.`);
if (status.has_more === 1) {
  console.log('Diesen Cleanup später erneut ausführen; neue Feed-Zeilen wachsen nicht nach.');
} else {
  console.log('Keine historischen Feed-Zeilen mehr vorhanden.');
}

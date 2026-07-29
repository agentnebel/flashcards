import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const mode = process.argv[2];
if (mode !== '--local' && mode !== '--remote') {
  console.error('Aufruf: node scripts/d1-preflight.mjs --local|--remote');
  process.exit(2);
}

const sql = readFileSync(
  new URL('../worker/migrations/preflight_sync_quotas.sql', import.meta.url),
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
const rows = executions.flatMap((entry) => entry.results ?? []);
const warnings = rows.filter((row) => String(row.limit_name).startsWith('warning_'));
const violations = rows.filter((row) => !String(row.limit_name).startsWith('warning_'));
if (warnings.length > 0) {
  console.warn('D1-Preflight-Hinweise (blockieren 0003 nicht):');
  console.table(warnings);
}
if (violations.length > 0) {
  console.error('D1-Preflight fehlgeschlagen; 0003 nicht ausführen:');
  console.table(violations);
  process.exit(1);
}
console.log('D1-Preflight bestanden: keine Quota-Verletzung gefunden.');

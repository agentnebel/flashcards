import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const mode = process.argv[2];
const daysArg = process.argv.find((arg) => arg.startsWith('--days='));
const persistArg = process.argv.find((arg) => arg.startsWith('--persist-to='));
const validDays = daysArg ? Number(daysArg.slice('--days='.length)) : 7;
if (
  (mode !== '--local' && mode !== '--remote') ||
  !Number.isInteger(validDays) ||
  validDays < 1 ||
  validDays > 90
) {
  console.error(
    'Aufruf: node scripts/d1-create-invite.mjs --local|--remote ' +
      '[--days=1..90] [--persist-to=/lokaler/pfad]',
  );
  process.exit(2);
}
if (mode === '--remote' && persistArg) {
  console.error('--persist-to ist nur zusammen mit --local erlaubt.');
  process.exit(2);
}

const token = randomBytes(32).toString('base64url');
const tokenHash = createHash('sha256').update(token, 'utf8').digest('base64url');
const createdAt = Date.now();
const expiresAt = createdAt + validDays * 24 * 60 * 60 * 1000;
const sql =
  'INSERT INTO registration_invites ' +
  '(token_hash, created_at, expires_at, used_at, used_by) ' +
  `VALUES ('${tokenHash}', ${createdAt}, ${expiresAt}, NULL, NULL);`;
const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const wranglerArgs = [
  'wrangler',
  'd1',
  'execute',
  'flashcards-db',
  mode,
  ...(persistArg ? ['--persist-to', persistArg.slice('--persist-to='.length)] : []),
  '--command',
  sql,
  '--json',
];
const result = spawnSync(
  command,
  wranglerArgs,
  { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
);
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}

const executions = JSON.parse(result.stdout);
if (!Array.isArray(executions) || executions.some((entry) => entry.success === false)) {
  console.error('Einladung wurde von D1 nicht vollständig bestätigt.');
  process.exit(1);
}

console.log(`Einladungscode (nur jetzt sichtbar): ${token}`);
console.log(`Gültig bis: ${new Date(expiresAt).toISOString()}`);

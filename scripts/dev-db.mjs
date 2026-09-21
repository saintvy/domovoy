import { spawn, spawnSync } from 'node:child_process';
import {
  readFileSync,
  existsSync,
  appendFileSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const action = process.argv[2] ?? 'up';
if (!['up', 'down', 'status'].includes(action))
  throw new Error(
    'Use node scripts/dev-db.mjs up|down|status. No automatic volume deletion.',
  );
const path = resolve('.env.local');
let content = existsSync(path) ? readFileSync(path, 'utf8') : '';
const env = parseEnv(content);
if (action === 'up') {
  const password = env.POSTGRES_PASSWORD ?? randomBytes(32).toString('hex');
  const defaults = {
    POSTGRES_PASSWORD: password,
    BROWNIE_LOCAL_DATABASE_URL:
      'postgresql://brownie_local:' +
      encodeURIComponent(password) +
      '@127.0.0.1:5434/brownie_local',
    BROWNIE_LOCAL_MAINTENANCE_KEY: randomBytes(32).toString('hex'),
  };
  const missing = Object.entries(defaults).filter(([key]) => !env[key]);
  if (missing.length) {
    const extra =
      '\n# Domovoy local Docker settings\n' +
      missing
        .map(([key, value]) => key + '=' + JSON.stringify(value))
        .join('\n') +
      '\n';
    if (existsSync(path)) appendFileSync(path, extra);
    else writeFileSync(path, extra, { mode: 0o600 });
  }
  const loaded = parseEnv(readFileSync(path, 'utf8')),
    url = new URL(loaded.BROWNIE_LOCAL_DATABASE_URL);
  if (
    url.hostname !== '127.0.0.1' ||
    url.port !== '5434' ||
    url.pathname !== '/brownie_local' ||
    url.username !== 'brownie_local' ||
    decodeURIComponent(url.password) !== loaded.POSTGRES_PASSWORD
  )
    throw new Error(
      'Local database settings do not match the dedicated Docker database. No cloud connection is allowed.',
    );
}
function docker(args, quiet = false) {
  return spawnSync('docker', args, {
    cwd: process.cwd(),
    stdio: quiet ? 'ignore' : 'inherit',
    windowsHide: true,
  });
}
if (docker(['version', '--format', '{{.Server.Version}}'], true).status !== 0) {
  if (action !== 'up') throw new Error('Docker Desktop is not running.');
  const desktop = resolve(
    process.env.ProgramFiles ?? 'C:/Program Files',
    'Docker/Docker/Docker Desktop.exe',
  );
  if (process.platform === 'win32' && existsSync(desktop)) {
    const escaped = desktop.replaceAll("'", "''");
    spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "Start-Process -WindowStyle Hidden -FilePath '" + escaped + "'",
      ],
      { stdio: 'ignore', windowsHide: true },
    );
    console.log('Starting Docker Desktop...');
    const deadline = Date.now() + 90000;
    while (
      Date.now() < deadline &&
      docker(['version', '--format', '{{.Server.Version}}'], true).status !== 0
    )
      await new Promise((r) => setTimeout(r, 1500));
  }
  if (docker(['version', '--format', '{{.Server.Version}}'], true).status !== 0)
    throw new Error(
      'Start Docker Desktop in Linux containers mode, then repeat this command.',
    );
}
const args = [
  'compose',
  '--env-file',
  '.env.local',
  '-f',
  'docker-compose.yml',
];
args.push(
  ...(action === 'up'
    ? ['up', '-d', '--wait', '--wait-timeout', '90']
    : action === 'down'
      ? ['stop', 'postgres']
      : ['ps']),
);
const child = spawn('docker', args, { stdio: 'inherit', windowsHide: true });
child.once('error', () => {
  console.error('Docker command failed.');
  process.exitCode = 1;
});
await new Promise((resolve) =>
  child.once('exit', (code) => {
    process.exitCode = code ?? 1;
    resolve();
  }),
);

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const apiPort = Number(process.env.BROWNIE_LOCAL_PORT ?? 8787);
if (
  !Number.isInteger(apiPort) ||
  apiPort < 1024 ||
  apiPort > 65535 ||
  apiPort === 5173
)
  throw new Error('Invalid BROWNIE_LOCAL_PORT');
for (const port of [5173, apiPort])
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () =>
      reject(
        new Error(
          'Port ' +
            port +
            ' is in use. Stop the previous development server first.',
        ),
      ),
    );
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
const setup = spawnSync(process.execPath, ['scripts/dev-db.mjs', 'up'], {
  stdio: 'inherit',
  windowsHide: true,
});
if (setup.status !== 0) process.exit(setup.status ?? 1);
const children = [
  spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'],
    { stdio: 'inherit', windowsHide: true },
  ),
  spawn(process.execPath, ['--import', 'tsx', 'scripts/dev-api.ts'], {
    stdio: 'inherit',
    windowsHide: true,
  }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  setTimeout(() => process.exit(code), 400).unref();
}
for (const child of children) {
  child.on('exit', (code) => stop(code ?? 0));
  child.on('error', () => stop(1));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
console.log(
  'Local Google login: http://127.0.0.1:5173/. SQL stays in the Docker volume. Stop PostgreSQL with node scripts/dev-db.mjs down.',
);

import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
const port = Number(process.env.BROWNIE_LOCAL_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid BROWNIE_LOCAL_PORT');
try {
  const env = parseEnv(
    readFileSync(new URL('../.env.local', import.meta.url), 'utf8'),
  );
  if (!env.BROWNIE_LOCAL_MAINTENANCE_KEY)
    throw new Error('Local maintenance key is missing.');
  const response = await fetch(
    'http://127.0.0.1:' + port + '/api/local/maintenance',
    {
      method: 'POST',
      headers: {
        Origin: 'http://127.0.0.1:5173',
        'x-brownie-maintenance': env.BROWNIE_LOCAL_MAINTENANCE_KEY,
      },
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok)
    throw new Error('Local maintenance HTTP ' + response.status);
  console.log(await response.json());
} catch (error) {
  console.error(
    'Local maintenance failed. Start npm run dev first. ' + error.message,
  );
  process.exitCode = 1;
}

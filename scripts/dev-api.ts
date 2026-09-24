import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { FamilyApplication } from '../src/aws/families';
import { runFamilyMaintenance } from '../src/aws/family-maintenance';
import { ApiError } from '../src/aws/identity';
import { DomainError } from '../src/domain';
import { createLocalFamilyServices } from './local-services';
import { openLocalPostgres } from './local-postgres';
import {
  loadLocalEnvironment,
  loadLocalPublicConfig,
  localOrigin,
} from './local-config';
import { createLocalIdentityVerifier } from './local-jwt';

const port = Number(process.env.BROWNIE_LOCAL_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid local API port');
const config = loadLocalPublicConfig(),
  env = loadLocalEnvironment();
if (!env.BROWNIE_LOCAL_MAINTENANCE_KEY)
  throw new Error('Run node scripts/dev-db.mjs up first.');
const identity = createLocalIdentityVerifier(config);
const postgres = await openLocalPostgres();
const services = createLocalFamilyServices();
const application = new FamilyApplication(postgres.database, services);
let maintenance: Promise<unknown> | undefined;
function maintain() {
  return (maintenance ??= runFamilyMaintenance(
    postgres.database,
    services,
  ).finally(() => {
    maintenance = undefined;
  }));
}
const timer = setInterval(() => {
  void maintain().catch(() => console.error('Local maintenance failed.'));
}, 60_000);
timer.unref();
const server = createServer(async (request, response) => {
  try {
    if (
      request.headers.host !== '127.0.0.1:' + port &&
      request.headers.host !== 'localhost:' + port
    )
      throw new ApiError('LOCAL_ONLY', 403);
    if (request.headers.origin && request.headers.origin !== localOrigin)
      throw new ApiError('ORIGIN_REJECTED', 403);
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    let raw = '';
    for await (const chunk of request) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 4 * 1024 * 1024)
        throw new ApiError('PAYLOAD_TOO_LARGE', 413);
    }
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      throw new ApiError('VALIDATION_FAILED', 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new ApiError('VALIDATION_FAILED', 400);
    if (path === '/api/commands' && Buffer.byteLength(raw) > 1024 * 1024)
      throw new ApiError('PAYLOAD_TOO_LARGE', 413);
    let result: unknown;
    if (path === '/api/health' && request.method === 'GET')
      result = {
        ok: true,
        localMode: false,
        architecture: 'local-docker-postgresql',
        authProvider: 'cognito-google',
      };
    else if (path === '/api/locale' && request.method === 'GET')
      result = { locale: 'en' }; // No IP geography on the local development server.
    else if (path === '/api/local/maintenance' && request.method === 'POST') {
      const supplied = Buffer.from(
          String(request.headers['x-brownie-maintenance'] ?? ''),
        ),
        expected = Buffer.from(env.BROWNIE_LOCAL_MAINTENANCE_KEY);
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        throw new ApiError('FORBIDDEN', 403);
      result = await maintain();
    } else
      result = await application.handle({
        path,
        method: request.method ?? 'GET',
        body,
        identity: await identity(request.headers.authorization),
        token:
          typeof request.headers['x-brownie-session'] === 'string'
            ? request.headers['x-brownie-session']
            : undefined,
      });
    const encoded = JSON.stringify(result);
    if (Buffer.byteLength(encoded) > 5 * 1024 * 1024)
      throw new ApiError('RESPONSE_TOO_LARGE', 413);
    response
      .writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      .end(encoded);
  } catch (error) {
    const code =
      error instanceof ApiError || error instanceof DomainError
        ? error.code
        : 'LOCAL_SERVER_ERROR';
    response
      .writeHead(
        error instanceof ApiError
          ? error.status
          : error instanceof DomainError
            ? 400
            : 500,
        { 'content-type': 'application/json', 'cache-control': 'no-store' },
      )
      .end(JSON.stringify({ error: { code, message: code } }));
  }
});
server.listen(port, '127.0.0.1', () =>
  console.log(
    'Domovoy local Docker PostgreSQL API: http://127.0.0.1:' +
      port +
      ' (real Cognito Google authentication)',
  ),
);
server.once('error', () => {
  console.error('Local API could not start.');
  void stop(1);
});
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await maintenance?.catch(() => {});
  await postgres.close();
  process.exit(code);
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());

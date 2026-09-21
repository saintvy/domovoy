/* Bump this version when publishing a new shell/service-worker release. */
const CACHE_NAME = 'domovoy-shell-beneficiary-colours-2026-09-21-3';
const STATIC_PATH =
  /^\/assets\/[a-zA-Z0-9_./-]+\.(?:js|css|woff2?|png|jpe?g|webp|svg|ico)$/;
const SHELL_PATHS = new Set(['/', '/index.html']);
const PUBLIC_FILES = new Set(['/favicon.svg', '/manifest.webmanifest']);

function safeResponse(response) {
  return response.ok && !response.redirected && response.type !== 'opaque';
}

async function storeShell(response) {
  if (
    !safeResponse(response) ||
    !response.headers.get('content-type')?.includes('text/html')
  )
    return;
  const html = await response.clone().text();
  const paths = [
    ...new Set(
      [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)].map(
        (match) => match[1],
      ),
    ),
  ].filter((path) => STATIC_PATH.test(path));
  if (!paths.some((path) => path.endsWith('.js'))) return;
  const cache = await caches.open(CACHE_NAME);
  // Publish the cached HTML only after its exact hashed assets are available.
  await Promise.all(
    paths.map(async (path) => {
      if (await cache.match(path)) return;
      const asset = await fetch(path, { credentials: 'omit', cache: 'reload' });
      if (!safeResponse(asset)) throw new Error('Shell asset unavailable');
      await cache.put(path, asset);
    }),
  );
  await cache.put('/', response.clone());
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shell = await fetch('/', { credentials: 'omit', cache: 'reload' });
      await storeShell(shell);
      const cache = await caches.open(CACHE_NAME);
      for (const path of PUBLIC_FILES) {
        const response = await fetch(path, {
          credentials: 'omit',
          cache: 'reload',
        });
        if (safeResponse(response)) await cache.put(path, response);
      }
      // Intentionally no skipWaiting: an open form never triggers an automatic update.
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(
            (key) => key.startsWith('domovoy-shell-') && key !== CACHE_NAME,
          )
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'ACTIVATE_SHELL_UPDATE') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.search
  )
    return;
  // API, authorization callbacks and every other dynamic endpoint are excluded
  // by this static allowlist, including error responses and private projections.
  if (request.mode === 'navigate' && SHELL_PATHS.has(url.pathname)) {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (!safeResponse(response))
            throw new Error('Navigation unavailable');
          event.waitUntil(storeShell(response.clone()).catch(() => {}));
          return response;
        } catch {
          const cached = await (await caches.open(CACHE_NAME)).match('/');
          return (
            cached ||
            new Response(
              'Open Domovoy once while online before using it offline.',
              {
                status: 503,
                headers: { 'Content-Type': 'text/plain; charset=utf-8' },
              },
            )
          );
        }
      })(),
    );
    return;
  }
  if (STATIC_PATH.test(url.pathname) || PUBLIC_FILES.has(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        // Public immutable assets can carry Vary: Origin from the host. The page's
        // module request and this worker's prefetch have different Origin headers.
        const cached = await cache.match(request, { ignoreVary: true });
        if (cached) return cached;
        const response = await fetch(request);
        if (safeResponse(response)) await cache.put(request, response.clone());
        return response;
      })(),
    );
  }
});

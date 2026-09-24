import { test, expect } from '@playwright/test';
test.use({ locale: 'en-US' });
test('production shell opens offline without cached financial or authentication responses', async ({
  page,
  context,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Continue with Google', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
    .toBe(true);
  await page.evaluate(async () => {
    await fetch('/api/session');
    await fetch('/oauth2/token?test=excluded');
    await fetch('/runtime-config.json');
  });
  const cached = await page.evaluate(async () => {
    const names = (await caches.keys()).filter((key) =>
      key.startsWith('domovoy-shell-'),
    );
    return (
      await Promise.all(
        names.map(async (name) =>
          (await (await caches.open(name)).keys()).map(
            (request) => new URL(request.url).pathname,
          ),
        ),
      )
    ).flat();
  });
  expect(cached).toContain('/');
  expect(cached.some((path) => path.endsWith('.js'))).toBe(true);
  expect(
    cached.every(
      (path) =>
        path === '/' ||
        path === '/favicon.svg' ||
        path === '/manifest.webmanifest' ||
        path.startsWith('/assets/'),
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('online-login.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Continue with Google', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Everything under control.' }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      fetch('/api/state').then(
        () => false,
        () => true,
      ),
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('offline-mobile-login.png'),
    fullPage: true,
    animations: 'disabled',
  });
  expect(errors).toEqual([]);
});

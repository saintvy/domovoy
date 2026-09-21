import { test, expect } from '@playwright/test';

/** Browser contract only: real OAuth redirect, no fake logged-in identity or dev-login endpoint.
 * Completing Google's interactive consent is a separate manual acceptance check.
 */
test('local UI uses the same Google authorization-code and PKCE login as production', async ({
  page,
}) => {
  await page.route('**/runtime-config.json', (route) =>
    route.fulfill({
      json: {
        apiBaseUrl: '/api',
        cognitoDomain:
          'https://brownie-test.auth.eu-central-1.amazoncognito.com',
        cognitoClientId: 'browser-contract-client',
        cognitoUserPoolId: 'eu-central-1_BrowserTest',
        cognitoRedirectUri: 'http://127.0.0.1:5173/',
        region: 'eu-central-1',
      },
    }),
  );
  await page.route(
    'https://brownie-test.auth.eu-central-1.amazoncognito.com/**',
    (route) => {
      const destination = new URL(route.request().url());
      if (destination.pathname === '/logout') {
        expect(destination.searchParams.get('logout_uri')).toBe(
          'http://127.0.0.1:5173/',
        );
        return route.fulfill({
          status: 302,
          headers: { location: 'http://127.0.0.1:5173/' },
          body: '',
        });
      }
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>OAuth destination contract</title>',
      });
    },
  );
  await page.goto('/');
  await expect(
    page.getByRole('button', {
      name: /посмотреть демо|локальный тестовый дом/i,
    }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: /Google/ }).click();
  await page.waitForURL(
    (url) =>
      url.hostname === 'brownie-test.auth.eu-central-1.amazoncognito.com' &&
      url.pathname === '/oauth2/authorize',
  );
  const url = new URL(page.url());
  expect(url.pathname).toBe('/oauth2/authorize');
  expect(url.searchParams.get('identity_provider')).toBe('Google');
  expect(url.searchParams.get('response_type')).toBe('code');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('code_challenge')).toMatch(/^[a-zA-Z0-9_-]{43}$/);
  expect(url.searchParams.get('state')).toMatch(/^[a-zA-Z0-9_-]{43}$/);
  expect(url.searchParams.get('nonce')).toMatch(/^[a-zA-Z0-9_-]{43}$/);
  expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5173/');
  expect(url.searchParams.has('client_secret')).toBe(false);
});

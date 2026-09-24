import { expect, test } from '@playwright/test';
import { createDemoState } from '../src/domain';
import { mockGoogleHousehold } from './household-fixture';

test('a late invitation survives Google redirects and joins the existing family with its assigned role', async ({
  page,
}) => {
  const origin = 'http://127.0.0.1:5173';
  const invitation = 'x'.repeat(43);
  const state = createDemoState('2026-09-15');
  state.household.name = 'Invitation test household';
  const user = {
    id: 'invited-account',
    name: 'Invited member',
    login: 'member@example.com',
    role: 'observer',
  };
  let nonce = '',
    accepted = false;
  await page.route('**/runtime-config.json', (route) =>
    route.fulfill({
      json: {
        apiBaseUrl: '/api',
        cognitoDomain: 'https://identity.example',
        cognitoClientId: 'test-client',
        cognitoRedirectUri: origin + '/',
      },
    }),
  );
  await page.route('https://identity.example/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/logout')
      return route.fulfill({
        status: 302,
        headers: { location: origin + '/' },
      });
    if (url.pathname === '/oauth2/authorize') {
      nonce = url.searchParams.get('nonce')!;
      return route.fulfill({
        status: 302,
        headers: {
          location:
            origin + '/?code=test-code&state=' + url.searchParams.get('state'),
        },
      });
    }
    if (url.pathname === '/oauth2/token')
      return route.fulfill({
        json: {
          id_token:
            'header.' +
            Buffer.from(
              JSON.stringify({ nonce, sub: user.id, exp: 2000000000 }),
            ).toString('base64url') +
            '.test-only',
        },
      });
    return route.abort();
  });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/locale')
      return route.fulfill({ json: { locale: 'en' } });
    if (path === '/api/auth/session')
      return route.fulfill({ json: { onboarding: true } });
    if (path === '/api/invitations/accept') {
      expect(route.request().postDataJSON()).toEqual({ token: invitation });
      accepted = true;
      return route.fulfill({
        json: { ok: true, sessionToken: 'test-family-session' },
      });
    }
    if (path === '/api/session')
      return route.fulfill({
        json: accepted
          ? { user, initialized: true }
          : { onboarding: true, user: null },
      });
    if (path === '/api/state')
      return route.fulfill({
        json: { state, user, instanceGeneration: 'test-generation' },
      });
    if (path === '/api/sessions')
      return route.fulfill({ json: { sessions: [] } });
    if (path === '/api/sync/state')
      return route.fulfill({ json: { publishedRevision: state.revision } });
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Welcome home' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Change language' }).click();
  await expect(
    page.getByRole('heading', { name: 'С возвращением' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Сменить язык' }).click();
  // Same-document fragment navigation after the application has initialized.
  await page.evaluate((token) => {
    location.hash = 'invite=' + token;
  }, invitation);
  await expect
    .poll(() =>
      page.evaluate(() => sessionStorage.getItem('brownie-invitation')),
    )
    .toBe(invitation);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(
    page.getByRole('button', { name: 'Accept invitation', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Create household', exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Accept invitation', exact: true })
    .click();
  await expect(
    page.getByText('Invitation test household', { exact: true }).first(),
  ).toBeVisible();
  expect(accepted).toBe(true);
  expect(
    await page.evaluate(() => sessionStorage.getItem('brownie-invitation')),
  ).toBeNull();
  await expect(
    page.getByRole('button', { name: 'Add obligation', exact: true }),
  ).toHaveCount(0);
});

test('settings columns stack independently and the language preference follows the selected interface', async ({
  page,
}) => {
  const fixture = await mockGoogleHousehold(page);
  const locales: string[] = [];
  await page.route('**/api/account/preferences', (route) => {
    locales.push(route.request().postDataJSON().locale);
    return route.fulfill({ json: { ok: true } });
  });
  await fixture.open();
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  const columns = page.locator('.settings-column');
  await expect(columns).toHaveCount(2);
  await expect(
    columns.nth(0).getByRole('heading', { name: 'Устройства и сессии' }),
  ).toBeVisible();
  await expect(
    columns.nth(1).getByRole('heading', { name: 'Домохозяйство', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: 'test-results/settings-independent-columns.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Сменить язык' }).click();
  await expect.poll(() => locales.at(-1)).toBe('en');
  await expect(
    page.getByRole('heading', { name: 'Devices & sessions' }),
  ).toBeVisible();
});

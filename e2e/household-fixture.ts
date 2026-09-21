import { expect, type Page } from '@playwright/test';
import { applyCommands, createDemoState } from '../src/domain';
export const TEST_DATE = '2026-09-15';
export const TEST_USER = {
  id: 'test-admin',
  login: 'parent@example.com',
  name: 'Тестовый администратор',
  role: 'admin',
};
/** Explicit browser test fixture; no authentication bypass exists in application code. */
export async function mockGoogleHousehold(page: Page) {
  let state = createDemoState(TEST_DATE),
    user: any = { ...TEST_USER },
    revoked = false,
    stateRevoked = false;
  let behavior: 'commit' | 'pending' | 'conflict' | 'lost-response' = 'commit',
    operationStatus = 'COMMITTED';
  const requests: any[] = [],
    receipts = new Map<string, unknown>(),
    errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  state.household.name = 'Проверяемая семья';
  state.household.currencies = [state.household.currency];
  await page.clock.install({ time: new Date(TEST_DATE + 'T10:00:00Z') });
  await page.addInitScript(() => {
    sessionStorage.setItem(
      'brownie-cognito-id',
      `${btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${btoa(JSON.stringify({ sub: 'test-google-subject', exp: 2000000000, token_use: 'id' }))}.explicit-test-only-signature`,
    );
    sessionStorage.setItem('brownie-app-session', 'explicit-test-session');
    localStorage.setItem('domovoy-language', 'ru');
  });
  await page.route('**/runtime-config.json', (route) =>
    route.fulfill({ json: { apiBaseUrl: '/api', authMode: 'cognito' } }),
  );
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const failure = (code: string, status = 401) =>
      route.fulfill({
        status,
        json: {
          code,
          message:
            code === 'REVISION_CONFLICT'
              ? 'Данные изменились. Проверьте обновлённые значения.'
              : 'Сессия завершена',
        },
      });
    if (
      (revoked && path !== '/api/session') ||
      (stateRevoked && path === '/api/state')
    )
      return failure('SESSION_REVOKED');
    let result: unknown = {};
    if (path === '/api/session')
      result = { user, initialized: true, instanceId: 'test-family' };
    else if (path === '/api/state')
      result = {
        state,
        user,
        revision: state.revision,
        instanceGeneration: 'test-generation',
        storage: { connected: true, provider: 'rds' },
      };
    else if (path === '/api/sync/state')
      result = { publishedRevision: state.revision };
    else if (path === '/api/sessions') result = { sessions: [] };
    else if (path === '/api/family/rates') result = { rates: [] };
    else if (path === '/api/family/members')
      result = { members: [], invitations: [], invitationsEnabled: false };
    else if (path === '/api/edit-lease/acquire')
      result = { leaseId: 'test-ticket', fencingToken: 1 };
    else if (path === '/api/commands') {
      const envelope = route.request().postDataJSON();
      requests.push(envelope);
      if (behavior === 'conflict') {
        state = { ...state, revision: state.revision + 1 };
        return failure('REVISION_CONFLICT', 409);
      }
      if (behavior === 'pending') result = { status: 'PREPARING' };
      else {
        if (!receipts.has(envelope.operationId)) {
          try {
            state = applyCommands(state, envelope.commands, {
              actorUserId: user.id,
              operationId: envelope.operationId,
              now: TEST_DATE + 'T10:00:00Z',
            });
          } catch (error) {
            return route.fulfill({
              status: 400,
              json: {
                code: (error as any).code ?? 'VALIDATION_FAILED',
                message: (error as Error).message,
              },
            });
          }
          receipts.set(envelope.operationId, {
            status: 'COMMITTED',
            revision: state.revision,
          });
        }
        result = receipts.get(envelope.operationId);
        if (behavior === 'lost-response') {
          behavior = 'commit';
          return route.abort('failed');
        }
      }
    } else if (path.startsWith('/api/operations/'))
      result = receipts.get(
        decodeURIComponent(path.slice('/api/operations/'.length)),
      ) ?? { status: operationStatus };
    else if (path === '/api/auth/logout') {
      user = null;
      result = { ok: true };
    }
    await route.fulfill({ json: result });
  });
  return {
    read: () => state,
    requests,
    errors,
    setUser: (next: any) => {
      user = next;
    },
    revoke: () => {
      revoked = true;
      user = null;
    },
    revokeState: () => {
      stateRevoked = true;
    },
    commandBehavior: (next: typeof behavior) => {
      behavior = next;
    },
    operationStatus: (next: string) => {
      operationStatus = next;
    },
    async open() {
      await page.goto('/');
      await expect(
        page.getByRole('heading', { name: 'Всё под контролем.' }),
      ).toBeVisible();
    },
  };
}
export async function openPayment(page: Page, obligationId: string) {
  await page.getByRole('button', { name: 'Платежи', exact: true }).click();
  await page
    .getByRole('button', { name: 'Добавить платёж', exact: true })
    .first()
    .click();
  await page
    .getByRole('dialog')
    .getByLabel('Обязательство', { exact: true })
    .selectOption(obligationId);
}
export async function confirmPayment(page: Page) {
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Записать платёж', exact: true })
    .click();
}

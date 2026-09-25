import { test, expect, type Page } from '@playwright/test';
import {
  applyCommands,
  createDemoState,
  NOBODY_PERSON_ID,
  type Command,
} from '../src/domain';

/** Isolated UI fixture: production/development still require actual Google authentication. */
async function household(page: Page, role: 'admin' | 'observer' = 'admin') {
  const today = '2026-09-15';
  let state = createDemoState(today);
  state.household.name = 'Семья проверки интерфейса';
  state.household.color = '#667788';
  state.household.currencies = [state.household.currency, 'EUR'];
  state.people.forEach(
    (person, index) =>
      (person.color = ['#cc6677', '#4477aa', '#228833', '#aa3377'][index % 4]),
  );
  state.obligations.forEach((obligation, index) => {
    obligation.beneficiaries =
      index === 0
        ? { kind: 'people', personIds: [state.people[0].id] }
        : index === 2
          ? {
              kind: 'people',
              personIds: [state.people[0].id, state.people[1].id],
            }
          : { kind: 'household' };
    obligation.iconId = 'generic:house';
  });
  const user = {
    id: 'ui-admin',
    login: 'ui@example.com',
    name: 'Администратор',
    role,
  };
  const commands: Command[][] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: new Date(`${today}T10:00:00Z`) });
  await page.addInitScript(() => {
    sessionStorage.setItem(
      'brownie-cognito-id',
      `${btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${btoa(JSON.stringify({ sub: 'ui-google-subject', exp: 2000000000, token_use: 'id' }))}.explicit-test-only-signature`,
    );
    sessionStorage.setItem('brownie-app-session', 'ui-fixture-session');
    localStorage.setItem('domovoy-language', 'ru');
  });
  await page.route('**/runtime-config.json', (route) =>
    route.fulfill({ json: { apiBaseUrl: '/api', authMode: 'cognito' } }),
  );
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let result: unknown = {};
    if (path === '/api/session')
      result = { user, initialized: true, instanceId: 'ui-family' };
    else if (path === '/api/state')
      result = {
        state,
        user,
        revision: state.revision,
        instanceGeneration: 'ui-generation',
        storage: { connected: true, provider: 'rds' },
      };
    else if (path === '/api/sync/state')
      result = { publishedRevision: state.revision };
    else if (path === '/api/edit-lease/acquire')
      result = { leaseId: 'ui-lease', fencingToken: 1 };
    else if (path === '/api/commands') {
      const envelope = route.request().postDataJSON();
      commands.push(envelope.commands);
      try {
        state = applyCommands(state, envelope.commands, {
          actorUserId: user.id,
          operationId: envelope.operationId,
          now: `${today}T10:00:00Z`,
        });
        result = { status: 'COMMITTED', revision: state.revision };
      } catch (error) {
        return route.fulfill({
          status: 400,
          json: {
            code: (error as any).code ?? 'VALIDATION_FAILED',
            message: (error as Error).message,
          },
        });
      }
    } else if (path === '/api/sessions') result = { sessions: [] };
    else if (path === '/api/family/rates') result = { rates: [] };
    else if (path.includes('/members'))
      result = { members: [], invitations: [], invitationsEnabled: false };
    else if (path.includes('/invitations')) result = { invitations: [] };
    else if (path.includes('/delete/status'))
      result = { phase: 'NOT_SCHEDULED' };
    else if (path.includes('/backups/status'))
      result = { enabled: true, pending: false };
    await route.fulfill({ json: result });
  });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Всё под контролем.' }),
  ).toBeVisible();
  return { commands, errors, read: () => state };
}

test('dashboard has exclusive chart tabs and no demo or promotional blocks', async ({
  page,
}) => {
  const fixture = await household(page);
  await expect(page.getByRole('button', { name: /демо/i })).toHaveCount(0);
  await expect(
    page.getByText('Для дома. Для своих.', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText('У каждого своё место', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel('График обязательств', { exact: true }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Просрочки', exact: true }).click();
  await expect(
    page.getByLabel('График просрочек', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel('График обязательств', { exact: true }),
  ).toHaveCount(0);
});

test('beneficiary names use chart colours and household settings change the shared colour', async ({
  page,
}) => {
  const fixture = await household(page);
  const rows = page.locator('.expense-row'),
    single = rows
      .filter({ hasText: 'Аренда квартиры' })
      .locator('.obligation-beneficiary-name'),
    shared = rows
      .filter({ hasText: 'Netflix Premium' })
      .locator('.obligation-beneficiary-name'),
    multiple = rows
      .filter({ hasText: 'Spotify Family' })
      .locator('.obligation-beneficiary-name');
  await expect(single).toHaveText('Алексей');
  await expect(single).toHaveCSS('color', 'rgb(204, 102, 119)');
  await expect(single).toHaveCSS('font-weight', '700');
  await expect(single).toHaveCSS('display', 'inline');
  await expect(shared).toHaveText('Вся семья');
  await expect(shared).toHaveCSS('color', 'rgb(102, 119, 136)');
  await expect(shared).toHaveCSS('font-weight', '700');
  await expect(multiple).toHaveText('Алексей, Мария');
  await expect(multiple).toHaveCSS('color', 'rgb(102, 119, 136)');
  const sharedLegend = page
    .locator('.chart-legend span')
    .filter({ hasText: 'Семья / совместные' });
  await expect(sharedLegend.locator('i')).toHaveCSS(
    'background-color',
    'rgb(102, 119, 136)',
  );

  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByLabel('Выбрать цвет всей семьи', { exact: true }).click();
  await page.getByRole('button', { name: 'По умолчанию', exact: true }).click();
  const householdColour = page.getByLabel('Цвет всей семьи', { exact: true });
  await expect(householdColour).toHaveValue('#94a3b8');
  await householdColour.fill('#334455');
  await page
    .getByRole('button', { name: 'Сохранить настройки', exact: true })
    .click();
  await expect.poll(() => fixture.read().household.color).toBe('#334455');
  await page.getByRole('button', { name: 'Обзор', exact: true }).click();
  await expect(
    page
      .locator('.expense-row')
      .filter({ hasText: 'Netflix Premium' })
      .locator('.obligation-beneficiary-name'),
  ).toHaveCSS('color', 'rgb(51, 68, 85)');
  await expect(
    page
      .locator('.chart-legend span')
      .filter({ hasText: 'Семья / совместные' })
      .locator('i'),
  ).toHaveCSS('background-color', 'rgb(51, 68, 85)');
  expect(fixture.errors).toEqual([]);
});

test('obligation supports optional owner, individual beneficiaries, expiry and searchable icons', async ({
  page,
}) => {
  const fixture = await household(page);
  await page
    .getByRole('button', { name: 'Добавить обязательство', exact: true })
    .first()
    .click();
  const dialog = page.getByRole('dialog').first();
  await dialog
    .getByLabel('Название обязательства', { exact: true })
    .fill('Занятия ребёнка');
  await dialog.getByLabel('Вся семья', { exact: true }).uncheck();
  await dialog
    .getByLabel(fixture.read().people[0].displayName, { exact: true })
    .check();
  await dialog.getByLabel('Сумма начисления', { exact: true }).fill('100');
  await dialog.getByLabel('Повторение', { exact: true }).selectOption('weekly');
  await dialog
    .getByLabel('Ограничить срок обязательства', { exact: true })
    .check();
  await dialog
    .getByLabel('Последний день действия', { exact: true })
    .fill('2026-12-31');
  await dialog
    .getByRole('button', { name: 'Выбрать значок', exact: true })
    .click();
  const picker = page.getByRole('dialog').last();
  await picker.getByRole('searchbox').fill('планет');
  await picker
    .getByRole('button', { name: /планет/i })
    .last()
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await dialog
    .getByRole('button', { name: 'Создать обязательство', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const command = fixture.commands
    .flat()
    .find((command) => command.type === 'AddObligation');
  expect(command?.payload.obligation.ownerPersonId).toBe(NOBODY_PERSON_ID);
  expect(command?.payload.obligation.beneficiaries).toEqual({
    kind: 'people',
    personIds: [fixture.read().people[0].id],
  });
  expect(command?.payload.obligation.activeTo).toBe('2027-01-01');
  expect(command?.payload.rule.cadence).toBe('weekly');
});

test('payment starts with obligation and defaults amount and responsible payer; family groups collapse', async ({
  page,
}) => {
  const fixture = await household(page),
    obligation = fixture.read().obligations[0],
    rule = fixture
      .read()
      .rules.find((rule) => rule.obligationId === obligation.id)!;
  await page.getByRole('button', { name: 'Платежи', exact: true }).click();
  await page
    .getByRole('button', { name: 'Добавить платёж', exact: true })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByLabel('Сумма платежа', { exact: true }),
  ).toBeDisabled();
  await dialog
    .getByLabel('Обязательство', { exact: true })
    .selectOption(obligation.id);
  await expect(
    dialog.getByLabel('Сумма платежа', { exact: true }),
  ).not.toHaveValue('');
  await expect(dialog.getByLabel('Кто оплатил', { exact: true })).toHaveValue(
    obligation.ownerPersonId!,
  );
  await dialog.getByLabel('Дата оплаты', { exact: true }).fill('2026-09-02');
  await dialog
    .getByRole('button', { name: 'Записать платёж', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const payment = fixture.commands
    .flat()
    .find((command) => command.type === 'RecordPaymentAndAllocate');
  expect(payment?.payload.payment.paidAt).toBe('2026-09-02');
  expect(payment?.payload.payment.amount).toBe(rule.amount);
  await page
    .getByRole('button', { name: 'Семья и доступы', exact: true })
    .click();
  await expect(
    page.locator('.family-group-toggle[aria-expanded="true"]'),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Развернуть всё', exact: true })
    .click();
  await expect(
    page.locator('.family-group-toggle[aria-expanded="true"]'),
  ).toHaveCount(fixture.read().people.length * 2);
  await page.getByRole('button', { name: 'Свернуть всё', exact: true }).click();
  await expect(
    page.locator('.family-group-toggle[aria-expanded="true"]'),
  ).toHaveCount(0);
});

test('reports export CSV and settings warn before changing base currency', async ({
  page,
}) => {
  const fixture = await household(page);
  await page
    .getByRole('button', { name: 'Импорт/Экспорт', exact: true })
    .click();
  await page.getByLabel('Платежи', { exact: true }).uncheck();
  const downloaded = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Скачать отчёты', exact: true })
    .click();
  expect((await downloaded).suggestedFilename()).toContain(
    'domovoy-obligations',
  );
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Ваши данные', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', {
      name: 'Хранение и синхронизация',
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByLabel('Основная валюта', { exact: true }).selectOption('EUR');
  await expect(
    page.getByText(/Смена основной валюты пересчитает/),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Сохранить настройки', exact: true }),
  ).toBeDisabled();
  expect(fixture.errors).toEqual([]);
});

test('observer sees financial charts and reports but cannot create family people', async ({
  page,
}) => {
  await household(page, 'observer');
  await expect(
    page.getByLabel('График обязательств', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Добавить обязательство', exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Семья и доступы', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Добавить человека', exact: true }),
  ).toHaveCount(0);
});

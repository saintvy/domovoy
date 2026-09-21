import { test, expect } from '@playwright/test';
import {
  mockGoogleHousehold,
  openPayment,
  confirmPayment,
  TEST_USER,
} from './household-fixture';
test('CSV distinguishes definitive and possible duplicates and explicitly confirms import', async ({
  page,
}) => {
  const server = await mockGoogleHousehold(page);
  await server.open();
  await page
    .getByRole('button', { name: 'Импорт/Экспорт', exact: true })
    .click();
  await page
    .getByLabel(/^Данные CSV/)
    .fill(
      'date,amount,currency,description,reference\n2026-09-01,269,CZK,Spotify Family,\n2026-09-12,319,CZK,Netflix Premium,statement-001\n2026-09-12,319,CZK,Netflix Premium,statement-001',
    );
  await page
    .getByRole('button', { name: 'Проверить файл', exact: true })
    .click();
  await expect(page.getByText('Похожий платёж', { exact: true })).toBeVisible();
  await expect(page.getByText('Дубликат', { exact: true })).toBeVisible();
  const acceptance = page.getByRole('checkbox', {
    name: 'Это другой платёж',
    exact: true,
  });
  await acceptance.check();
  await expect(
    page.getByRole('button', { name: 'Подтвердить импорт (2)', exact: true }),
  ).toBeEnabled();
  await acceptance.uncheck();
  await page
    .getByRole('button', { name: 'Подтвердить импорт (1)', exact: true })
    .click();
  await expect.poll(() => server.requests.length).toBe(1);
  await expect(page.getByRole('status')).toContainText('подтверждены');
  expect(
    server
      .read()
      .payments.filter((payment) => payment.externalRef === 'statement-001'),
  ).toHaveLength(1);
});
test('offline edits remain local drafts and never become confirmed payments', async ({
  page,
  context,
}) => {
  const server = await mockGoogleHousehold(page);
  await server.open();
  const before = server.read().payments.length;
  await openPayment(page, server.read().obligations[0].id);
  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await confirmPayment(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /Несохранённые изменения/ }),
  ).toBeVisible();
  expect(server.requests).toHaveLength(0);
  expect(server.read().payments).toHaveLength(before);
  await context.setOffline(false);
});
test('drafts from another Google account are not exposed after account change', async ({
  page,
  context,
}) => {
  const server = await mockGoogleHousehold(page);
  await server.open();
  await openPayment(page, server.read().obligations[0].id);
  await context.setOffline(true);
  await confirmPayment(page);
  await expect(
    page.getByRole('button', { name: /Несохранённые изменения/ }),
  ).toBeVisible();
  await context.setOffline(false);
  server.setUser({
    ...TEST_USER,
    id: 'other-observer',
    role: 'observer',
    name: 'Другой человек',
  });
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Всё под контролем.' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Несохранённые изменения/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Добавить обязательство', exact: true }),
  ).toHaveCount(0);
});
test('revocation clears the visible ledger and authentication before another visit', async ({
  page,
}) => {
  const server = await mockGoogleHousehold(page);
  await server.open();
  server.revoke();
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'С возвращением', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Netflix Premium', { exact: true })).toHaveCount(
    0,
  );
  expect(
    await page.evaluate(() => sessionStorage.getItem('brownie-cognito-id')),
  ).toBeNull();
  await expect(
    page.getByRole('button', { name: /Открыть офлайн-копию|демо/i }),
  ).toHaveCount(0);
});
test('revocation between session and state cannot restore stale financial data', async ({
  page,
}) => {
  const server = await mockGoogleHousehold(page);
  await server.open();
  server.revokeState();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'С возвращением', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Netflix Premium', { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('button', { name: /Открыть офлайн-копию|демо/i }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => sessionStorage.getItem('brownie-app-session')),
  ).toBeNull();
});
test('lost command response retries the same operation without duplicating payment', async ({
  page,
}) => {
  const server = await mockGoogleHousehold(page);
  await server.open();
  server.commandBehavior('lost-response');
  // Simulate a missing receipt too: recovery must replay the identical envelope.
  await page.route('**/api/operations/**', (route) =>
    route.fulfill({
      status: 404,
      json: { code: 'OPERATION_NOT_FOUND', message: 'No receipt' },
    }),
  );
  const before = server.read().payments.length;
  await openPayment(page, server.read().obligations[0].id);
  await confirmPayment(page);
  await expect.poll(() => server.requests.length).toBeGreaterThanOrEqual(1);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Закрыть', exact: true })
    .click();
  await page.clock.fastForward(11000);
  await expect.poll(() => server.requests.length).toBe(2);
  await expect(
    page.getByRole('button', { name: /Несохранённые изменения/ }),
  ).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(server.requests).toHaveLength(2);
  expect(server.requests[0]).toEqual(server.requests[1]);
  expect(server.read().payments).toHaveLength(before + 1);
});
test('cancelled operations become reviewable drafts without automatic resubmission', async ({
  page,
}) => {
  const server = await mockGoogleHousehold(page);
  await server.open();
  server.commandBehavior('pending');
  server.operationStatus('CANCELLED');
  await openPayment(page, server.read().obligations[0].id);
  await confirmPayment(page);
  await page.getByRole('button', { name: /Несохранённые изменения/ }).click();
  await page.clock.fastForward(11000);
  await expect(
    page.getByRole('dialog').getByRole('button', {
      name: 'Проверено — отправить на сервер',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('dialog')
      .getByRole('button', { name: 'Повторить тот же запрос', exact: true }),
  ).toHaveCount(0);
  expect(server.requests).toHaveLength(1);
});
test('a validation rejection keeps the form open without a phantom pending operation', async ({
  page,
}) => {
  const server = await mockGoogleHousehold(page);
  await server.open();
  const before = server.read().payments.length;
  let polls = 0;
  await page.route('**/api/commands', (route) =>
    route.fulfill({
      status: 400,
      json: { code: 'INVALID_DATE_RANGE', message: 'Проверьте даты' },
    }),
  );
  await page.route('**/api/operations/**', (route) => {
    polls++;
    return route.fulfill({
      status: 404,
      json: { code: 'OPERATION_NOT_FOUND' },
    });
  });
  await openPayment(page, server.read().obligations[0].id);
  await confirmPayment(page);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Несохранённые изменения/ }),
  ).toHaveCount(0);
  await page.clock.fastForward(31000);
  expect(polls).toBe(0);
  expect(server.read().payments).toHaveLength(before);
});
test('a missing rejected operation becomes a reviewable draft and stops polling', async ({
  page,
}) => {
  const server = await mockGoogleHousehold(page);
  await server.open();
  server.commandBehavior('pending');
  server.operationStatus('PREPARING');
  await openPayment(page, server.read().obligations[0].id);
  await confirmPayment(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  let polls = 0,
    retries = 0;
  await page.route('**/api/operations/**', (route) => {
    polls++;
    return route.fulfill({
      status: 404,
      json: { code: 'OPERATION_NOT_FOUND' },
    });
  });
  await page.route('**/api/commands', (route) => {
    retries++;
    expect(route.request().postDataJSON()).toEqual(server.requests[0]);
    return route.fulfill({
      status: 400,
      json: { code: 'INVALID_DATE_RANGE', message: 'Проверьте даты' },
    });
  });
  await page.clock.fastForward(11000);
  await page.getByRole('button', { name: /Несохранённые изменения/ }).click();
  await expect(
    page.getByRole('button', {
      name: 'Проверено — отправить на сервер',
      exact: true,
    }),
  ).toBeVisible();
  await page.clock.fastForward(31000);
  expect(polls).toBe(1);
  expect(retries).toBe(1);
});
test('unauthenticated screens offer only Google sign-in and no stored family data', async ({
  page,
}) => {
  const server = await mockGoogleHousehold(page);
  server.setUser(null);
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Продолжить с Google', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /локальный тестовый|демо/i }),
  ).toHaveCount(0);
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  await expect(page.getByText('Netflix Premium', { exact: true })).toHaveCount(
    0,
  );
});

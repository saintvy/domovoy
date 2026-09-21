import { test, expect } from '@playwright/test';
import { mockGoogleHousehold, TEST_DATE } from './household-fixture';
import { applyCommands } from '../src/domain';

async function openNetflix(page: import('@playwright/test').Page) {
  await page
    .locator('.expense-row')
    .filter({ hasText: 'Netflix' })
    .first()
    .click();
}
test('dates can move the first charge earlier and preview the replacement schedule', async ({
  page,
}, testInfo) => {
  const server = await mockGoogleHousehold(page);
  const obligation = server
    .read()
    .obligations.find((o) => o.title.includes('Netflix'))!;
  await server.open();
  await openNetflix(page);
  await page
    .getByRole('button', { name: 'Даты и график', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('Начало обязательства', { exact: true })
    .fill('2026-08-01');
  await dialog
    .getByLabel('Первая дата оплаты по графику', { exact: true })
    .fill('2026-08-01');
  await dialog
    .getByRole('button', { name: 'Проверить изменения', exact: true })
    .click();
  await expect(
    dialog.getByLabel('Предварительный просмотр изменений', { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Подтвердить изменения', exact: true }),
  ).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('dates-preview.png') });
  await dialog
    .getByLabel('Я проверил изменения начислений и платежей', { exact: true })
    .check();
  await dialog
    .getByRole('button', { name: 'Подтвердить изменения', exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(
    server.read().obligations.find((o) => o.id === obligation.id)?.activeFrom,
  ).toBe('2026-08-01');
  expect(
    server
      .read()
      .periods.some(
        (p) => p.obligationId === obligation.id && p.dueDate === '2026-09-01',
      ),
  ).toBe(true);
  expect(server.errors).toEqual([]);
});

test('archive before the first charge explicitly offers payment policies and preserves credit', async ({
  page,
}, testInfo) => {
  const server = await mockGoogleHousehold(page),
    original = server.read(),
    obligation = original.obligations.find((o) => o.title.includes('Netflix'))!,
    period = original.periods.find((p) => p.obligationId === obligation.id)!;
  const paymentId = crypto.randomUUID();
  Object.assign(
    original,
    applyCommands(
      original,
      [
        {
          type: 'RecordPaymentAndAllocate',
          payload: {
            payment: {
              id: paymentId,
              paidAt: '2026-08-15',
              amount: 31900,
              currency: original.household.currency,
              payerPersonId: original.people[0].id,
              obligationId: obligation.id,
              source: 'manual',
            },
            allocations: [
              {
                id: crypto.randomUUID(),
                billingPeriodId: period.id,
                amount: 31900,
              },
            ],
          },
        },
      ],
      {
        actorUserId: 'test-admin',
        operationId: crypto.randomUUID(),
        now: TEST_DATE + 'T10:00:00Z',
      },
    ),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await server.open();
  await openNetflix(page);
  await page
    .getByRole('button', { name: 'Архивировать обязательство', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('Последний день действия', { exact: true })
    .fill('2026-08-01');
  await dialog
    .getByRole('button', { name: 'Проверить изменения', exact: true })
    .click();
  await expect(
    dialog.getByText(/Обязательство будет отменено до начала/),
  ).toBeVisible();
  await expect(
    dialog.getByRole('radio', { name: /Удалить эти платежи/ }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('radio', { name: /Сдвинуть даты внутрь срока/ }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Подтвердить изменения', exact: true }),
  ).toBeDisabled();
  await dialog.getByRole('radio', { name: /Оставить авансом/ }).check();
  await dialog
    .getByLabel('Я проверил изменения начислений и платежей', { exact: true })
    .check();
  await page.screenshot({
    path: testInfo.outputPath('archive-payment-policy-mobile.png'),
  });
  await dialog
    .getByRole('button', { name: 'Подтвердить изменения', exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(server.read().payments.some((p) => p.id === paymentId)).toBe(true);
  expect(
    server.read().periods.filter((p) => p.obligationId === obligation.id),
  ).toHaveLength(0);
  expect(server.errors).toEqual([]);
});

test('admin permanently deletes an obligation only after typing its name', async ({
  page,
}, testInfo) => {
  const server = await mockGoogleHousehold(page),
    obligation = server
      .read()
      .obligations.find((o) => o.title.includes('Netflix'))!;
  await server.open();
  await openNetflix(page);
  await page
    .getByRole('button', { name: 'Удалить обязательство целиком', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('button', { name: 'Удалить безвозвратно', exact: true }),
  ).toBeDisabled();
  await dialog
    .getByLabel('Для подтверждения введите название', { exact: true })
    .fill(obligation.title);
  await page.screenshot({ path: testInfo.outputPath('delete-obligation.png') });
  await dialog
    .getByRole('button', { name: 'Удалить безвозвратно', exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(server.read().obligations.some((o) => o.id === obligation.id)).toBe(
    false,
  );
  expect(
    server.read().periods.some((p) => p.obligationId === obligation.id),
  ).toBe(false);
  expect(server.errors).toEqual([]);
});

test('icon colour is independent and education category follows the interface language', async ({
  page,
}, testInfo) => {
  const server = await mockGoogleHousehold(page),
    obligation = server
      .read()
      .obligations.find((o) => o.title.includes('Netflix'))!;
  server
    .read()
    .providers.find((p) => p.id === obligation.providerId)!.category =
    'education';
  await server.open();
  await expect(
    page.locator('.expense-row').filter({ hasText: 'Netflix' }),
  ).toContainText('Образование');
  await openNetflix(page);
  await page
    .getByRole('button', { name: 'Изменить обязательство', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByLabel('Цвет значка', { exact: true })
    .fill('#bb2244');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Сохранить', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(
    server.read().obligations.find((o) => o.id === obligation.id)?.iconColor,
  ).toBe('#bb2244');
  await expect(
    page
      .locator('.expense-row')
      .filter({ hasText: 'Netflix' })
      .locator('.obligation-icon'),
  ).toHaveCSS('color', 'rgb(187, 34, 68)');
  await page.getByRole('button', { name: 'Сменить язык', exact: true }).click();
  await expect(
    page.locator('.expense-row').filter({ hasText: 'Netflix' }),
  ).toContainText('Education');
  await openNetflix(page);
  await expect(
    page.getByRole('dialog').getByText('Education', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('dialog').locator('.detail-title .obligation-icon'),
  ).toHaveCSS('color', 'rgb(187, 34, 68)');
  await page.screenshot({
    path: testInfo.outputPath('icon-colour-education-detail.png'),
  });
  expect(server.errors).toEqual([]);
});

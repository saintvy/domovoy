import { test, expect } from '@playwright/test';
import {
  mockGoogleHousehold,
  openPayment,
  confirmPayment,
} from './household-fixture';
import { getPeriodStatus, moneyInputValue } from '../src/domain';
test('server-confirmed allocation survives reload without a browser demo ledger', async ({
  page,
}) => {
  const server = await mockGoogleHousehold(page);
  await server.open();
  const obligation = server
    .read()
    .obligations.find((o) => o.title.includes('Netflix'))!;
  const arrears = server
    .read()
    .periods.filter(
      (period) =>
        period.obligationId === obligation.id && period.dueDate <= '2026-09-15',
    )
    .reduce(
      (total, period) =>
        total +
        (getPeriodStatus(server.read(), period, '2026-09-15').remaining ?? 0),
      0,
    );
  await openPayment(page, obligation.id);
  await page
    .getByRole('dialog')
    .getByLabel('Сумма платежа', { exact: true })
    .fill(moneyInputValue(arrears, server.read().household.currency));
  await confirmPayment(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Обзор', exact: true }).click();
  await expect(
    page.locator('.expense-row').filter({ hasText: 'Netflix' }),
  ).toContainText('Оплачено');
  await page.reload();
  await expect(
    page.locator('.expense-row').filter({ hasText: 'Netflix' }),
  ).toContainText('Оплачено');
  expect(
    server
      .read()
      .payments.some((payment) => payment.obligationId === obligation.id),
  ).toBe(true);
  expect(server.errors).toEqual([]);
});
test('admin creates a colour-coded person and inspects import and audit pages', async ({
  page,
}) => {
  const server = await mockGoogleHousehold(page);
  await server.open();
  await page
    .getByRole('button', { name: 'Семья и доступы', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Добавить человека', exact: true })
    .click();
  await page.getByLabel('Имя', { exact: true }).fill('Тестовый участник');
  await page.locator('input[type=color]').fill('#1255aa');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Сохранить', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: 'Изменить имя и цвет: Тестовый участник',
      exact: true,
    }),
  ).toBeVisible();
  expect(
    server
      .read()
      .people.find((person) => person.displayName === 'Тестовый участник')
      ?.color,
  ).toBe('#1255aa');
  await page
    .getByRole('button', { name: 'Импорт/Экспорт', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Экспорт за период', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'История', exact: true }).click();
  await expect(
    page
      .locator('.history-row')
      .filter({ hasText: 'test-adm' })
      .getByText('Добавлен член семьи', { exact: true }),
  ).toBeVisible();
  expect(server.errors).toEqual([]);
});
test('mobile navigation, modal focus and language switch remain usable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const server = await mockGoogleHousehold(page);
  await server.open();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole('button', { name: 'Добавить обязательство', exact: true })
    .first()
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(
    await page
      .getByRole('dialog')
      .evaluate((dialog) => dialog.contains(document.activeElement)),
  ).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Сменить язык', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Add obligation', exact: true }).first(),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(server.errors).toEqual([]);
});

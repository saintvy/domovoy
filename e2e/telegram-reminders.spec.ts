import { expect, test } from '@playwright/test';
import { mockGoogleHousehold, TEST_USER } from './household-fixture';

test('creates and edits obligation reminder settings and saves the household report hour', async ({
  page,
}) => {
  const fixture = await mockGoogleHousehold(page);
  await fixture.open();

  await page
    .getByRole('button', { name: 'Добавить обязательство', exact: true })
    .first()
    .click();
  const create = page.getByRole('dialog');
  await create
    .getByLabel('Название обязательства', { exact: true })
    .fill('Школьный обед');
  await create
    .getByLabel('Ответственный — необязательно', { exact: true })
    .selectOption(fixture.read().people[0].id);
  await create.getByLabel('Сумма начисления', { exact: true }).fill('125');
  await create
    .getByLabel('Начать за дней до оплаты', { exact: true })
    .fill('5');
  await create
    .getByLabel('Повторение напоминания', { exact: true })
    .selectOption('once');
  await create
    .getByRole('button', { name: 'Создать обязательство', exact: true })
    .click();
  await expect(create).toHaveCount(0);
  const added = fixture
    .read()
    .obligations.find((obligation) => obligation.title === 'Школьный обед');
  expect(added?.reminder).toEqual({
    enabled: true,
    daysBefore: 5,
    repeat: 'once',
  });

  await page
    .locator('.expense-row')
    .filter({ hasText: 'Школьный обед' })
    .first()
    .click();
  await page
    .getByRole('button', { name: 'Изменить обязательство', exact: true })
    .click();
  const edit = page.getByRole('dialog');
  await edit
    .getByLabel('Добавить напоминание в отчёт', { exact: true })
    .uncheck();
  await edit.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(edit).toHaveCount(0);
  expect(
    fixture.read().obligations.find((obligation) => obligation.id === added?.id)
      ?.reminder,
  ).toMatchObject({ enabled: false, daysBefore: 5, repeat: 'once' });

  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page
    .getByLabel('Местный час отправки', { exact: true })
    .selectOption('17');
  await page
    .getByLabel('Часовой пояс отчёта', { exact: true })
    .fill('America/Toronto');
  await page
    .getByRole('button', { name: 'Сохранить настройки', exact: true })
    .click();
  await expect
    .poll(() => fixture.read().household.telegramReportTime)
    .toEqual({ hour: 17, timeZone: 'America/Toronto' });
  expect(fixture.errors).toEqual([]);
});

test('links the current member and stores a per-member local report override', async ({
  page,
}) => {
  const fixture = await mockGoogleHousehold(page);
  const person = fixture.read().people[0];
  let member = {
    ...TEST_USER,
    email: 'parent@example.com',
    personId: person.id,
    telegram: { linked: false },
    telegramReportTime: null,
    nextReportAt: '2026-09-23T07:00:00.000Z',
  };
  let reminderPatch: unknown;
  await page.route('**/api/family/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/family/members')
      return route.fulfill({
        json: { members: [member], invitations: [], invitationsEnabled: true },
      });
    if (path.endsWith('/reminders')) {
      reminderPatch = route.request().postDataJSON();
      member = {
        ...member,
        ...(reminderPatch as object),
        nextReportAt: '2026-09-23T05:00:00.000Z',
      };
      return route.fulfill({ json: { ok: true } });
    }
    return route.fallback();
  });
  await page.route('**/api/telegram/link', async (route) => {
    if (route.request().method() === 'POST') {
      member = {
        ...member,
        telegram: { linked: true, username: 'domovoy_test' },
      };
      return route.fulfill({
        json: {
          url: 'https://t.me/domovoy_reminder_bot?start=opaque-token',
          expiresAt: '2026-09-22T21:00:00.000Z',
        },
      });
    }
    return route.fulfill({ json: { ok: true } });
  });

  await fixture.open();
  await page
    .getByRole('button', { name: 'Семья и доступы', exact: true })
    .click();
  const telegramDetails = page.locator('.family-telegram-details').first();
  await expect(telegramDetails).not.toHaveAttribute('open', '');
  await page.screenshot({
    path: 'test-results/telegram-reminder-family-collapsed.png',
    fullPage: true,
  });
  await telegramDetails.locator('summary').click();
  await expect(telegramDetails).toHaveAttribute('open', '');
  await page
    .getByRole('button', { name: 'Привязать Telegram', exact: true })
    .click();
  await expect(
    page.getByRole('link', { name: 'Открыть Telegram', exact: true }),
  ).toHaveAttribute(
    'href',
    'https://t.me/domovoy_reminder_bot?start=opaque-token',
  );
  await expect(page.getByText('@domovoy_test', { exact: true })).toBeVisible();

  await page.getByLabel('Использовать время семьи', { exact: true }).uncheck();
  const schedule = page.locator('.family-telegram-schedule');
  await schedule.locator('select').selectOption('6');
  await schedule.locator('.field input').fill('Europe/London');
  await page
    .getByRole('button', { name: 'Сохранить время отчёта', exact: true })
    .click();
  expect(reminderPatch).toEqual({
    telegramReportTime: { hour: 6, timeZone: 'Europe/London' },
  });
  await expect(page.getByText(/Следующий отчёт.*Europe\/London/)).toBeVisible();
  await page.screenshot({
    path: 'test-results/telegram-reminder-family-settings.png',
    fullPage: true,
  });
  expect(fixture.errors).toEqual([]);
});

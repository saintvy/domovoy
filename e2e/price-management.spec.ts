import { test, expect } from '@playwright/test';
import { mockGoogleHousehold, TEST_DATE, TEST_USER } from './household-fixture';
import { applyCommands, lockedBillingPeriodIds } from '../src/domain';

test('price change updates selected existing period and following unpaid charges, preserving history', async ({
  page,
}, testInfo) => {
  const server = await mockGoogleHousehold(page);
  const original = server.read(),
    obligation = original.obligations.find((o) => o.title.includes('Netflix'))!;
  const before = structuredClone(
    original.periods.filter((p) => p.obligationId === obligation.id),
  );
  const selected = before.find((p) => p.periodStart === '2026-09-12')!;
  const protectedPeriod = before.find((p) => p.periodStart === '2026-11-12')!;
  // Real ledger fixture: a later charge already has a payment; it must remain unchanged.
  const paid = applyCommands(
    original,
    [
      {
        type: 'RecordPaymentAndAllocate',
        payload: {
          payment: {
            id: crypto.randomUUID(),
            paidAt: TEST_DATE,
            amount: 31900,
            currency: original.household.currency,
            payerPersonId: original.people[0].id,
            source: 'manual',
          },
          allocations: [
            {
              id: crypto.randomUUID(),
              billingPeriodId: protectedPeriod.id,
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
  );
  Object.assign(original, paid);
  const preserved = structuredClone(
    server.read().periods.find((p) => p.id === protectedPeriod.id),
  );
  await server.open();
  await page
    .locator('.expense-row')
    .filter({ hasText: 'Netflix' })
    .first()
    .click();
  await page
    .getByRole('button', { name: 'Изменить стоимость', exact: true })
    .click();
  const dialog = page.getByRole('dialog'),
    selector = dialog.getByLabel('Начиная с начисления', { exact: true });
  await expect(selector).toHaveValue(selected.id);
  await expect(
    selector.locator(`option[value="${protectedPeriod.id}"]`),
  ).toHaveJSProperty('disabled', true);
  await dialog.getByLabel('Новая сумма', { exact: true }).fill('399');
  await dialog
    .getByRole('button', { name: 'Проверить изменение', exact: true })
    .click();
  await expect(
    dialog.getByLabel('Проверка изменения цены', { exact: true }),
  ).toContainText(
    'Начислений с защищённой историей останется без изменений: 1',
  );
  await dialog
    .getByRole('button', { name: 'Подтвердить изменение', exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  const updated = server.read();
  expect(
    updated.periods.find((p) => p.id === selected.id)?.expectedAmount,
  ).toBe(39900);
  expect(
    updated.periods.find(
      (p) => p.periodStart === '2026-10-12' && p.obligationId === obligation.id,
    )?.expectedAmount,
  ).toBe(39900);
  expect(updated.periods.find((p) => p.id === protectedPeriod.id)).toEqual(
    preserved,
  );
  expect(
    updated.periods.find((p) => p.id === before[0].id)?.expectedAmount,
  ).toBe(before[0].expectedAmount);
  expect(
    server.requests
      .flatMap((r) => r.commands)
      .find((c) => c.type === 'ChangeBillingRule').payload.fromPeriodId,
  ).toBe(selected.id);
  await page.reload();
  await page
    .locator('.expense-row')
    .filter({ hasText: 'Netflix' })
    .first()
    .click();
  await page
    .getByRole('button', { name: 'История стоимости', exact: true })
    .click();
  await expect(
    page
      .getByRole('dialog')
      .getByRole('heading', { name: 'История стоимости', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('img', { name: 'График стоимости CZK', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('table')).toContainText('399');
  const chart = await page
      .getByLabel('Графики стоимости', { exact: true })
      .boundingBox(),
    history = await page
      .getByRole('heading', { name: 'История изменений', exact: true })
      .boundingBox();
  expect(chart!.y + chart!.height).toBeLessThanOrEqual(history!.y);
  expect(lockedBillingPeriodIds(updated).has(protectedPeriod.id)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('price-history-desktop.png'),
  });
  expect(server.errors).toEqual([]);
});

test('price history separates currency scales and is readable by observers on mobile', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const server = await mockGoogleHousehold(page),
    state = server.read(),
    obligation = state.obligations.find((o) => o.title.includes('Netflix'))!;
  const rule = state.rules.find((r) => r.obligationId === obligation.id)!;
  rule.effectiveTo = '2026-12-12';
  state.rules.push({
    ...rule,
    id: crypto.randomUUID(),
    effectiveFrom: '2026-12-12',
    effectiveTo: undefined,
    amount: 1599,
    currency: 'EUR',
  });
  server.setUser({
    id: 'observer',
    login: 'observer@example.com',
    name: 'Наблюдатель',
    role: 'observer',
  });
  await server.open();
  await page
    .locator('.expense-row')
    .filter({ hasText: 'Netflix' })
    .first()
    .click();
  await expect(
    page.getByRole('button', { name: 'Изменить стоимость', exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'История стоимости', exact: true })
    .click();
  await expect(
    page.getByRole('img', { name: 'График стоимости CZK', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('img', { name: 'График стоимости EUR', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('table')).toContainText('15,99');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('price-history-mobile.png'),
  });
  await page.getByRole('table').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath('price-history-mobile-table.png'),
  });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(server.errors).toEqual([]);
});

test('administrator enables historical price editing and corrects the first price', async ({
  page,
}) => {
  const server = await mockGoogleHousehold(page);
  const original = server.read();
  const obligation = original.obligations.find((item) =>
    item.title.includes('Netflix'),
  )!;
  const first = original.rules.find(
    (rule) =>
      rule.obligationId === obligation.id &&
      rule.effectiveFrom === obligation.activeFrom,
  )!;
  const initialAmount = first.amount!;
  let permitted = false;
  const head = {
    ...TEST_USER,
    email: TEST_USER.login,
    personId: original.people[0].id,
    canEditHistoricalPrices: permitted,
  };
  server.setUser(head);
  await page.route('**/api/family/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/family/members')
      return route.fulfill({
        json: {
          members: [{ ...head, canEditHistoricalPrices: permitted }],
          invitations: [],
          invitationsEnabled: false,
        },
      });
    if (
      path === `/api/family/members/${head.id}/historical-prices` &&
      route.request().method() === 'PATCH'
    ) {
      permitted = route.request().postDataJSON().enabled;
      server.setUser({ ...head, canEditHistoricalPrices: permitted });
      return route.fulfill({
        json: { ok: true, canEditHistoricalPrices: permitted },
      });
    }
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
  });
  await server.open();
  await page
    .getByRole('button', { name: 'Семья и доступы', exact: true })
    .click();
  await page
    .locator('.family-directory-person')
    .first()
    .getByRole('button', { name: /^Изменить имя и цвет:/ })
    .click();
  const memberDialog = page.getByRole('dialog', { name: 'Участник семьи' });
  await memberDialog
    .getByRole('checkbox', { name: 'Разрешить правку истории стоимости' })
    .click();
  await expect.poll(() => permitted).toBe(true);
  await expect(
    memberDialog.getByRole('checkbox', {
      name: 'Разрешить правку истории стоимости',
    }),
  ).toBeChecked();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Обязательства/ }).click();
  await page
    .locator('.expense-row')
    .filter({ hasText: 'Netflix' })
    .first()
    .click();
  await page
    .getByRole('button', { name: 'История стоимости', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('row')
    .filter({ hasText: first.effectiveFrom })
    .getByRole('button', { name: 'Изменить', exact: true })
    .click();
  await dialog.getByLabel('Сумма', { exact: true }).fill('399');
  await dialog
    .getByRole('button', { name: 'Сохранить стоимость', exact: true })
    .click();
  await expect
    .poll(
      () =>
        server
          .read()
          .rules.find(
            (rule) =>
              rule.obligationId === obligation.id &&
              !rule.superseded &&
              rule.effectiveFrom === obligation.activeFrom,
          )?.amount,
    )
    .toBe(39900);
  expect(server.read().rules.find((rule) => rule.id === first.id)?.amount).toBe(
    initialAmount,
  );
  expect(
    server.requests
      .flatMap((request) => request.commands)
      .some((command) => command.type === 'EditHistoricalPrice'),
  ).toBe(true);
  expect(server.errors).toEqual([]);
});

test('price history opens for an obligation older than the 25-year forecast limit', async ({
  page,
}) => {
  const server = await mockGoogleHousehold(page);
  const state = server.read();
  state.household.allowHistoricalPriceEdits = true;
  const obligation = state.obligations.find((item) =>
    item.title.includes('Netflix'),
  )!;
  const rule = state.rules.find((item) => item.obligationId === obligation.id)!;
  obligation.activeFrom = '1995-09-12';
  rule.effectiveFrom = obligation.activeFrom;
  rule.anchor = obligation.activeFrom;
  await server.open();
  await page
    .locator('.expense-row')
    .filter({ hasText: 'Netflix' })
    .first()
    .click();
  await page
    .getByRole('button', { name: 'История стоимости', exact: true })
    .click();
  await expect(
    page
      .getByRole('dialog')
      .getByRole('heading', { name: 'История стоимости' }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('dialog')
      .getByRole('button', { name: 'Добавить стоимость' }),
  ).toHaveCount(0);
  expect(server.errors).toEqual([]);
});

test('price history controls add and remove an intermediate price entry', async ({
  page,
}) => {
  const server = await mockGoogleHousehold(page);
  const state = server.read();
  server.setUser({ ...TEST_USER, canEditHistoricalPrices: true });
  const obligation = state.obligations.find((item) =>
    item.title.includes('Netflix'),
  )!;
  const initialRule = state.rules.find(
    (rule) => rule.obligationId === obligation.id && !rule.superseded,
  )!;
  const date = state.periods
    .filter(
      (period) =>
        period.obligationId === obligation.id &&
        period.periodStart > initialRule.effectiveFrom,
    )
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart))[0].periodStart;
  await server.open();
  const openHistory = async () => {
    await page
      .locator('.expense-row')
      .filter({ hasText: 'Netflix' })
      .first()
      .click();
    await page
      .getByRole('button', { name: 'История стоимости', exact: true })
      .click();
  };
  await openHistory();
  let dialog = page.getByRole('dialog');
  await expect(
    dialog
      .getByRole('row')
      .filter({ hasText: initialRule.effectiveFrom })
      .getByRole('button', { name: 'Удалить', exact: true }),
  ).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Добавить стоимость' }).click();
  await dialog.getByLabel('Дата начала').selectOption(date);
  await dialog.getByLabel('Сумма', { exact: true }).fill('499');
  await dialog.getByRole('button', { name: 'Сохранить стоимость' }).click();
  await expect
    .poll(
      () =>
        server
          .read()
          .rules.find(
            (rule) =>
              !rule.superseded &&
              rule.obligationId === obligation.id &&
              rule.effectiveFrom === date,
          )?.amount,
    )
    .toBe(49900);
  await openHistory();
  dialog = page.getByRole('dialog');
  page.once('dialog', (confirmation) => void confirmation.accept());
  await dialog
    .getByRole('row')
    .filter({ hasText: date })
    .getByRole('button', { name: 'Удалить', exact: true })
    .click();
  await expect
    .poll(() =>
      server
        .read()
        .rules.some(
          (rule) =>
            !rule.superseded &&
            rule.obligationId === obligation.id &&
            rule.effectiveFrom === date,
        ),
    )
    .toBe(false);
  expect(
    server
      .read()
      .rules.some(
        (rule) =>
          !rule.superseded &&
          rule.obligationId === obligation.id &&
          rule.effectiveFrom === initialRule.effectiveFrom,
      ),
  ).toBe(true);
  expect(server.errors).toEqual([]);
});

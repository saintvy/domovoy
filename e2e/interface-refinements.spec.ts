import { test, expect } from '@playwright/test';
import { mockGoogleHousehold } from './household-fixture';
import { applyCommands, stableId } from '../src/domain';

test('weekly charges are grouped into one monthly obligation with aggregate amount and status', async ({
  page,
}) => {
  const server = await mockGoogleHousehold(page),
    state = server.read(),
    owner = state.people[0];
  const obligationId = stableId('weekly-school'),
    providerId = stableId('weekly-school-provider');
  Object.assign(
    state,
    applyCommands(
      state,
      [
        {
          type: 'AddObligation',
          payload: {
            provider: {
              id: providerId,
              name: 'School is fun',
              category: 'education',
            },
            obligation: {
              id: obligationId,
              title: 'School is fun',
              providerId,
              coverageMode: 'single_account',
              ownerPersonId: owner.id,
              activeFrom: '2026-09-07',
              lifecycleState: 'active',
            },
            rule: {
              id: stableId('weekly-school-rule'),
              obligationId,
              anchor: '2026-09-07',
              effectiveFrom: '2026-09-07',
              cadence: 'weekly',
              dueOffsetDays: 0,
              amountMode: 'fixed',
              amount: 18000,
              currency: state.household.currency,
              reminderDays: 1,
              graceDays: 0,
            },
          },
        },
        {
          type: 'GeneratePeriods',
          payload: { from: '2026-09-01', to: '2026-10-01' },
        },
      ],
      {
        actorUserId: 'test-admin',
        operationId: 'weekly-school-setup',
        now: '2026-09-15T10:00:00Z',
      },
    ),
  );
  const charges = state.periods
    .filter((period) => period.obligationId === obligationId)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  for (const [index, period] of charges.slice(0, 2).entries()) {
    const paymentId = stableId('weekly-school-payment-' + index);
    state.payments.push({
      id: paymentId,
      obligationId,
      payerPersonId: owner.id,
      paidAt: period.dueDate,
      amount: 18000,
      currency: state.household.currency,
      source: 'manual',
    });
    state.allocations.push({
      id: stableId('weekly-school-allocation-' + index),
      paymentId,
      billingPeriodId: period.id,
      amount: 18000,
      createdAt: period.dueDate + 'T10:00:00Z',
    });
  }
  await server.open();
  const row = page.locator('.expense-row').filter({ hasText: 'School is fun' });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.amount-cell')).toHaveText(
    /360,00\s*CZK\s*\/\s*720,00\s*CZK/,
  );
  await expect(row.locator('.status-cell')).toHaveText('К оплате');
  await expect(row.locator('.due-cell')).toContainText('7 сент. – 28 сент.');
  await row.click();
  await expect(
    page.getByRole('dialog').locator('.detail-amount'),
  ).toContainText(/360,00\s*CZK\s*\/\s*720,00\s*CZK/);
  expect(server.errors).toEqual([]);
});

test('advance electricity payment and upcoming rent appear under the correct family relationships', async ({
  page,
}) => {
  const server = await mockGoogleHousehold(page),
    state = server.read(),
    owner = state.people[0];
  for (const obligation of state.obligations)
    obligation.title = 'Демонстрация: ' + obligation.title;
  const context = {
    operationId: 'family-advance-regression',
    actorUserId: 'test-admin',
    now: '2026-09-19T10:00:00Z',
  };
  for (const [key, title, date, amount] of [
    ['electricity', 'Электроэнергия', '2026-09-24', 167000],
    ['rent', 'Аренда квартиры', '2026-09-25', 2850000],
  ] as const) {
    const id = stableId(key),
      providerId = stableId(key + '-provider');
    Object.assign(
      state,
      applyCommands(
        state,
        [
          {
            type: 'AddObligation',
            payload: {
              provider: { id: providerId, name: title, category: 'utilities' },
              obligation: {
                id,
                title,
                providerId,
                coverageMode: 'household',
                beneficiaries: { kind: 'household' },
                ownerPersonId: owner.id,
                activeFrom: date,
                lifecycleState: 'active',
              },
              rule: {
                id: stableId(key + '-rule'),
                obligationId: id,
                anchor: date,
                effectiveFrom: date,
                cadence: 'monthly',
                dueOffsetDays: 0,
                amountMode: 'fixed',
                amount,
                currency: state.household.currency,
                reminderDays: 3,
                graceDays: 0,
              },
            },
          },
        ],
        { ...context, operationId: context.operationId + key },
      ),
    );
  }
  Object.assign(
    state,
    applyCommands(
      state,
      [
        {
          type: 'GeneratePeriods',
          payload: { from: '2026-09-01', to: '2026-10-01' },
        },
        {
          type: 'RecordPaymentAndAllocate',
          payload: {
            payment: {
              id: stableId('electricity-advance'),
              obligationId: stableId('electricity'),
              payerPersonId: owner.id,
              paidAt: '2026-09-18',
              amount: 167000,
              currency: state.household.currency,
              source: 'manual',
            },
            allocations: [],
          },
        },
      ],
      context,
    ),
  );
  const original = structuredClone(state);
  await page.clock.setFixedTime(new Date('2026-09-19T10:00:00Z'));
  await server.open();
  await page
    .getByRole('button', { name: 'Семья и доступы', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Развернуть всё', exact: true })
    .click();
  const cards = page.locator('.family-directory-person');
  const ownerCard = cards.filter({
    has: page.getByRole('button', {
      name: 'Изменить имя и цвет: ' + owner.displayName,
      exact: true,
    }),
  });
  await expect(
    ownerCard.getByRole('button', { name: 'Электроэнергия', exact: true }),
  ).toHaveCount(2);
  await expect(
    ownerCard.getByRole('button', { name: 'Аренда квартиры', exact: true }),
  ).toHaveCount(1);
  // Whole-family prepayment covers each beneficiary, but only one assigned owner.
  await expect(
    cards.getByRole('button', { name: 'Электроэнергия', exact: true }),
  ).toHaveCount(state.people.length + 1);
  await expect(
    cards.getByRole('button', { name: 'Аренда квартиры', exact: true }),
  ).toHaveCount(1);
  await page.clock.setFixedTime(new Date('2026-09-25T10:00:00Z'));
  await page.reload();
  await page
    .getByRole('button', { name: 'Семья и доступы', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Развернуть всё', exact: true })
    .click();
  await expect(
    cards.getByRole('button', { name: 'Аренда квартиры', exact: true }),
  ).toHaveCount(state.people.length + 1);
  expect(state).toEqual(original);
  expect(server.errors).toEqual([]);
});

test('monthly summary cards navigate to the requested obligation filters', async ({
  page,
}) => {
  const server = await mockGoogleHousehold(page);
  await server.open();
  for (const [card, filter] of [
    ['План на месяц', 'Все'],
    ['Уже оплачено', 'Оплачено'],
    ['Осталось оплатить', 'К оплате'],
    ['Требует внимания', 'К оплате'],
  ]) {
    await page.locator('.summary-card').filter({ hasText: card }).click();
    await expect(page.locator('.nav-item.active')).toContainText(
      'Обязательства',
    );
    await expect(page.locator('.tabs button.selected')).toHaveText(filter);
    await page.getByRole('button', { name: 'Обзор', exact: true }).click();
  }
  expect(server.errors).toEqual([]);
});

test('editing an obligation with an end date changes its icon and category without altering dates', async ({
  page,
}) => {
  const server = await mockGoogleHousehold(page);
  const obligation = server
    .read()
    .obligations.find((o) => o.title.includes('Netflix'))!;
  obligation.activeTo = '2027-01-01';
  const from = obligation.activeFrom,
    provider = structuredClone(
      server.read().providers.find((p) => p.id === obligation.providerId),
    );
  await server.open();
  await page
    .locator('.expense-row')
    .filter({ hasText: 'Netflix' })
    .first()
    .click();
  await page
    .getByRole('button', { name: 'Изменить обязательство', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('button', { name: 'Выбрать значок', exact: true })
    .locator('svg')
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Значок обязательства' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await dialog.getByLabel('Цвет значка', { exact: true }).fill('#bb2244');
  await dialog
    .getByLabel('Категория', { exact: true })
    .selectOption('education');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(
    server.read().obligations.find((o) => o.id === obligation.id),
  ).toMatchObject({
    activeFrom: from,
    activeTo: '2027-01-01',
    iconColor: '#bb2244',
    category: 'education',
  });
  expect(
    server.read().providers.find((p) => p.id === obligation.providerId),
  ).toEqual(provider);
  await expect(
    page.locator('.expense-row').filter({ hasText: 'Netflix' }),
  ).toContainText('Образование');
  expect(server.errors).toEqual([]);
});

test('chart stack order is determined across the whole window, not separately by month', async ({
  page,
}) => {
  const server = await mockGoogleHousehold(page),
    state = server.read();
  const [a, b] = state.obligations,
    [alice, bob] = state.people;
  a.beneficiaries = { kind: 'people', personIds: [alice.id] };
  b.beneficiaries = { kind: 'people', personIds: [bob.id] };
  const templates = [a, b].map((o) =>
    state.periods.find((p) => p.obligationId === o.id)!,
  );
  state.periods = [
    {
      ...templates[0],
      id: 'chart-a-jan',
      dueDate: '2026-01-01',
      expectedAmount: 10000,
      baseExpectedAmount: 10000,
    },
    {
      ...templates[1],
      id: 'chart-b-jan',
      dueDate: '2026-01-01',
      expectedAmount: 1000,
      baseExpectedAmount: 1000,
    },
    {
      ...templates[0],
      id: 'chart-a-feb',
      dueDate: '2026-02-01',
      expectedAmount: 100,
      baseExpectedAmount: 100,
    },
    {
      ...templates[1],
      id: 'chart-b-feb',
      dueDate: '2026-02-01',
      expectedAmount: 20000,
      baseExpectedAmount: 20000,
    },
  ];
  state.allocations = [];
  state.payments = [];
  state.refunds = [];
  await server.open();
  const jan = page.locator('.chart-month').nth(3),
    feb = page.locator('.chart-month').nth(4);
  for (const column of [jan, feb]) {
    await expect(column.locator('.chart-stack')).toHaveCSS(
      'flex-direction',
      'column-reverse',
    );
    await expect(column.locator('.chart-stack > div').nth(0)).toHaveAttribute(
      'title',
      new RegExp('^' + bob.displayName),
    );
    await expect(column.locator('.chart-stack > div').nth(1)).toHaveAttribute(
      'title',
      new RegExp('^' + alice.displayName),
    );
  }
  await expect(page.locator('.chart-legend > span').first()).toHaveText(
    bob.displayName,
  );
  expect(server.errors).toEqual([]);
});

test('dark green theme persists and English changes the brand; dialogs and mobile remain usable', async ({
  page,
}, testInfo) => {
  const server = await mockGoogleHousehold(page);
  const state = server.read();
  state.household.name = 'The Novak household';
  server.setUser({
    id: 'test-admin',
    login: 'parent@example.com',
    name: 'Alex Novak',
    role: 'admin',
  });
  state.people.forEach((person, index) => {
    person.displayName = ['Alex', 'Maria', 'Sonia', 'Max'][index];
  });
  const titles = [
    'Rent',
    'Netflix Premium',
    'Spotify Family',
    'Home internet',
    'Electricity',
    'iCloud+ 200 GB',
  ];
  state.obligations.forEach((obligation, index) => {
    obligation.title = titles[index];
  });
  await server.open();
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('radio', { name: 'Тёмная', exact: true }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('body')).toHaveCSS(
    'background-color',
    'rgb(16, 35, 27)',
  );
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(
    page.getByRole('heading', { name: 'Всё под контролем.' }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('dark-overview.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Сменить язык', exact: true }).click();
  await expect(page.locator('.sidebar .brand')).toHaveText('Domovoy.');
  await page.screenshot({
    path: testInfo.outputPath('overview-english.png'),
    fullPage: false,
    animations: 'disabled',
  });
  await page.locator('.expense-row').first().click();
  await expect(page.getByRole('dialog')).toHaveCSS(
    'background-color',
    'rgb(24, 49, 39)',
  );
  await page.screenshot({ path: testInfo.outputPath('dark-dialog.png') });
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByRole('radio', { name: 'Dark', exact: true }),
  ).toBeChecked();
  await page.screenshot({
    path: testInfo.outputPath('dark-settings-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('radio', { name: 'Light', exact: true }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(server.errors).toEqual([]);
});

test('family cards wrap at equal natural widths and show paid archived services for beneficiary and owner', async ({
  page,
}, testInfo) => {
  const server = await mockGoogleHousehold(page),
    state = server.read();
  const service = state.obligations.find((o) => o.title.includes('Spotify'))!,
    person = state.people[0];
  service.lifecycleState = 'archived';
  service.activeTo = '2026-09-16';
  service.beneficiaries = { kind: 'people', personIds: [person.id] };
  service.ownerPersonId = person.id;
  const payment = state.payments.find((p) =>
    state.allocations.some(
      (a) =>
        a.paymentId === p.id &&
        state.periods.some(
          (period) =>
            period.id === a.billingPeriodId &&
            period.obligationId === service.id,
        ),
    ),
  )!;
  payment.obligationId = service.id;
  payment.paidAt = '2026-09-15';
  await page.setViewportSize({ width: 1920, height: 1080 });
  await server.open();
  await page
    .getByRole('button', { name: 'Семья и доступы', exact: true })
    .click();
  const cards = page.locator('.family-directory-person');
  await expect(cards).toHaveCount(state.people.length);
  await expect
    .poll(async () => {
      const boxes = await cards.evaluateAll((nodes) =>
        nodes.map((n) => {
          const r = n.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width };
        }),
      );
      return (
        boxes[0].y === boxes[1].y &&
        boxes[1].x > boxes[0].x &&
        boxes.every((b) => Math.abs(b.width - boxes[0].width) < 1)
      );
    })
    .toBe(true);
  const row = cards.filter({
    has: page.getByRole('button', {
      name: 'Изменить имя и цвет: ' + person.displayName,
      exact: true,
    }),
  });
  await expect
    .poll(async () =>
      row.evaluate((node) => {
        const name = node
          .querySelector('.family-person-name')!
          .getBoundingClientRect();
        const email = node
          .querySelector('.family-person-email')!
          .getBoundingClientRect();
        return (
          Math.abs(name.y + name.height / 2 - email.y - email.height / 2) < 1
        );
      }),
    )
    .toBe(true);
  await row.getByRole('button', { name: /^Пользуется/ }).click();
  await row.getByRole('button', { name: /^Отвечает/ }).click();
  await expect(
    row.getByRole('button', { name: service.title, exact: true }),
  ).toHaveCount(2);
  await expect(
    row.locator('.family-group-toggle[aria-expanded="true"] svg'),
  ).toHaveCount(2);
  await row
    .getByRole('button', { name: service.title, exact: true })
    .first()
    .click();
  await expect(page.getByRole('dialog')).toContainText(service.title);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Закрыть', exact: true })
    .click();
  await page.screenshot({
    path: testInfo.outputPath('family-cards-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath('family-cards-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.clock.setFixedTime(new Date('2026-10-15T10:00:00Z'));
  await page.reload();
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page
    .getByRole('button', { name: 'Семья и доступы', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Развернуть всё', exact: true })
    .click();
  await expect(
    cards.getByRole('button', { name: service.title, exact: true }),
  ).toHaveCount(0);
  expect(server.errors).toEqual([]);
});

test('automatic payment heading keeps its description beside the action and separates the first row', async ({
  page,
}, testInfo) => {
  const server = await mockGoogleHousehold(page),
    state = server.read();
  state.automaticPayments = [
    {
      id: 'automatic-layout-check',
      obligationId: state.obligations[0].id,
      payerPersonId: state.people[0].id,
      startDate: '2026-09-01',
      enabled: true,
    },
  ];
  await server.open();
  await page.getByRole('button', { name: 'Платежи', exact: true }).click();
  await page.getByRole('tab', { name: 'Автоплатежи', exact: true }).click();
  const heading = page.locator('.automatic-payments-heading');
  await expect(heading.locator('h2 + p')).toContainText(
    'Приложение не списывает',
  );
  await expect(heading).toHaveCSS('border-bottom-style', 'solid');
  await expect(
    heading.getByRole('button', { name: 'Добавить автоплатёж' }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('automatic-payments.png'),
    fullPage: true,
    animations: 'disabled',
  });
  expect(server.errors).toEqual([]);
});

import { test, expect, type Page } from '@playwright/test';
import { NOBODY_PERSON_ID, stableId } from '../src/domain';
import { mockGoogleHousehold, TEST_USER } from './household-fixture';

async function setup(page: Page, withProtectedFuture = false) {
  const fixture = await mockGoogleHousehold(page);
  const person = fixture.read().people[1];
  const obligation = fixture.read().obligations[1];
  obligation.beneficiaries = { kind: 'people', personIds: [person.id] };
  person.color = '#cc5577';
  if (withProtectedFuture) {
    const period = fixture
      .read()
      .periods.find(
        (value) =>
          value.obligationId === obligation.id &&
          value.dueDate === '2026-10-12',
      )!;
    period.waiver = {
      reason: 'Test waiver',
      actorUserId: TEST_USER.id,
      createdAt: '2026-09-15T08:00:00Z',
    };
    fixture.read().automaticPayments!.push({
      id: stableId('lifecycle-ui-schedule'),
      obligationId: obligation.id,
      payerPersonId: person.id,
      startDate: '2026-08-12',
      enabled: true,
    });
  }
  await page.route('**/api/family/members', (route) =>
    route.fulfill({
      json: {
        members: [
          {
            ...TEST_USER,
            personId: fixture.read().people[0].id,
            email: TEST_USER.login,
          },
        ],
        invitations: [],
        invitationsEnabled: false,
      },
    }),
  );
  await fixture.open();
  await page
    .getByRole('button', { name: 'Семья и доступы', exact: true })
    .click();
  return { fixture, person, obligation };
}
async function openRemoval(page: Page, name: string) {
  await page
    .getByRole('button', { name: 'Изменить имя и цвет: ' + name })
    .click();
  await page
    .getByRole('button', { name: 'Удалить или архивировать участника' })
    .click();
  return page.getByRole('dialog', { name: 'Управление участником: ' + name });
}

for (const restore of [true, false])
  test(`archive retains history and restores with beneficiary choice ${restore}`, async ({
    page,
  }) => {
    const { fixture, person, obligation } = await setup(page);
    let dialog = await openRemoval(page, person.displayName);
    await expect(dialog).toContainText(obligation.title);
    await dialog
      .getByRole('button', { name: 'Поместить в архив', exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    expect(
      fixture.read().people.find((p) => p.id === person.id)?.archivedAt,
    ).toBeTruthy();
    expect(
      fixture.read().obligations.find((o) => o.id === obligation.id)
        ?.beneficiaries,
    ).toEqual({ kind: 'people', personIds: [NOBODY_PERSON_ID] });
    expect(
      fixture.read().obligations.find((o) => o.id === obligation.id)
        ?.attributionHistory?.[0].beneficiaries,
    ).toEqual({ kind: 'people', personIds: [person.id] });
    await page.getByRole('button', { name: /Архив участников/ }).click();
    await page
      .getByRole('button', { name: 'Восстановить или удалить' })
      .click();
    dialog = page.getByRole('dialog', {
      name: 'Управление участником: ' + person.displayName,
    });
    if (restore)
      await dialog.getByLabel('Вернуть бенефициара вместо «Никто»').check();
    await dialog
      .getByRole('button', { name: 'Вернуть из архива', exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    expect(
      fixture.read().people.find((p) => p.id === person.id)?.archivedAt,
    ).toBeUndefined();
    expect(
      fixture.read().obligations.find((o) => o.id === obligation.id)
        ?.beneficiaries,
    ).toEqual({
      kind: 'people',
      personIds: [restore ? person.id : NOBODY_PERSON_ID],
    });
    expect(fixture.errors).toEqual([]);
  });

test('archive can stop charges and permanently delete the archived person', async ({
  page,
}) => {
  const { fixture, person, obligation } = await setup(page, true);
  let dialog = await openRemoval(page, person.displayName);
  await dialog
    .getByLabel('Обязательства, где участник — единственный бенефициар')
    .selectOption('end_at_last_accrual');
  await expect(dialog).toContainText('2026-10-12');
  await expect(
    dialog.getByRole('listitem').filter({ hasText: /^2026-10-12 ·/ }),
  ).toContainText('списан');
  await expect(dialog).toContainText('Будут отключены автоплатежи');
  await expect(dialog).toContainText('2026-08-12 (Мария)');
  await dialog
    .getByRole('button', { name: 'Поместить в архив', exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(
    fixture.read().obligations.find((o) => o.id === obligation.id)
      ?.lifecycleState,
  ).toBe('archived');
  expect(
    fixture
      .read()
      .periods.some(
        (p) => p.obligationId === obligation.id && p.dueDate === '2026-10-12',
      ),
  ).toBe(true);
  expect(
    fixture
      .read()
      .automaticPayments!.find(
        (s) => s.id === stableId('lifecycle-ui-schedule'),
      )?.enabled,
  ).toBe(false);
  await page.getByRole('button', { name: /Архив участников/ }).click();
  await page.getByRole('button', { name: 'Восстановить или удалить' }).click();
  dialog = page.getByRole('dialog', {
    name: 'Управление участником: ' + person.displayName,
  });
  await dialog.getByLabel('Действие', { exact: true }).selectOption('delete');
  await expect(dialog).toContainText('без возможности восстановления');
  await dialog
    .getByRole('button', { name: 'Удалить полностью', exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.read().people.some((p) => p.id === person.id)).toBe(false);
  expect(
    fixture.read().obligations.find((o) => o.id === obligation.id)
      ?.attributionHistory?.[0].beneficiaries,
  ).toEqual({ kind: 'people', personIds: [NOBODY_PERSON_ID] });
  expect(fixture.errors).toEqual([]);
});

test('removal conflict keeps the dialog and draft; the head has no removal control', async ({
  page,
}) => {
  const { fixture, person } = await setup(page);
  await page
    .getByRole('button', {
      name: 'Изменить имя и цвет: ' + fixture.read().people[0].displayName,
    })
    .click();
  await expect(
    page.getByRole('button', { name: 'Удалить или архивировать участника' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  const dialog = await openRemoval(page, person.displayName);
  fixture.commandBehavior('conflict');
  await dialog.getByLabel('Действие', { exact: true }).selectOption('delete');
  await dialog
    .getByRole('button', { name: 'Удалить полностью', exact: true })
    .click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  expect(fixture.read().people.some((p) => p.id === person.id)).toBe(true);
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('Nobody is selectable through empty beneficiaries and its colour is configurable', async ({
  page,
}) => {
  const { fixture } = await setup(page);
  await page.getByRole('button', { name: /^Обязательства/ }).click();
  await page
    .getByRole('button', { name: 'Добавить обязательство', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Название обязательства').fill('Без бенефициара');
  await dialog.getByLabel('Вся семья', { exact: true }).uncheck();
  await expect(dialog).toContainText('бенефициар «Никто»');
  await dialog.getByLabel('Сумма начисления', { exact: true }).fill('10');
  await dialog
    .getByRole('button', { name: 'Создать обязательство', exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  const obligation = fixture
    .read()
    .obligations.find((o) => o.title === 'Без бенефициара');
  expect(obligation?.ownerPersonId).toBe(NOBODY_PERSON_ID);
  expect(obligation?.beneficiaries).toEqual({
    kind: 'people',
    personIds: [NOBODY_PERSON_ID],
  });
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByLabel('Цвет «Никто»', { exact: true }).fill('#123456');
  await page
    .getByRole('button', { name: 'Сохранить настройки', exact: true })
    .click();
  await expect.poll(() => fixture.read().household.nobodyColor).toBe('#123456');
  expect(fixture.errors).toEqual([]);
});

test('unrelated edits preserve restoration links while explicit beneficiary edits clear them', async ({
  page,
}) => {
  const { fixture, person, obligation } = await setup(page);
  const removal = await openRemoval(page, person.displayName);
  await removal
    .getByRole('button', { name: 'Поместить в архив', exact: true })
    .click();
  await expect(removal).toHaveCount(0);
  await page.getByRole('button', { name: 'Обзор', exact: true }).click();
  await page
    .locator('.expense-row')
    .filter({ hasText: obligation.title })
    .first()
    .click();
  await page
    .getByRole('button', { name: 'Изменить обязательство', exact: true })
    .click();
  let editor = page.getByRole('dialog');
  await editor.getByLabel('Название обязательства').fill('Renamed Netflix');
  await editor.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(
    fixture.read().obligations.find((o) => o.id === obligation.id)
      ?.beneficiaryArchive?.personIds,
  ).toContain(person.id);
  await page
    .locator('.expense-row')
    .filter({ hasText: 'Renamed Netflix' })
    .first()
    .click();
  await page
    .getByRole('button', { name: 'Изменить обязательство', exact: true })
    .click();
  editor = page.getByRole('dialog');
  await expect(
    editor.getByRole('checkbox', { name: person.displayName, exact: true }),
  ).toHaveCount(0);
  await editor
    .getByRole('checkbox', {
      name: fixture.read().people[0].displayName,
      exact: true,
    })
    .check();
  await editor.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(
    fixture.read().obligations.find((o) => o.id === obligation.id)
      ?.beneficiaryArchive,
  ).toBeUndefined();
  expect(fixture.errors).toEqual([]);
});

test('an offline lifecycle draft requires a fresh family confirmation instead of rebasing', async ({
  page,
  context,
}) => {
  const { fixture, person } = await setup(page);
  const dialog = await openRemoval(page, person.displayName);
  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await dialog
    .getByRole('button', { name: 'Поместить в архив', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: /Несохранённые изменения/ }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  fixture.read().revision++;
  await context.setOffline(false);
  await page.getByRole('button', { name: /Несохранённые изменения/ }).click();
  await expect(page.getByRole('dialog')).toContainText(
    'подтвердите актуальные последствия заново',
  );
  await expect(
    page.getByRole('button', { name: 'Проверено — отправить на сервер' }),
  ).toHaveCount(0);
  expect(fixture.requests).toHaveLength(0);
  expect(
    fixture.read().people.find((p) => p.id === person.id)?.archivedAt,
  ).toBeUndefined();
});

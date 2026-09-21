import { test, expect } from '@playwright/test';
import { mockGoogleHousehold, TEST_USER } from './household-fixture';

test('one person popup edits name/colour and invitation; pending email has no admin option', async ({
  page,
}) => {
  const fixture = await mockGoogleHousehold(page),
    people = fixture.read().people;
  const parent = {
    ...TEST_USER,
    email: 'parent@example.com',
    personId: people[0].id,
  };
  const members: any[] = [parent];
  const invitations: any[] = [];
  await page.route('**/api/family/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/family/members')
      return route.fulfill({
        json: { members, invitations, invitationsEnabled: true },
      });
    if (path === '/api/family/invitations') {
      const body = route.request().postDataJSON();
      invitations.splice(0, invitations.length, {
        id: 'pending-invite',
        ...body,
        expiresAt: Date.now() + 7 * 86400000,
      });
    }
    return route.fulfill({ json: { ok: true } });
  });
  await fixture.open();
  await page
    .getByRole('button', { name: 'Семья и доступы', exact: true })
    .click();
  const person = people[1],
    row = page.locator('.family-directory-person').filter({
      has: page.getByRole('button', {
        name: 'Изменить имя и цвет: ' + person.displayName,
      }),
    });
  await expect(page.locator('.family-directory-person').first()).toContainText(
    people[0].displayName,
  );
  await row
    .getByRole('button', { name: 'Изменить имя и цвет: ' + person.displayName })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Участник семьи' });
  await expect(dialog.getByLabel('Имя', { exact: true })).toHaveValue(
    person.displayName,
  );
  await dialog.getByLabel('Имя', { exact: true }).fill('Новое имя');
  await dialog.getByLabel('Цвет', { exact: true }).fill('#336699');
  await dialog.getByRole('button', { name: 'Сохранить имя и цвет' }).click();
  await expect
    .poll(
      () => fixture.read().people.find((p) => p.id === person.id)?.displayName,
    )
    .toBe('Новое имя');
  await expect(
    dialog.getByLabel('Права доступа').locator('option').first(),
  ).toHaveAttribute('value', 'admin');
  await expect(
    dialog.getByLabel('Права доступа').locator('option[value=admin]'),
  ).toHaveJSProperty('disabled', true);
  await dialog.getByLabel('Права доступа').selectOption('own_editor');
  await dialog.getByLabel('Email', { exact: true }).fill('guest@example.com');
  await dialog.getByRole('button', { name: 'Отправить приглашение' }).click();
  await expect(dialog).toHaveCount(0);
  const updated = page.locator('.family-directory-person').filter({
    has: page.getByRole('button', { name: 'Изменить имя и цвет: Новое имя' }),
  });
  await expect(updated.locator('.family-person-email')).toHaveClass(
    /is-pending/,
  );
  await expect(updated).toContainText('Email не подтверждён');
  expect(invitations[0]).toMatchObject({
    email: 'guest@example.com',
    personId: person.id,
    role: 'own_editor',
  });
  members.push({
    id: 'accepted-guest',
    login: 'guest@example.com',
    email: 'guest@example.com',
    personId: person.id,
    role: 'own_editor',
  });
  invitations.splice(0);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(updated.locator('.family-person-email')).not.toHaveClass(
    /is-pending/,
  );
  await updated
    .getByRole('button', { name: 'guest@example.com', exact: true })
    .click();
  await expect(dialog.getByLabel('Подтверждённый Google email')).toHaveValue(
    'guest@example.com',
  );
  await expect(
    dialog.getByLabel('Права доступа').locator('option[value=admin]'),
  ).toHaveJSProperty('disabled', false);
  expect(fixture.errors).toEqual([]);
});

test('admin transfer is selected only for a verified member and updates the current role', async ({
  page,
}) => {
  const fixture = await mockGoogleHousehold(page),
    people = fixture.read().people;
  let members = [
    { ...TEST_USER, email: 'parent@example.com', personId: people[0].id },
    {
      id: 'verified-member',
      login: 'member@example.com',
      email: 'member@example.com',
      role: 'own_editor',
      personId: people[1].id,
      name: people[1].displayName,
    },
  ];
  await page.route('**/api/family/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/family/members')
      return route.fulfill({
        json: { members, invitations: [], invitationsEnabled: true },
      });
    if (path === '/api/family/transfer') {
      expect(route.request().postDataJSON()).toEqual({
        subject: 'verified-member',
      });
      members = members.map((member) => ({
        ...member,
        role: member.id === 'verified-member' ? 'admin' : 'deleter',
      }));
      fixture.setUser({ ...TEST_USER, role: 'deleter' });
    }
    return route.fulfill({ json: { ok: true } });
  });
  await fixture.open();
  await page
    .getByRole('button', { name: 'Семья и доступы', exact: true })
    .click();
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('combobox', { name: 'Роль: ' + people[1].displayName })
    .selectOption('admin');
  await expect(page.getByRole('combobox', { name: /Роль:/ })).toHaveCount(0);
  await expect(page.locator('.family-directory-person').first()).toContainText(
    people[1].displayName,
  );
  expect(fixture.errors).toEqual([]);
});

test('read-only member sees pending status without controls or a separate head panel', async ({
  page,
}) => {
  const fixture = await mockGoogleHousehold(page),
    people = fixture.read().people;
  fixture.setUser({ ...TEST_USER, role: 'observer' });
  await page.route('**/api/family/members', (route) =>
    route.fulfill({
      json: {
        members: [
          {
            ...TEST_USER,
            role: 'admin',
            email: 'parent@example.com',
            personId: people[0].id,
          },
        ],
        invitations: [
          {
            id: 'pending',
            email: 'guest@example.com',
            personId: people[1].id,
            role: 'editor',
            expiresAt: Date.now() + 86400000,
          },
        ],
        invitationsEnabled: true,
      },
    }),
  );
  await fixture.open();
  await page
    .getByRole('button', { name: 'Семья и доступы', exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.family-directory')).toContainText(
    'guest@example.com',
  );
  await expect(page.getByRole('combobox', { name: /Роль:/ })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /Изменить имя и цвет:/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Глава семьи', exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(fixture.errors).toEqual([]);
});

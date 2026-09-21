import type { Command, State } from './types';
import {
  addMonths,
  applyCommands,
  DEFAULT_HOUSEHOLD_COLOR,
  stableId,
} from './core';

export function createEmptyState(): State {
  return {
    schemaVersion: 1,
    revision: 0,
    household: {
      id: stableId('household'),
      name: 'Наш дом',
      color: DEFAULT_HOUSEHOLD_COLOR,
      currency: 'CZK',
      timezone: 'Europe/Prague',
      locale: 'ru',
    },
    people: [],
    providers: [],
    obligations: [],
    rules: [],
    periods: [],
    accounts: [],
    entitlements: [],
    payments: [],
    allocations: [],
    refunds: [],
    audit: [],
  };
}
export function createDemoState(
  today = new Date().toISOString().slice(0, 10),
): State {
  const month = `${today.slice(0, 7)}-01`;
  const lastMonth = addMonths(month, -1);
  const nextMonth = addMonths(month, 1);
  const id = stableId;
  let state = createEmptyState();
  state.household.name = 'Семья Новак';
  const names = ['Алексей', 'Мария', 'Соня', 'Максим'];
  const commands: Command[] = names.map((displayName, i) => ({
    type: 'AddPerson',
    payload: { id: id(`person-${i}`), displayName },
  }));
  const entries = [
    ['Аренда квартиры', 'Дом', 'Жильё', 2450000, 1, 'household'],
    ['Netflix Premium', 'Netflix', 'Развлечения', 31900, 12, 'multi_account'],
    ['Spotify Family', 'Spotify', 'Музыка', 26900, 15, 'multi_account'],
    ['Домашний интернет', 'Vodafone', 'Связь', 59900, 20, 'household'],
    ['Электричество', 'PRE', 'Коммунальные', 180000, 8, 'household'],
    ['iCloud+ 200 ГБ', 'Apple', 'Хранилище', 7900, 24, 'multi_account'],
  ] as const;
  for (const [
    i,
    [title, provider, category, amount, day, mode],
  ] of entries.entries()) {
    const oid = id(`obligation-${i}`),
      pid = id(`provider-${i}`),
      anchor = `${lastMonth.slice(0, 7)}-${String(day).padStart(2, '0')}`;
    commands.push({
      type: 'AddObligation',
      payload: {
        provider: { id: pid, name: provider, category },
        obligation: {
          id: oid,
          providerId: pid,
          title,
          coverageMode: mode,
          ownerPersonId: id(`person-${i % 2}`),
          activeFrom: anchor,
          lifecycleState: 'active',
          ...(mode === 'multi_account'
            ? { seatCapacity: i === 2 ? 6 : 4 }
            : {}),
        },
        rule: {
          id: id(`rule-${i}`),
          obligationId: oid,
          effectiveFrom: anchor,
          anchor,
          cadence: 'monthly',
          dueOffsetDays: 0,
          amountMode: i === 4 ? 'estimate' : 'fixed',
          amount,
          currency: 'CZK',
          reminderDays: 3,
          graceDays: 0,
        },
        entitlements: names.map((_, j) => ({
          id: id(`entitlement-${i}-${j}`),
          obligationId: oid,
          personId: id(`person-${j}`),
          validFrom: anchor,
          ...(mode === 'multi_account' ? { seatNo: j + 1 } : {}),
        })),
      },
    });
  }
  commands.push({
    type: 'GeneratePeriods',
    payload: { from: lastMonth, to: addMonths(month, 3) },
  });
  state = applyCommands(state, commands, {
    actorUserId: 'demo-admin',
    operationId: 'demo-setup',
    now: `${month}T08:00:00Z`,
  });
  const payments: Command[] = [];
  for (const p of state.periods.filter(
    (p) => p.periodStart >= month && p.periodStart < nextMonth,
  )) {
    const i = state.obligations.findIndex((o) => o.id === p.obligationId);
    if (i !== 0 && i !== 2) continue;
    payments.push({
      type: 'RecordPaymentAndAllocate',
      payload: {
        payment: {
          id: id(`payment-${i}`),
          paidAt: month,
          amount: i === 0 ? 2000000 : p.expectedAmount!,
          currency: 'CZK',
          payerPersonId: id(`person-${i % 2}`),
          source: 'manual',
          descriptor: state.obligations[i].title,
        },
        allocations: [
          {
            id: id(`allocation-${i}`),
            billingPeriodId: p.id,
            amount: i === 0 ? 2000000 : p.expectedAmount!,
          },
        ],
      },
    });
  }
  return applyCommands(state, payments, {
    actorUserId: 'demo-admin',
    operationId: 'demo-payments',
    now: `${month}T09:00:00Z`,
  });
}

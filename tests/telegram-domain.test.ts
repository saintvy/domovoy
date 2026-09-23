import { describe, expect, it } from 'vitest';
import {
  applyCommands,
  createEmptyState,
  effectiveReminderSettings,
  selectTelegramReportItems,
  stableId,
  type Command,
  type State,
} from '../src/domain';

const id = stableId;
const context = (operationId: string) => ({
  actorUserId: 'test-admin',
  operationId,
  now: '2026-09-22T08:00:00Z',
});

function setup(options?: {
  reminder?: { enabled: boolean; daysBefore: number; repeat: 'once' | 'daily' };
  amountMode?: 'fixed' | 'estimate' | 'variable-confirmed';
  amount?: number;
  graceDays?: number;
  generate?: boolean;
}): State {
  const owner = id('reminder-owner');
  const beneficiary = id('reminder-beneficiary');
  const commands: Command[] = [
    { type: 'AddPerson', payload: { id: owner, displayName: 'Owner' } },
    {
      type: 'AddPerson',
      payload: { id: beneficiary, displayName: 'Beneficiary' },
    },
    {
      type: 'AddObligation',
      payload: {
        provider: {
          id: id('reminder-provider'),
          name: 'Power',
          category: 'utilities',
        },
        obligation: {
          id: id('reminder-obligation'),
          providerId: id('reminder-provider'),
          title: 'Electricity',
          coverageMode: 'single_account',
          ownerPersonId: owner,
          beneficiaries: { kind: 'people', personIds: [beneficiary] },
          activeFrom: '2026-09-20',
          lifecycleState: 'active',
          reminder: options?.reminder ?? {
            enabled: true,
            daysBefore: 1,
            repeat: 'daily',
          },
        },
        rule: {
          id: id('reminder-rule'),
          obligationId: id('reminder-obligation'),
          effectiveFrom: '2026-09-20',
          anchor: '2026-09-20',
          cadence: 'monthly',
          dueOffsetDays: 0,
          amountMode: options?.amountMode ?? 'fixed',
          ...(options?.amountMode === 'variable-confirmed'
            ? {}
            : { amount: options?.amount ?? 10_000 }),
          currency: 'CZK',
          reminderDays: 99,
          graceDays: options?.graceDays ?? 0,
        },
      },
    },
  ];
  if (options?.generate !== false)
    commands.push({
      type: 'GeneratePeriods',
      payload: { from: '2026-09-01', to: '2026-11-01' },
    });
  return applyCommands(createEmptyState(), commands, context('setup'));
}

describe('Telegram reminder report selection', () => {
  it('selects the responsible person and preserves original partial balance', () => {
    let state = setup();
    const period = state.periods[0];
    state = applyCommands(
      state,
      [
        {
          type: 'RecordPaymentAndAllocate',
          payload: {
            payment: {
              id: id('partial-payment'),
              paidAt: '2026-09-20',
              amount: 4_000,
              currency: 'CZK',
              payerPersonId: id('reminder-owner'),
              source: 'manual',
            },
            allocations: [
              {
                id: id('partial-allocation'),
                billingPeriodId: period.id,
                amount: 4_000,
              },
            ],
          },
        },
      ],
      context('partial'),
    );
    expect(
      selectTelegramReportItems(state, {
        today: '2026-09-22',
        recipientPersonId: id('reminder-beneficiary'),
      }),
    ).toEqual([]);
    expect(
      selectTelegramReportItems(state, {
        today: '2026-09-22',
        recipientPersonId: id('reminder-owner'),
      })[0],
    ).toMatchObject({
      section: 'overdue',
      title: 'Electricity',
      dueDate: '2026-09-20',
      amount: 6_000,
      currency: 'CZK',
      amountState: 'confirmed',
    });
  });

  it('respects lead days, grace, one-time receipts, waivers and paid periods', () => {
    const state = setup({
      reminder: { enabled: true, daysBefore: 2, repeat: 'once' },
      graceDays: 3,
    });
    const period = state.periods[0];
    const input = {
      today: '2026-09-21',
      recipientPersonId: id('reminder-owner'),
    };
    expect(selectTelegramReportItems(state, input)[0].section).toBe('due');
    expect(
      selectTelegramReportItems(state, {
        ...input,
        onceReminderPeriodIds: new Set([
          `${id('reminder-obligation')}:${period.id}`,
        ]),
      }),
    ).toEqual([]);
    expect(
      selectTelegramReportItems(
        {
          ...state,
          periods: [
            {
              ...period,
              waiver: {
                reason: 'Cancelled',
                actorUserId: 'test-admin',
                createdAt: '2026-09-21T08:00:00Z',
              },
            },
          ],
        },
        input,
      ),
    ).toEqual([]);
  });

  it('classifies automatic charges and distinguishes estimated and unknown money', () => {
    let estimated = setup({ amountMode: 'estimate' });
    estimated = applyCommands(
      estimated,
      [
        {
          type: 'AddAutomaticPayment',
          payload: {
            schedule: {
              id: id('automatic-reminder'),
              obligationId: id('reminder-obligation'),
              payerPersonId: id('reminder-owner'),
              startDate: '2026-09-01',
              enabled: true,
            },
          },
        },
      ],
      context('automatic'),
    );
    expect(
      selectTelegramReportItems(estimated, {
        today: '2026-09-20',
        recipientPersonId: id('reminder-owner'),
      })[0],
    ).toMatchObject({ section: 'automatic', amountState: 'estimated' });

    const unknown = setup({ amountMode: 'variable-confirmed' });
    expect(
      selectTelegramReportItems(unknown, {
        today: '2026-09-20',
        recipientPersonId: id('reminder-owner'),
      })[0],
    ).toMatchObject({ amount: undefined, amountState: 'unknown' });
  });

  it('forecasts missing future periods without mutating financial state', () => {
    const state = setup({
      reminder: { enabled: true, daysBefore: 2, repeat: 'daily' },
      generate: false,
    });
    expect(state.periods).toHaveLength(0);
    expect(
      selectTelegramReportItems(state, {
        today: '2026-09-19',
        recipientPersonId: id('reminder-owner'),
      }),
    ).toHaveLength(1);
    expect(state.periods).toHaveLength(0);
  });

  it('applies existing obligation credit in the pure forecast', () => {
    let state = setup({ generate: false });
    state = applyCommands(
      state,
      [
        {
          type: 'RecordPaymentAndAllocate',
          payload: {
            payment: {
              id: id('advance-credit'),
              paidAt: '2026-09-18',
              amount: 10_000,
              currency: 'CZK',
              payerPersonId: id('reminder-owner'),
              obligationId: id('reminder-obligation'),
              source: 'manual',
            },
            allocations: [],
          },
        },
      ],
      context('advance-credit'),
    );
    expect(state.periods).toHaveLength(0);
    expect(
      selectTelegramReportItems(state, {
        today: '2026-09-19',
        recipientPersonId: id('reminder-owner'),
      }),
    ).toEqual([]);
    expect(state.allocations).toHaveLength(0);
  });

  it('does not abort a foreign-currency report when a projected cross-rate is unavailable', () => {
    const state = setup({ generate: false });
    state.household.currencies = ['CZK', 'USD', 'EUR'];
    state.rules[0].currency = 'USD';
    state.rules[0].amount = 10_000;
    state.payments.push({
      id: id('eur-credit'),
      paidAt: '2026-09-18',
      amount: 4_000,
      currency: 'EUR',
      baseAmount: 100_000,
      baseCurrency: 'CZK',
      exchangeRate: '25',
      exchangeRateDate: '2026-09-18',
      exchangeRateSource: 'ECB',
      payerPersonId: id('reminder-owner'),
      obligationId: id('reminder-obligation'),
      source: 'manual',
    });
    expect(() =>
      selectTelegramReportItems(state, {
        today: '2026-09-19',
        recipientPersonId: id('reminder-owner'),
      }),
    ).not.toThrow();
    expect(
      selectTelegramReportItems(state, {
        today: '2026-09-19',
        recipientPersonId: id('reminder-owner'),
      })[0],
    ).toMatchObject({
      amount: 10_000,
      currency: 'USD',
      creditNeedsReview: true,
    });
  });

  it('suppresses zero and fully credited foreign-currency forecasts without base valuation', () => {
    const zero = setup({ amount: 0, generate: false });
    zero.household.currencies = ['CZK', 'USD'];
    zero.rules[0].currency = 'USD';
    expect(
      selectTelegramReportItems(zero, {
        today: '2026-09-19',
        recipientPersonId: id('reminder-owner'),
      }),
    ).toEqual([]);

    const credited = setup({ amount: 10_000, generate: false });
    credited.household.currencies = ['CZK', 'USD'];
    credited.rules[0].currency = 'USD';
    credited.payments.push({
      id: id('usd-credit'),
      paidAt: '2026-09-18',
      amount: 10_000,
      currency: 'USD',
      baseAmount: 230_000,
      baseCurrency: 'CZK',
      exchangeRate: '23',
      exchangeRateDate: '2026-09-18',
      exchangeRateSource: 'ECB',
      payerPersonId: id('reminder-owner'),
      obligationId: id('reminder-obligation'),
      source: 'manual',
    });
    expect(
      selectTelegramReportItems(credited, {
        today: '2026-09-19',
        recipientPersonId: id('reminder-owner'),
      }),
    ).toEqual([]);
    expect(credited.allocations).toHaveLength(0);
  });

  it('covers the combined negative due offset and maximum reminder lead', () => {
    const state = setup({
      reminder: { enabled: true, daysBefore: 365, repeat: 'daily' },
      generate: false,
    });
    state.obligations[0].activeFrom = '2028-09-17';
    state.rules[0].anchor = '2028-09-17';
    state.rules[0].effectiveFrom = '2028-09-17';
    state.rules[0].dueOffsetDays = -366;
    expect(
      selectTelegramReportItems(state, {
        today: '2026-09-17',
        recipientPersonId: id('reminder-owner'),
      })[0],
    ).toMatchObject({ dueDate: '2027-09-17', amount: 10_000 });
  });

  it('keeps legacy reminderDays separate and applies migration fallback', () => {
    const regular = setup();
    delete regular.obligations[0].reminder;
    expect(effectiveReminderSettings(regular, regular.obligations[0])).toEqual({
      enabled: true,
      daysBefore: 1,
      repeat: 'daily',
    });
    regular.automaticPayments = [
      {
        id: id('legacy-auto'),
        obligationId: regular.obligations[0].id,
        payerPersonId: id('reminder-owner'),
        startDate: '2026-09-01',
        enabled: true,
      },
    ];
    expect(effectiveReminderSettings(regular, regular.obligations[0])).toEqual({
      enabled: false,
      daysBefore: 1,
      repeat: 'daily',
    });
    expect(regular.rules[0].reminderDays).toBe(99);
  });

  it('materializes a legacy default before an automatic-payment mutation', () => {
    const legacy = setup();
    delete legacy.obligations[0].reminder;
    const updated = applyCommands(
      legacy,
      [
        {
          type: 'AddAutomaticPayment',
          payload: {
            schedule: {
              id: id('later-auto'),
              obligationId: legacy.obligations[0].id,
              payerPersonId: id('reminder-owner'),
              startDate: '2026-09-22',
              enabled: true,
            },
          },
        },
      ],
      context('later-auto'),
    );
    expect(updated.obligations[0].reminder).toEqual({
      enabled: true,
      daysBefore: 1,
      repeat: 'daily',
    });
  });
});

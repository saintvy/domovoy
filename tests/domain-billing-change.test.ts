import { describe, expect, it } from 'vitest';
import {
  applyCommands,
  createEmptyState,
  generatePeriods,
  getPeriodStatus,
  previewBillingRuleChange,
  requiredExchangeRates,
  stableId,
  type BillingRule,
  type Command,
  type CommandContext,
  type State,
} from '../src/domain';

const id = stableId;
let operation = 0;
const context = (extra: Partial<CommandContext> = {}): CommandContext => ({
  actorUserId: 'admin',
  operationId: 'billing-change-' + ++operation,
  now: '2026-09-16T12:00:00Z',
  ...extra,
});
function setup(): State {
  return applyCommands(
    createEmptyState(),
    [
      { type: 'UpdateHousehold', payload: { currencies: ['CZK', 'USD'] } },
      {
        type: 'AddPerson',
        payload: { id: id('billing-person'), displayName: 'Alex' },
      },
      {
        type: 'AddObligation',
        payload: {
          provider: {
            id: id('billing-provider'),
            name: 'Provider',
            category: 'Home',
          },
          obligation: {
            id: id('billing-obligation'),
            providerId: id('billing-provider'),
            title: 'Rent',
            coverageMode: 'household',
            activeFrom: '2026-01-31',
            lifecycleState: 'active',
          },
          rule: {
            id: id('billing-rule'),
            obligationId: id('billing-obligation'),
            effectiveFrom: '2026-01-31',
            anchor: '2026-01-31',
            cadence: 'monthly',
            amountMode: 'fixed',
            amount: 10000,
            currency: 'CZK',
            dueOffsetDays: 0,
            reminderDays: 3,
            graceDays: 0,
          },
        },
      },
      {
        type: 'GeneratePeriods',
        payload: { from: '2026-01-31', to: '2026-09-01' },
      },
    ],
    context(),
  );
}
function price(
  state: State,
  start = '2026-03-31',
  amount = 20000,
): BillingRule {
  return {
    ...state.rules.find((rule) => !rule.superseded)!,
    id: id('price-' + ++operation),
    effectiveFrom: start,
    amount,
  };
}
function change(state: State, rule: BillingRule, fromPeriodId?: string): State {
  const command: Command = {
    type: 'ChangeBillingRule',
    payload: { rule, fromPeriodId },
  };
  return applyCommands(
    state,
    [command],
    context({
      exchangeRates: requiredExchangeRates(state, [command]).map((request) => ({
        ...request,
        rate: '25',
        source: 'test',
      })),
    }),
  );
}
function allocate(state: State, periodIndex: number, amount: number): State {
  return applyCommands(
    state,
    [
      {
        type: 'RecordPaymentAndAllocate',
        payload: {
          payment: {
            id: id('paid-' + ++operation),
            paidAt: '2026-02-01',
            amount,
            currency: 'CZK',
            payerPersonId: id('billing-person'),
            source: 'manual',
          },
          allocations: [
            {
              id: id('allocation-' + operation),
              billingPeriodId: state.periods[periodIndex].id,
              amount,
            },
          ],
        },
      },
    ],
    context(),
  );
}

describe('price changes from a selected billing period', () => {
  it('reprices the selected and following generated unpaid periods without replacing their IDs', () => {
    const state = setup(),
      rule = price(state),
      selected = state.periods[2];
    const preview = previewBillingRuleChange(state, rule, selected.id);
    expect(preview.changedPeriodIds).toEqual(
      state.periods.slice(2).map((period) => period.id),
    );
    expect(preview.preservedPeriodIds).toEqual([]);
    const updated = change(state, rule, selected.id);
    expect(updated.periods.slice(0, 2)).toEqual(state.periods.slice(0, 2));
    expect(
      updated.periods
        .slice(2)
        .every(
          (period) =>
            period.expectedAmount === 20000 &&
            period.baseExpectedAmount === 20000 &&
            period.ruleVersionId === rule.id,
        ),
    ).toBe(true);
    expect(updated.periods.map((period) => period.id)).toEqual(
      state.periods.map((period) => period.id),
    );
    expect(updated.audit.at(-1)?.entityRefs).toContain(selected.id);
    expect(state.periods[2].expectedAmount).toBe(10000);
  });
  it('allows changing the very first unpaid period and retains its superseded rule for history', () => {
    const state = setup(),
      rule = price(state, '2026-01-31');
    const updated = change(state, rule, state.periods[0].id);
    expect(
      updated.rules.find((item) => item.id === state.rules[0].id),
    ).toMatchObject({ amount: 10000, superseded: true });
    expect(
      updated.periods.every((period) => period.expectedAmount === 20000),
    ).toBe(true);
    expect(
      generatePeriods(updated, '2026-09-01', '2027-01-01').every(
        (period) => period.expectedAmount === 20000,
      ),
    ).toBe(true);
  });
  it('keeps later paid, partially paid and waived periods byte-for-byte while repricing the others', () => {
    let state = allocate(setup(), 4, 10000);
    state = allocate(state, 5, 3000);
    state = applyCommands(
      state,
      [
        {
          type: 'WaivePeriod',
          payload: {
            periodId: state.periods[6].id,
            reason: 'Waived by provider',
          },
        },
      ],
      context(),
    );
    const rule = price(state),
      preview = previewBillingRuleChange(state, rule, state.periods[2].id),
      updated = change(state, rule, state.periods[2].id);
    expect(preview.preservedPeriodIds).toEqual(
      state.periods.slice(4, 7).map((period) => period.id),
    );
    for (const index of [4, 5, 6])
      expect(updated.periods[index]).toEqual(state.periods[index]);
    expect(updated.payments).toEqual(state.payments);
    expect(updated.allocations).toEqual(state.allocations);
    expect(updated.periods[3].expectedAmount).toBe(20000);
    expect(updated.periods[7].expectedAmount).toBe(20000);
  });
  it('refuses a selected partially paid, refunded or otherwise closed period explicitly', () => {
    let state = allocate(setup(), 2, 3000),
      rule = price(state);
    expect(() => change(state, rule, state.periods[2].id)).toThrow('защищена');
    const payment = state.payments[0],
      allocation = state.allocations[0];
    state = applyCommands(
      state,
      [
        {
          type: 'RefundPayment',
          payload: {
            refund: {
              id: id('billing-refund'),
              originalPaymentId: payment.id,
              amount: 3000,
              paidAt: '2026-02-02',
              reason: 'Full refund',
            },
            reverseAllocationIds: [allocation.id],
          },
        },
      ],
      context(),
    );
    expect(
      getPeriodStatus(state, state.periods[2], '2026-09-16').settlementState,
    ).toBe('unpaid');
    expect(() => change(state, rule, state.periods[2].id)).toThrow('возвратом');
  });
  it('preserves automatic-run and zero-price closure records when they are after the selected period', () => {
    const state = setup();
    state.automaticPaymentRuns = [
      {
        id: id('billing-auto-run'),
        scheduleId: id('deleted-auto'),
        periodId: state.periods[4].id,
        paidAt: state.periods[4].dueDate,
        status: 'covered',
      },
    ];
    state.periods[5].expectedAmount = 0;
    state.periods[5].baseExpectedAmount = 0;
    const updated = change(state, price(state), state.periods[2].id);
    expect(updated.periods[4]).toEqual(state.periods[4]);
    expect(updated.periods[5]).toEqual(state.periods[5]);
    expect(updated.automaticPaymentRuns).toEqual(state.automaticPaymentRuns);
  });
  it('supersedes already scheduled later price versions so the selected price continues into the future', () => {
    let state = setup();
    const planned = price(state, '2026-06-30', 15000);
    state = change(state, planned, state.periods[5].id);
    const replacement = price(state, '2026-03-31', 22000),
      updated = change(state, replacement, state.periods[2].id);
    expect(
      updated.rules.find((rule) => rule.id === planned.id)?.superseded,
    ).toBe(true);
    expect(
      updated.periods
        .slice(2)
        .every((period) => period.expectedAmount === 22000),
    ).toBe(true);
    expect(
      generatePeriods(updated, '2026-09-01', '2027-03-01').every(
        (period) => period.expectedAmount === 22000,
      ),
    ).toBe(true);
  });
  it('collects trusted FX for every repriced existing period using its new due date', () => {
    const state = setup(),
      rule = {
        ...price(state),
        currency: 'USD',
        amount: 1000,
        dueOffsetDays: 2,
      };
    const command: Command = {
      type: 'ChangeBillingRule',
      payload: { rule, fromPeriodId: state.periods[2].id },
    };
    const requests = requiredExchangeRates(state, [command]);
    expect(requests).toHaveLength(state.periods.length - 2);
    expect(requests[0]).toEqual({ from: 'USD', to: 'CZK', date: '2026-04-02' });
    const updated = change(state, rule, state.periods[2].id);
    expect(updated.periods[2]).toMatchObject({
      expectedAmount: 1000,
      baseExpectedAmount: 25000,
      dueDate: '2026-04-02',
      exchangeRateDate: '2026-04-02',
    });
    expect(() => applyCommands(state, [command], context())).toThrow('курс');
    expect(state.periods[2].expectedAmount).toBe(10000);
  });
  it('can reset unpaid periods to an unknown variable amount without keeping stale converted totals', () => {
    const state = setup(),
      rule = {
        ...price(state),
        amount: undefined,
        amountMode: 'variable-confirmed' as const,
      };
    const updated = change(state, rule, state.periods[2].id);
    expect(updated.periods[2].expectedAmount).toBeUndefined();
    expect(updated.periods[2].baseExpectedAmount).toBeUndefined();
    expect(
      getPeriodStatus(updated, updated.periods[2], '2026-09-16'),
    ).toMatchObject({ dataState: 'unknown', remaining: null });
  });
  it('rejects a mismatched selected period and incompatible cadence instead of rewriting its intervals', () => {
    const state = setup();
    expect(() => change(state, price(state), state.periods[3].id)).toThrow(
      'не соответствует',
    );
    const rule = {
      ...price(state),
      cadence: 'weekly' as const,
      anchor: '2026-03-31',
    };
    expect(() => change(state, rule, state.periods[2].id)).toThrow(
      'пересекается',
    );
    expect(state.periods[2].periodEnd).toBe('2026-04-30');
  });
});

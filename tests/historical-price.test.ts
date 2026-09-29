import { describe, expect, it } from 'vitest';
import {
  applyCommands,
  createEmptyState,
  getPeriodStatus,
  paymentRemaining,
  periodRemainingAsOf,
  requiredExchangeRates,
  stableId,
  type BillingRule,
  type Command,
  type CommandContext,
  type State,
} from '../src/domain';
import { authorizeFamilyCommands } from '../src/aws/family-permissions';

let serial = 0;
const uid = (value: string) => stableId(`historical:${value}`);
const ctx = (rates: CommandContext['exchangeRates'] = []): CommandContext => ({
  actorUserId: 'owner',
  operationId: `historical-${++serial}`,
  now: '2026-09-29T12:00:00Z',
  exchangeRates: rates,
});
function initial(): State {
  return applyCommands(
    createEmptyState(),
    [
      {
        type: 'UpdateHousehold',
        payload: {
          currency: 'CZK',
          currencies: ['CZK', 'USD'],
          allowHistoricalPriceEdits: true,
        },
      },
      {
        type: 'AddPerson',
        payload: { id: uid('person'), displayName: 'Alex' },
      },
      {
        type: 'AddObligation',
        payload: {
          provider: { id: uid('provider'), name: 'Provider', category: 'Home' },
          obligation: {
            id: uid('obligation'),
            providerId: uid('provider'),
            title: 'Rent',
            coverageMode: 'household',
            activeFrom: '2026-01-01',
            lifecycleState: 'active',
          },
          rule: {
            id: uid('initial'),
            obligationId: uid('obligation'),
            effectiveFrom: '2026-01-01',
            anchor: '2026-01-01',
            cadence: 'monthly',
            dueOffsetDays: 0,
            amountMode: 'fixed',
            amount: 10000,
            currency: 'CZK',
            reminderDays: 3,
            graceDays: 0,
          },
        },
      },
      {
        type: 'GeneratePeriods',
        payload: { from: '2026-01-01', to: '2026-06-01' },
      },
    ],
    ctx(),
  );
}
function edit(
  state: State,
  action: 'add' | 'update' | 'delete',
  date: string,
  amount?: number,
  currency = 'CZK',
): Command {
  const active = state.rules.find(
    (rule) => rule.effectiveFrom === date && !rule.superseded,
  );
  const previous = state.rules
    .filter((rule) => rule.effectiveFrom <= date && !rule.superseded)
    .at(-1)!;
  const rule: BillingRule | undefined =
    action === 'delete'
      ? undefined
      : {
          ...previous,
          id: uid(`rule-${++serial}`),
          effectiveFrom: date,
          amount,
          currency,
          effectiveTo: undefined,
        };
  return {
    type: 'EditHistoricalPrice',
    payload: {
      obligationId: uid('obligation'),
      action,
      effectiveFrom: date,
      ...(active && action !== 'add' ? { ruleId: active.id } : {}),
      ...(rule ? { rule } : {}),
    },
  };
}
function apply(state: State, command: Command, withRates = true): State {
  const rates = withRates
    ? requiredExchangeRates(state, [command]).map((request) => ({
        ...request,
        rate: request.from === 'USD' ? '25' : '0.04',
        source: 'test',
      }))
    : [];
  return applyCommands(state, [command], ctx(rates));
}
describe('historical prices', () => {
  it('requires administrator-enabled setting and the first price cannot be deleted', () => {
    const state = initial();
    const off = applyCommands(
      state,
      [
        {
          type: 'UpdateHousehold',
          payload: { allowHistoricalPriceEdits: false },
        },
      ],
      ctx(),
    );
    expect(() =>
      apply(off, edit(off, 'add', '2026-03-01', 20000)),
    ).toThrowError();
    expect(() =>
      apply(state, edit(state, 'delete', '2026-01-01')),
    ).toThrowError();
    const first = apply(state, edit(state, 'update', '2026-01-01', 12000));
    expect(
      first.rules.filter((rule) => !rule.superseded)[0].effectiveFrom,
    ).toBe('2026-01-01');
    expect(first.periods[0].expectedAmount).toBe(12000);
  });
  it('adds, updates and deletes a middle price without altering later version or period IDs', () => {
    const state = initial();
    const added = apply(state, edit(state, 'add', '2026-03-01', 20000));
    const later = apply(added, edit(added, 'add', '2026-05-01', 30000));
    const updated = apply(later, edit(later, 'update', '2026-03-01', 25000));
    expect(updated.periods.map((period) => period.expectedAmount)).toEqual([
      10000, 10000, 25000, 25000, 30000,
    ]);
    const deleted = apply(updated, edit(updated, 'delete', '2026-03-01'));
    expect(deleted.periods.map((period) => period.expectedAmount)).toEqual([
      10000, 10000, 10000, 10000, 30000,
    ]);
    expect(deleted.periods.map((period) => period.id)).toEqual(
      state.periods.map((period) => period.id),
    );
    expect(deleted.audit.at(-1)?.action).toBe('EditHistoricalPrice');
  });
  it('rejects deleting a future price version whose calendar differs before periods are generated', () => {
    const state = initial();
    const later: BillingRule = {
      ...state.rules[0],
      id: uid('weekly-rule'),
      effectiveFrom: '2026-06-01',
      anchor: '2026-06-01',
      cadence: 'weekly',
    };
    const withWeekly = applyCommands(
      state,
      [{ type: 'ChangeBillingRule', payload: { rule: later } }],
      ctx(),
    );
    expect(
      withWeekly.periods.every((item) => item.periodStart < '2026-06-01'),
    ).toBe(true);
    expect(() =>
      apply(withWeekly, edit(withWeekly, 'delete', '2026-06-01')),
    ).toThrowError();
  });
  it('rejects a forged amount mode change through price editing', () => {
    const state = initial(),
      command = edit(state, 'add', '2026-03-01', 20000);
    if (command.type === 'EditHistoricalPrice')
      command.payload.rule!.amountMode = 'estimate';
    expect(() => apply(state, command)).toThrowError();
  });
  it('releases excess paid value as credit and preserves the payment and automatic run', () => {
    let state = initial();
    state = applyCommands(
      state,
      [
        {
          type: 'RecordPaymentAndAllocate',
          payload: {
            payment: {
              id: uid('payment'),
              paidAt: '2026-02-01',
              amount: 10000,
              currency: 'CZK',
              payerPersonId: uid('person'),
              obligationId: uid('obligation'),
              source: 'manual',
            },
            allocations: [
              {
                id: uid('allocation'),
                billingPeriodId: state.periods[1].id,
                amount: 10000,
              },
            ],
          },
        },
      ],
      ctx(),
    );
    state.automaticPaymentRuns!.push({
      id: uid('run'),
      scheduleId: uid('schedule'),
      periodId: state.periods[1].id,
      paidAt: '2026-02-01',
      status: 'covered',
    });
    const payment = structuredClone(state.payments[0]),
      run = structuredClone(state.automaticPaymentRuns![0]);
    const updated = apply(state, edit(state, 'add', '2026-02-01', 5000));
    expect(updated.payments[0]).toEqual(payment);
    expect(updated.automaticPaymentRuns![0]).toEqual(run);
    expect(
      updated.allocations.find((item) => item.id === uid('allocation'))
        ?.periodAmount,
    ).toBe(5000);
    expect(
      getPeriodStatus(updated, updated.periods[1], '2026-09-29')
        .settlementState,
    ).toBe('paid');
    // Released balance may settle another due period, so total allocation remains conserved.
    expect(paymentRemaining(updated, uid('payment'))).toBeGreaterThanOrEqual(0);
  });
  it('reconciles a partial allocation against a larger historical charge', () => {
    let state = initial();
    state = applyCommands(
      state,
      [
        {
          type: 'RecordPaymentAndAllocate',
          payload: {
            payment: {
              id: uid('partial-payment'),
              paidAt: '2026-02-01',
              amount: 3000,
              currency: 'CZK',
              payerPersonId: uid('person'),
              source: 'manual',
            },
            allocations: [
              {
                id: uid('partial-allocation'),
                billingPeriodId: state.periods[1].id,
                amount: 3000,
              },
            ],
          },
        },
      ],
      ctx(),
    );
    const changed = apply(state, edit(state, 'add', '2026-02-01', 15000));
    expect(changed.allocations[0].periodAmount).toBe(3000);
    expect(
      getPeriodStatus(changed, changed.periods[1], '2026-09-29'),
    ).toMatchObject({ settlementState: 'partial', remaining: 12000 });
    expect(changed.audit.at(-1)?.details?.allocationCorrections).toBeDefined();
  });
  it('preserves split allocations across rounding boundaries on a no-op price edit', () => {
    let state = applyCommands(
      createEmptyState(),
      [
        {
          type: 'UpdateHousehold',
          payload: {
            currency: 'USD',
            currencies: ['USD', 'JPY'],
            allowHistoricalPriceEdits: true,
          },
        },
        {
          type: 'AddPerson',
          payload: { id: uid('round-person'), displayName: 'Round' },
        },
        {
          type: 'AddObligation',
          payload: {
            provider: {
              id: uid('round-provider'),
              name: 'Provider',
              category: 'Home',
            },
            obligation: {
              id: uid('round-obligation'),
              providerId: uid('round-provider'),
              title: 'Fee',
              coverageMode: 'household',
              activeFrom: '2026-01-01',
              lifecycleState: 'active',
            },
            rule: {
              id: uid('round-rule'),
              obligationId: uid('round-obligation'),
              effectiveFrom: '2026-01-01',
              anchor: '2026-01-01',
              cadence: 'monthly',
              dueOffsetDays: 0,
              amountMode: 'fixed',
              amount: 2,
              currency: 'USD',
              reminderDays: 0,
              graceDays: 0,
            },
          },
        },
        {
          type: 'GeneratePeriods',
          payload: { from: '2026-01-01', to: '2026-03-01' },
        },
      ],
      ctx(),
    );
    state = applyCommands(
      state,
      [
        {
          type: 'RecordPaymentAndAllocate',
          payload: {
            payment: {
              id: uid('round-payment'),
              paidAt: '2026-02-01',
              amount: 2,
              currency: 'JPY',
              payerPersonId: uid('round-person'),
              source: 'manual',
            },
            allocations: [
              {
                id: uid('round-a'),
                billingPeriodId: state.periods[0].id,
                amount: 2,
              },
              {
                id: uid('round-b'),
                billingPeriodId: state.periods[1].id,
                amount: 1,
              },
            ],
          },
        },
      ],
      ctx([
        {
          from: 'JPY',
          to: 'USD',
          date: '2026-02-01',
          rate: '0.015',
          source: 'test',
        },
      ]),
    );
    expect(state.allocations.map((item) => item.amount)).toEqual([2, 1]);
    expect(state.allocations.map((item) => item.paymentAmount)).toEqual([1, 1]);
    const rule: BillingRule = {
      ...state.rules[0],
      id: uid('round-replacement'),
      effectiveTo: undefined,
    };
    const command: Command = {
      type: 'EditHistoricalPrice',
      payload: {
        obligationId: uid('round-obligation'),
        action: 'update',
        effectiveFrom: '2026-01-01',
        ruleId: state.rules[0].id,
        rule,
      },
    };
    const corrected = applyCommands(state, [command], ctx());
    expect(corrected.allocations).toEqual(state.allocations);
    expect(paymentRemaining(corrected, uid('round-payment'))).toBe(0);
  });
  it('revalues a protected period still denominated in an older rule currency', () => {
    let state = initial();
    state = applyCommands(
      state,
      [
        {
          type: 'RecordPaymentAndAllocate',
          payload: {
            payment: {
              id: uid('protected-payment'),
              paidAt: '2026-03-01',
              amount: 10000,
              currency: 'CZK',
              payerPersonId: uid('person'),
              source: 'manual',
            },
            allocations: [
              {
                id: uid('protected-allocation'),
                billingPeriodId: state.periods[2].id,
                amount: 10000,
              },
            ],
          },
        },
      ],
      ctx(),
    );
    const ordinary: BillingRule = {
      ...state.rules[0],
      id: uid('ordinary-usd'),
      effectiveFrom: '2026-02-01',
      currency: 'USD',
      amount: 10000,
    };
    state = apply(state, {
      type: 'ChangeBillingRule',
      payload: { rule: ordinary },
    });
    expect(
      state.rules.find((item) => item.id === state.periods[2].ruleVersionId)
        ?.currency,
    ).toBe('CZK');
    const command = edit(state, 'update', '2026-02-01', 10000, 'USD');
    const corrected = apply(state, command);
    expect(
      corrected.rules.find(
        (item) => item.id === corrected.periods[2].ruleVersionId,
      )?.currency,
    ).toBe('USD');
    expect(
      corrected.allocations.find(
        (item) => item.id === uid('protected-allocation'),
      )?.periodAmount,
    ).toBe(400);
    expect(corrected.audit.at(-1)?.details?.periodBefore).toBeDefined();
  });
  it('keeps released value from an unlinked shared payment available for a later refund', () => {
    let state = initial();
    state = applyCommands(
      state,
      [
        {
          type: 'RecordPaymentAndAllocate',
          payload: {
            payment: {
              id: uid('shared-payment'),
              paidAt: '2026-02-01',
              amount: 10000,
              currency: 'CZK',
              payerPersonId: uid('person'),
              source: 'manual',
            },
            allocations: [
              {
                id: uid('shared-allocation'),
                billingPeriodId: state.periods[1].id,
                amount: 10000,
              },
            ],
          },
        },
      ],
      ctx(),
    );
    const changed = apply(state, edit(state, 'add', '2026-02-01', 5000));
    expect(paymentRemaining(changed, uid('shared-payment'))).toBe(5000);
    expect(changed.allocations[0]).toMatchObject({
      amount: 5000,
      periodAmount: 5000,
    });
    const refunded = applyCommands(
      changed,
      [
        {
          type: 'RefundPayment',
          payload: {
            refund: {
              id: uid('shared-refund'),
              originalPaymentId: uid('shared-payment'),
              paidAt: '2026-02-02',
              amount: 5000,
              reason: 'Unused money returned',
            },
            reverseAllocationIds: [],
          },
        },
      ],
      ctx(),
    );
    expect(paymentRemaining(refunded, uid('shared-payment'))).toBe(0);
  });
  it('requires trusted payment-date and due-date FX on a historical currency change', () => {
    let state = initial();
    state = applyCommands(
      state,
      [
        {
          type: 'RecordPaymentAndAllocate',
          payload: {
            payment: {
              id: uid('currency-payment'),
              paidAt: '2026-02-01',
              amount: 10000,
              currency: 'CZK',
              payerPersonId: uid('person'),
              source: 'manual',
            },
            allocations: [
              {
                id: uid('currency-allocation'),
                billingPeriodId: state.periods[1].id,
                amount: 10000,
              },
            ],
          },
        },
      ],
      ctx(),
    );
    const command = edit(state, 'add', '2026-02-01', 400, 'USD');
    expect(requiredExchangeRates(state, [command])).toContainEqual({
      from: 'CZK',
      to: 'USD',
      date: '2026-02-01',
    });
    expect(() => apply(state, command, false)).toThrowError();
    const changed = apply(state, command);
    expect(changed.periods[1]).toMatchObject({
      expectedAmount: 400,
      baseExpectedAmount: 10000,
    });
    expect(
      changed.allocations.find((item) => item.id === uid('currency-allocation'))
        ?.periodAmount,
    ).toBe(400);
    expect(changed.payments[0]).toEqual(state.payments[0]);
  });
  it('keeps reversed allocations and refunds while repricing waived and formerly paid periods', () => {
    let state = initial();
    state = applyCommands(
      state,
      [
        {
          type: 'RecordPaymentAndAllocate',
          payload: {
            payment: {
              id: uid('refunded-payment'),
              paidAt: '2026-02-01',
              amount: 10000,
              currency: 'CZK',
              payerPersonId: uid('person'),
              obligationId: uid('obligation'),
              source: 'manual',
            },
            allocations: [
              {
                id: uid('reversed-allocation'),
                billingPeriodId: state.periods[1].id,
                amount: 10000,
              },
            ],
          },
        },
      ],
      ctx(),
    );
    state = applyCommands(
      state,
      [
        {
          type: 'RefundPayment',
          payload: {
            refund: {
              id: uid('refund'),
              originalPaymentId: uid('refunded-payment'),
              paidAt: '2026-02-02',
              amount: 10000,
              reason: 'Provider refund',
            },
            reverseAllocationIds: [uid('reversed-allocation')],
          },
        },
        {
          type: 'WaivePeriod',
          payload: {
            periodId: state.periods[2].id,
            reason: 'Provider waived charge',
          },
        },
      ],
      ctx(),
    );
    const refund = structuredClone(state.refunds[0]),
      reversed = structuredClone(state.allocations[0]),
      waiver = structuredClone(state.periods[2].waiver);
    const changed = apply(state, edit(state, 'add', '2026-02-01', 5000));
    expect(changed.refunds[0]).toEqual(refund);
    expect(changed.allocations[0]).toMatchObject({
      id: reversed.id,
      paymentId: reversed.paymentId,
      paymentAmount: reversed.paymentAmount,
      amount: reversed.amount,
      reversedBy: reversed.reversedBy,
      periodAmount: 5000,
    });
    expect(changed.periods[2].waiver).toEqual(waiver);
    expect(changed.periods[2].expectedAmount).toBe(5000);
  });
  it('revalues a reversed allocation for historical as-of reporting in the new currency', () => {
    let state = initial();
    state = applyCommands(
      state,
      [
        {
          type: 'RecordPaymentAndAllocate',
          payload: {
            payment: {
              id: uid('asof-payment'),
              paidAt: '2026-02-01',
              amount: 10000,
              currency: 'CZK',
              payerPersonId: uid('person'),
              source: 'manual',
            },
            allocations: [
              {
                id: uid('asof-allocation'),
                billingPeriodId: state.periods[1].id,
                amount: 10000,
              },
            ],
          },
        },
      ],
      ctx(),
    );
    state = applyCommands(
      state,
      [
        {
          type: 'RefundPayment',
          payload: {
            refund: {
              id: uid('asof-refund'),
              originalPaymentId: uid('asof-payment'),
              paidAt: '2026-02-02',
              amount: 10000,
              reason: 'Full refund',
            },
            reverseAllocationIds: [uid('asof-allocation')],
          },
        },
      ],
      ctx(),
    );
    const corrected = apply(
      state,
      edit(state, 'add', '2026-02-01', 800, 'USD'),
    );
    expect(corrected.allocations[0]).toMatchObject({
      paymentAmount: 10000,
      periodAmount: 400,
      reversedBy: uid('asof-refund'),
    });
    expect(
      periodRemainingAsOf(corrected, corrected.periods[1], '2026-02-01'),
    ).toBe(10000);
    expect(
      periodRemainingAsOf(corrected, corrected.periods[1], '2026-02-02'),
    ).toBe(20000);
    expect(
      corrected.audit.at(-1)?.details?.reversedAllocationCorrections,
    ).toBeDefined();
  });
  it('rejects a repeated domain operation ID after a successful correction', () => {
    const state = initial(),
      command = edit(state, 'add', '2026-03-01', 11000),
      context = ctx();
    const changed = applyCommands(state, [command], context);
    expect(() => applyCommands(changed, [command], context)).toThrowError();
  });
  it('allows own editors only for their obligation and related payment history', () => {
    const state = initial();
    state.obligations[0].createdByUserId = 'owner';
    const command = edit(state, 'add', '2026-03-01', 12000);
    expect(() =>
      authorizeFamilyCommands(state, [command], {
        id: 'owner',
        role: 'own_editor',
      }),
    ).not.toThrow();
    state.payments.push({
      id: uid('foreign-payment'),
      amount: 1,
      paidAt: '2026-01-01',
      currency: 'CZK',
      payerPersonId: uid('person'),
      obligationId: uid('obligation'),
      source: 'manual',
      createdByUserId: 'other',
    });
    expect(() =>
      authorizeFamilyCommands(state, [command], {
        id: 'owner',
        role: 'own_editor',
      }),
    ).toThrowError();
    expect(() =>
      authorizeFamilyCommands(state, [command], { id: 'admin', role: 'admin' }),
    ).not.toThrow();
  });
});

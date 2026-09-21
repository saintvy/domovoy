import { describe, expect, it } from 'vitest';
import {
  applyCommands,
  createEmptyState,
  generatePeriods,
  getPeriodStatus,
  paymentOriginalRemaining,
  paymentRemaining,
  previewObligationDeletion,
  previewObligationSchedule,
  requiredExchangeRates,
  stableId,
  validateState,
  type Command,
  type CommandContext,
  type ObligationScheduleChange,
  type State,
} from '../src/domain';

const id = stableId;
let sequence = 0;
function apply(
  state: State,
  commands: Command[],
  rate = (date: string) => '1',
  extra: Partial<CommandContext> = {},
) {
  return applyCommands(state, commands, {
    actorUserId: 'creator',
    operationId: `lifecycle-${++sequence}`,
    now: '2026-09-17T12:00:00Z',
    exchangeRates: requiredExchangeRates(state, commands).map((request) => ({
      ...request,
      rate: rate(request.date),
      source: 'fixture',
    })),
    ...extra,
  });
}
function setup(currency = 'EUR', start = '2026-01-01', to = '2026-04-01') {
  return apply(createEmptyState(), [
    {
      type: 'UpdateHousehold',
      payload: { currency: 'EUR', currencies: ['EUR', 'USD'] },
    },
    { type: 'AddPerson', payload: { id: id('person'), displayName: 'Alex' } },
    {
      type: 'AddObligation',
      payload: {
        provider: { id: id('provider'), name: 'Provider', category: 'Home' },
        obligation: {
          id: id('rent'),
          providerId: id('provider'),
          title: 'Rent',
          coverageMode: 'household',
          activeFrom: start,
          lifecycleState: 'active',
          iconColor: '#AABBCC',
        },
        rule: {
          id: id('rent-rule'),
          obligationId: id('rent'),
          effectiveFrom: start,
          anchor: start,
          cadence: 'monthly',
          dueOffsetDays: 0,
          amountMode: 'fixed',
          amount: 10000,
          currency,
          graceDays: 0,
          reminderDays: 0,
        },
      },
    },
    { type: 'GeneratePeriods', payload: { from: start, to } },
  ]);
}
function schedule(
  state: State,
  patch: Partial<ObligationScheduleChange> = {},
): ObligationScheduleChange {
  const obligation = state.obligations.find((item) => item.id === id('rent'))!,
    rule = state.rules
      .filter((item) => item.obligationId === obligation.id && !item.superseded)
      .at(-1)!;
  return {
    obligationId: obligation.id,
    activeFrom: obligation.activeFrom,
    activeTo: obligation.activeTo,
    anchor: rule.anchor,
    cadence: rule.cadence,
    dueOffsetDays: rule.dueOffsetDays,
    ...patch,
  };
}
function pay(
  state: State,
  paidAt = '2026-01-15',
  amount = 15000,
  currency = 'EUR',
) {
  return apply(state, [
    {
      type: 'RecordPaymentAndAllocate',
      payload: {
        payment: {
          id: id('payment'),
          obligationId: id('rent'),
          payerPersonId: id('person'),
          paidAt,
          amount,
          currency,
          source: 'manual',
        },
        allocations: [],
      },
    },
  ]);
}
function change(
  state: State,
  patch: Partial<ObligationScheduleChange> = {},
  rate?: (date: string) => string,
) {
  return apply(
    state,
    [{ type: 'UpdateObligationSchedule', payload: schedule(state, patch) }],
    rate,
  );
}
function addOther(state: State) {
  const { createdByUserId, ...obligation } = state.obligations[0];
  return apply(state, [
    {
      type: 'AddObligation',
      payload: {
        provider: state.providers[0],
        obligation: { ...obligation, id: id('other'), title: 'Other' },
        rule: {
          ...state.rules[0],
          id: id('other-rule'),
          obligationId: id('other'),
        },
      },
    },
    {
      type: 'GeneratePeriods',
      payload: { from: '2026-01-01', to: '2026-02-01' },
    },
  ]);
}
function shared() {
  const state = addOther(setup());
  return apply(state, [
    {
      type: 'RecordPaymentAndAllocate',
      payload: {
        payment: {
          id: id('shared'),
          payerPersonId: id('person'),
          paidAt: '2026-01-15',
          amount: 20000,
          currency: 'EUR',
          source: 'manual',
        },
        allocations: [
          {
            id: id('rent-alloc'),
            billingPeriodId: state.periods[0].id,
            amount: 10000,
          },
          {
            id: id('other-alloc'),
            billingPeriodId: state.periods.find(
              (item) => item.obligationId === id('other'),
            )!.id,
            amount: 10000,
          },
        ],
      },
    },
  ]);
}

describe('obligation schedule corrections', () => {
  it('previews without mutations and restores a missing earlier calendar month', () => {
    const state = setup('EUR', '2026-10-01', '2027-01-01'),
      before = structuredClone(state),
      payload = schedule(state, {
        activeFrom: '2026-09-01',
        anchor: '2026-09-01',
      });
    const preview = previewObligationSchedule(state, payload);
    expect(state).toEqual(before);
    expect(preview.createdPeriodIds.length).toBeGreaterThan(0);
    const next = apply(state, [{ type: 'UpdateObligationSchedule', payload }]);
    expect(next.periods[0]).toMatchObject({
      periodStart: '2026-09-01',
      dueDate: '2026-09-01',
      expectedAmount: 10000,
    });
    expect(
      next.periods.find((item) => item.id === state.periods[0].id),
    ).toEqual(state.periods[0]);
    validateState(next);
  });
  it('changes weekly calendar and due offsets while retaining conservation of prepaid money', () => {
    const state = pay(setup()),
      next = change(state, {
        anchor: '2026-01-03',
        cadence: 'weekly',
        dueOffsetDays: 2,
        activeTo: '2026-02-01',
      });
    expect(next.periods[0]).toMatchObject({
      periodStart: '2026-01-03',
      dueDate: '2026-01-05',
    });
    expect(
      next.allocations.reduce((total, item) => total + item.amount, 0) +
        paymentRemaining(next, id('payment')),
    ).toBe(15000);
    expect(next.audit.at(-1)?.details?.removedPeriods).toEqual(state.periods);
    validateState(next);
  });
  it('blocks a calendar change that would silently move an existing price-version boundary', () => {
    let state = setup();
    state = apply(state, [
      {
        type: 'ChangeBillingRule',
        payload: {
          rule: {
            ...state.rules[0],
            id: id('new-price'),
            effectiveFrom: '2026-03-01',
            amount: 12000,
          },
        },
      },
    ]);
    const payload = schedule(state, { anchor: '2026-01-05' }),
      before = structuredClone(state);
    expect(previewObligationSchedule(state, payload).blockedReasons).toContain(
      'SCHEDULE_PRICE_BOUNDARY',
    );
    expect(() =>
      apply(state, [{ type: 'UpdateObligationSchedule', payload }]),
    ).toThrow();
    expect(state).toEqual(before);
    const changed = change(state, { dueOffsetDays: 3 });
    expect(
      changed.periods.find((item) => item.periodStart === '2026-03-01'),
    ).toMatchObject({ expectedAmount: 12000, dueDate: '2026-03-04' });
  });
  it('removes generated future charges on archive while retaining earlier arrears and payment history', () => {
    const state = pay(setup()),
      next = apply(state, [
        {
          type: 'ArchiveObligation',
          payload: { obligationId: id('rent'), activeTo: '2026-03-01' },
        },
      ]);
    expect(next.periods.map((item) => item.periodStart)).toEqual([
      '2026-01-01',
      '2026-02-01',
    ]);
    expect(next.payments).toEqual(state.payments);
    expect(getPeriodStatus(next, next.periods[1], '2026-09-17').remaining).toBe(
      5000,
    );
    expect(generatePeriods(next, '2026-03-01', '2027-01-01')).toEqual([]);
  });
  it.each(['2025-12-01', '2026-01-01'])(
    'cancels before/on the first date %s, preserves credit and disables automatic payments',
    (activeTo) => {
      let state = pay(setup());
      state = apply(state, [
        {
          type: 'AddAutomaticPayment',
          payload: {
            schedule: {
              id: id('auto'),
              obligationId: id('rent'),
              payerPersonId: id('person'),
              startDate: '2026-01-01',
              enabled: true,
            },
          },
        },
      ]);
      const next = apply(state, [
        {
          type: 'ArchiveObligation',
          payload: {
            obligationId: id('rent'),
            activeTo,
            outOfRangePaymentPolicy: 'keep_credit',
          },
        },
      ]);
      expect(next.obligations[0]).toMatchObject({
        activeTo: '2026-01-01',
        lifecycleState: 'archived',
      });
      expect(next.periods).toHaveLength(0);
      expect(next.allocations).toHaveLength(0);
      expect(paymentRemaining(next, id('payment'))).toBe(15000);
      expect(next.automaticPayments![0].enabled).toBe(false);
      validateState(next);
    },
  );
  it('requires an explicit out-of-range payment policy and rejects the generic end-date bypass atomically', () => {
    const state = pay(setup()),
      before = structuredClone(state);
    expect(() => change(state, { activeFrom: '2026-02-01' })).toThrow();
    expect(() =>
      apply(state, [
        {
          type: 'UpdateObligation',
          payload: {
            obligationId: id('rent'),
            patch: { activeTo: '2026-02-01' },
          },
        },
      ]),
    ).toThrow();
    expect(state).toEqual(before);
  });
  it('keep_credit retains actual dates and settles corrected charges without duplicating money', () => {
    const state = pay(setup()),
      next = change(state, {
        activeFrom: '2026-02-01',
        outOfRangePaymentPolicy: 'keep_credit',
      });
    expect(next.payments[0].paidAt).toBe('2026-01-15');
    expect(next.periods[0].periodStart).toBe('2026-02-01');
    expect(
      next.allocations
        .filter((item) => !item.reversedBy)
        .reduce((sum, item) => sum + item.paymentAmount!, 0),
    ).toBe(15000);
    expect(paymentOriginalRemaining(next, next.payments[0])).toBe(0);
    validateState(next);
  });
  it('move_inside requests the corrected historical FX date and conserves partial refund money', () => {
    let state = pay(setup('USD'), '2026-01-15', 15000, 'USD');
    state = apply(state, [
      {
        type: 'RefundPayment',
        payload: {
          refund: {
            id: id('refund'),
            originalPaymentId: id('payment'),
            paidAt: '2026-03-15',
            amount: 5000,
            reason: 'Partial refund',
          },
          reverseAllocationIds: state.allocations.map((item) => item.id),
        },
      },
    ]);
    const payload = schedule(state, {
      activeFrom: '2026-02-01',
      outOfRangePaymentPolicy: 'move_inside',
    });
    expect(
      requiredExchangeRates(state, [
        { type: 'UpdateObligationSchedule', payload },
      ]),
    ).toContainEqual({ from: 'USD', to: 'EUR', date: '2026-02-01' });
    const next = apply(
      state,
      [{ type: 'UpdateObligationSchedule', payload }],
      (date) => (date === '2026-02-01' ? '0.8' : '1'),
    );
    expect(next.payments[0]).toMatchObject({
      paidAt: '2026-02-01',
      amount: 15000,
      baseAmount: 12000,
    });
    expect(next.refunds[0]).toMatchObject({ amount: 5000, baseAmount: 4000 });
    expect(
      next.allocations
        .filter((item) => !item.reversedBy)
        .reduce((sum, item) => sum + item.amount, 0) +
        paymentRemaining(next, id('payment')) +
        next.refunds[0].baseAmount!,
    ).toBe(12000);
    validateState(next);
  });
  it('rejects moving a payment after its refund or into the future without modifying input', () => {
    let state = pay(setup());
    state = apply(state, [
      {
        type: 'RefundPayment',
        payload: {
          refund: {
            id: id('refund'),
            originalPaymentId: id('payment'),
            paidAt: '2026-01-20',
            amount: 5000,
            reason: 'Refund',
          },
          reverseAllocationIds: state.allocations.map((item) => item.id),
        },
      },
    ]);
    expect(
      previewObligationSchedule(
        state,
        schedule(state, {
          activeFrom: '2026-02-01',
          outOfRangePaymentPolicy: 'move_inside',
        }),
      ).blockedReasons,
    ).toContain('MOVE_AFTER_REFUND_DATE');
    const before = structuredClone(state);
    expect(() =>
      change(state, {
        activeFrom: '2026-02-01',
        outOfRangePaymentPolicy: 'move_inside',
      }),
    ).toThrow();
    expect(state).toEqual(before);
    const noRefund = pay(setup());
    expect(() =>
      change(noRefund, {
        activeFrom: '2026-10-01',
        outOfRangePaymentPolicy: 'move_inside',
      }),
    ).toThrow();
  });
  it('delete policy removes only out-of-range cash and its refunds and allocations', () => {
    let state = pay(setup());
    state = apply(state, [
      {
        type: 'RefundPayment',
        payload: {
          refund: {
            id: id('refund'),
            originalPaymentId: id('payment'),
            paidAt: '2026-01-20',
            amount: 5000,
            reason: 'Refund',
          },
          reverseAllocationIds: state.allocations.map((item) => item.id),
        },
      },
    ]);
    const next = change(state, {
      activeFrom: '2026-02-01',
      outOfRangePaymentPolicy: 'delete',
    });
    expect(next.payments).toHaveLength(0);
    expect(next.refunds).toHaveLength(0);
    expect(next.allocations).toHaveLength(0);
    validateState(next);
  });
  it('protects shared payments on delete/move and leaves other obligations allocated under keep_credit', () => {
    const state = shared(),
      before = structuredClone(state),
      foreign = state.allocations.find(
        (item) => item.id === id('other-alloc'),
      )!;
    for (const outOfRangePaymentPolicy of ['delete', 'move_inside'] as const)
      expect(() =>
        change(state, { activeFrom: '2026-02-01', outOfRangePaymentPolicy }),
      ).toThrow();
    expect(state).toEqual(before);
    const next = change(state, {
      activeFrom: '2026-02-01',
      outOfRangePaymentPolicy: 'keep_credit',
    });
    expect(next.allocations.find((item) => item.id === foreign.id)).toEqual(
      foreign,
    );
    expect(paymentRemaining(next, id('shared'))).toBe(10000);
    expect(next.payments[0].obligationId).toBeUndefined();
    validateState(next);
  });
  it('retains immutable audit snapshots across another schedule edit', () => {
    const first = change(setup(), { activeTo: '2026-03-01' }),
      details = structuredClone(first.audit.at(-1)!.details),
      next = change(first, { activeTo: '2026-02-01' });
    expect(next.audit.at(-2)!.details).toEqual(details);
  });
});

describe('whole obligation deletion and authoritative creators', () => {
  it('edits category and icon of a limited obligation without changing a shared provider, dates or finances', () => {
    const state = change(addOther(pay(setup())), { activeTo: '2026-03-01' }),
      other = state.obligations.find((item) => item.id === id('other'))!;
    const next = apply(state, [
      {
        type: 'UpdateObligation',
        payload: {
          obligationId: id('rent'),
          patch: {
            category: 'education',
            iconColor: '#123ABC',
            iconId: 'generic:school',
          },
        },
      },
    ]);
    expect(
      next.obligations.find((item) => item.id === id('rent')),
    ).toMatchObject({
      category: 'education',
      iconColor: '#123ABC',
      iconId: 'generic:school',
      activeFrom: '2026-01-01',
      activeTo: '2026-03-01',
      createdByUserId: 'creator',
    });
    expect(next.providers).toEqual(state.providers);
    expect(next.obligations.find((item) => item.id === id('other'))).toEqual(
      other,
    );
    expect(next.periods).toEqual(state.periods);
    expect(next.rules).toEqual(state.rules);
    expect(next.payments).toEqual(state.payments);
    expect(next.allocations).toEqual(state.allocations);
    expect(
      validateState(next).obligations.find((item) => item.id === id('rent'))!
        .category,
    ).toBe('education');
    expect(() =>
      apply(state, [
        {
          type: 'UpdateObligation',
          payload: { obligationId: id('rent'), patch: { category: '   ' } },
        },
      ]),
    ).toThrow();
  });
  it('removes related payments, refunds, periods and auto executions but preserves shared family entities', () => {
    let state = addOther(setup());
    state = apply(
      state,
      [
        {
          type: 'AddAutomaticPayment',
          payload: {
            schedule: {
              id: id('auto'),
              obligationId: id('rent'),
              payerPersonId: id('person'),
              startDate: '2026-01-01',
              enabled: true,
            },
          },
        },
        {
          type: 'ExecuteAutomaticPayments',
          payload: { through: '2026-02-01' },
        },
      ],
      undefined,
      { allowAutomaticPayments: true },
    );
    const payment = state.payments[0];
    state = apply(state, [
      {
        type: 'RefundPayment',
        payload: {
          refund: {
            id: id('refund'),
            originalPaymentId: payment.id,
            paidAt: '2026-02-15',
            amount: 1000,
            reason: 'Partial',
          },
          reverseAllocationIds: state.allocations
            .filter((item) => item.paymentId === payment.id)
            .map((item) => item.id),
        },
      },
    ]);
    const preview = previewObligationDeletion(state, id('rent')),
      next = apply(state, [
        { type: 'DeleteObligation', payload: { obligationId: id('rent') } },
      ]);
    expect(preview.paymentIds).toHaveLength(2);
    expect(preview.refundIds).toEqual([id('refund')]);
    expect(next.obligations.map((item) => item.id)).toEqual([id('other')]);
    expect(
      next.periods.every((item) => item.obligationId === id('other')),
    ).toBe(true);
    expect(next.payments).toHaveLength(0);
    expect(next.refunds).toHaveLength(0);
    expect(next.allocations).toHaveLength(0);
    expect(next.automaticPayments).toHaveLength(0);
    expect(next.automaticPaymentRuns).toHaveLength(0);
    expect(next.providers).toEqual(state.providers);
    expect(next.people).toEqual(state.people);
    validateState(next);
  });
  it('refuses full deletion if even one payment has allocations to another obligation, atomically', () => {
    const state = shared(),
      before = structuredClone(state);
    expect(
      previewObligationDeletion(state, id('rent')).sharedPaymentIds,
    ).toEqual([id('shared')]);
    expect(() =>
      apply(state, [
        { type: 'DeleteObligation', payload: { obligationId: id('rent') } },
      ]),
    ).toThrow();
    expect(state).toEqual(before);
  });
  it('sets creators from authenticated context and preserves ownership and icon color on edits', () => {
    let state = pay(setup());
    expect(state.obligations[0].createdByUserId).toBe('creator');
    expect(state.payments[0].createdByUserId).toBe('creator');
    state = apply(
      state,
      [
        {
          type: 'UpdateObligation',
          payload: {
            obligationId: id('rent'),
            patch: { title: 'New title', iconColor: '#123456' },
          },
        },
      ],
      undefined,
      { actorUserId: 'another-user' },
    );
    expect(state.obligations[0]).toMatchObject({
      createdByUserId: 'creator',
      iconColor: '#123456',
    });
    state = apply(
      state,
      [
        {
          type: 'AddAutomaticPayment',
          payload: {
            schedule: {
              id: id('auto'),
              obligationId: id('rent'),
              payerPersonId: id('person'),
              startDate: '2026-03-01',
              enabled: true,
            },
          },
        },
      ],
      undefined,
      { actorUserId: 'schedule-owner' },
    );
    state = apply(
      state,
      [
        {
          type: 'ExecuteAutomaticPayments',
          payload: { through: '2026-03-01' },
        },
      ],
      undefined,
      { allowAutomaticPayments: true, actorUserId: 'system' },
    );
    expect(state.automaticPayments![0].createdByUserId).toBe('schedule-owner');
    expect(
      state.payments.find((item) => item.source === 'automatic')!
        .createdByUserId,
    ).toBe('schedule-owner');
    expect(() =>
      apply(state, [
        {
          type: 'RecordPaymentAndAllocate',
          payload: {
            payment: {
              id: id('spoof'),
              payerPersonId: id('person'),
              amount: 100,
              currency: 'EUR',
              paidAt: '2026-01-01',
              source: 'manual',
              createdByUserId: 'victim',
            },
            allocations: [],
          },
        },
      ]),
    ).toThrow('createdByUserId');
    expect(() =>
      apply(state, [
        {
          type: 'UpdateObligation',
          payload: {
            obligationId: id('rent'),
            patch: { createdByUserId: 'victim' } as never,
          },
        },
      ]),
    ).toThrow('createdByUserId');
  });
});

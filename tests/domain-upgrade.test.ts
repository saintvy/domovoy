import { describe, expect, it } from 'vitest';
import {
  applyCommands,
  checksum,
  convertMinorAmount,
  createEmptyState,
  exportPeriodCsv,
  generatePeriods,
  getPeriodStatus,
  monthlyFinancialSeries,
  obligationCredit,
  paymentOriginalRemaining,
  paymentRemaining,
  periodRemainingAsOf,
  previewCsv,
  requiredExchangeRates,
  stableId,
  validateExport,
  validateState,
  type Command,
  type CommandContext,
  type State,
} from '../src/domain';

const id = stableId;
let sequence = 0;
const context = (extra: Partial<CommandContext> = {}): CommandContext => ({
  actorUserId: 'test',
  operationId: 'upgrade-' + ++sequence,
  now: '2026-09-15T12:00:00Z',
  ...extra,
});
function apply(
  state: State,
  commands: Command[],
  rate: (from: string, to: string, date: string) => string = () => '1',
  extra: Partial<CommandContext> = {},
): State {
  return applyCommands(
    state,
    commands,
    context({
      exchangeRates: requiredExchangeRates(state, commands).map((request) => ({
        ...request,
        rate: rate(request.from, request.to, request.date),
        source: 'test-fixture',
      })),
      ...extra,
    }),
  );
}
function setup(
  currency = 'EUR',
  cadence: 'monthly' | 'weekly' = 'monthly',
  to = '2026-02-01',
): State {
  return apply(
    createEmptyState(),
    [
      {
        type: 'UpdateHousehold',
        payload: {
          currency: 'EUR',
          currencies: ['EUR', 'USD', 'GBP', 'JPY', 'KWD'],
        },
      },
      {
        type: 'AddPerson',
        payload: { id: id('alice'), displayName: 'Alice', color: '#E879A7' },
      },
      {
        type: 'AddPerson',
        payload: { id: id('bob'), displayName: 'Bob', color: '#3B82F6' },
      },
      {
        type: 'AddObligation',
        payload: {
          provider: {
            id: id('provider'),
            name: 'Provider',
            category: 'Family',
          },
          obligation: {
            id: id('obligation'),
            providerId: id('provider'),
            title: 'Kindergarten',
            coverageMode: 'household',
            beneficiaries: { kind: 'people', personIds: [id('alice')] },
            activeFrom: '2026-01-01',
            lifecycleState: 'active',
          },
          rule: {
            id: id('rule'),
            obligationId: id('obligation'),
            effectiveFrom: '2026-01-01',
            anchor: '2026-01-01',
            cadence,
            dueOffsetDays: 0,
            amountMode: 'fixed',
            amount: 10000,
            currency,
            graceDays: 0,
            reminderDays: 0,
          },
        },
      },
      { type: 'GeneratePeriods', payload: { from: '2026-01-01', to } },
    ],
    (from) => (from === 'USD' ? '0.9' : from === 'GBP' ? '1.2' : '1'),
  );
}
function pay(
  state: State,
  amount: number,
  currency = 'EUR',
  paidAt = '2026-01-20',
  rate: (from: string, to: string, date: string) => string = () => '1',
) {
  return apply(
    state,
    [
      {
        type: 'RecordPaymentAndAllocate',
        payload: {
          payment: {
            id: id('payment-' + sequence),
            obligationId: id('obligation'),
            payerPersonId: id('bob'),
            amount,
            currency,
            paidAt,
            source: 'manual',
          },
          allocations: [],
        },
      },
    ],
    rate,
  );
}

describe('beneficiaries, weekly schedules and end dates', () => {
  it('keeps household selection distinct from explicit people and makes responsibility optional', () => {
    let state = apply(setup(), [
      { type: 'UpdateHousehold', payload: { color: '#64748B' } },
    ]);
    expect(state.obligations[0].ownerPersonId).toBeUndefined();
    let point = monthlyFinancialSeries(state, '2026-01', '2026-01')[0];
    expect(point.byBeneficiary[0]).toMatchObject({
      key: 'household',
      amount: 0,
      color: '#64748B',
    });
    expect(
      point.byBeneficiary.find((bucket) => bucket.key === id('alice')),
    ).toMatchObject({ amount: 10000, color: '#E879A7' });
    state = apply(state, [
      {
        type: 'UpdateObligation',
        payload: {
          obligationId: id('obligation'),
          patch: {
            beneficiaries: {
              kind: 'people',
              personIds: [id('alice'), id('bob')],
            },
            iconId: 'generic:school',
          },
        },
      },
    ]);
    point = monthlyFinancialSeries(state, '2026-01', '2026-01')[0];
    expect(point.byBeneficiary[0].amount).toBe(10000);
    state = apply(state, [
      {
        type: 'UpdateObligation',
        payload: {
          obligationId: id('obligation'),
          patch: { beneficiaries: { kind: 'household' } },
        },
      },
      {
        type: 'UpdatePerson',
        payload: { personId: id('alice'), patch: { color: '#10B981' } },
      },
    ]);
    expect(state.obligations[0].beneficiaries).toEqual({ kind: 'household' });
    expect(state.people[0].color).toBe('#10B981');
  });
  it('rejects unknown and duplicate beneficiaries', () => {
    const state = setup();
    for (const personIds of [[id('missing')], [id('alice'), id('alice')]])
      expect(() =>
        apply(state, [
          {
            type: 'UpdateObligation',
            payload: {
              obligationId: id('obligation'),
              patch: { beneficiaries: { kind: 'people', personIds } },
            },
          },
        ]),
      ).toThrow();
  });
  it('weekly periods stop at exclusive end date while earlier arrears remain', () => {
    let state = setup('EUR', 'weekly', '2026-01-02');
    state = apply(state, [
      {
        type: 'UpdateObligationSchedule',
        payload: {
          obligationId: id('obligation'),
          activeFrom: '2026-01-01',
          activeTo: '2026-01-22',
          anchor: '2026-01-01',
          cadence: 'weekly',
          dueOffsetDays: 0,
        },
      },
      {
        type: 'GeneratePeriods',
        payload: { from: '2026-01-01', to: '2026-04-01' },
      },
    ]);
    expect(state.periods.map((period) => period.periodStart)).toEqual([
      '2026-01-01',
      '2026-01-08',
      '2026-01-15',
    ]);
    expect(
      monthlyFinancialSeries(state, '2026-02', '2026-02')[0],
    ).toMatchObject({ obligationsTotal: 0, arrearsTotal: 30000 });
  });
  it('weekly rule changes require a seven-day boundary and support switching cadence there', () => {
    const state = setup('EUR', 'weekly', '2026-01-08');
    const rule = {
      ...state.rules[0],
      id: id('rule-next'),
      effectiveFrom: '2026-01-08',
      anchor: '2026-01-08',
      cadence: 'monthly' as const,
      amount: 12000,
    };
    const next = apply(state, [
      { type: 'ChangeBillingRule', payload: { rule } },
      {
        type: 'GeneratePeriods',
        payload: { from: '2026-01-08', to: '2026-03-01' },
      },
    ]);
    expect(next.periods.map((period) => period.periodStart)).toEqual([
      '2026-01-01',
      '2026-01-08',
      '2026-02-08',
    ]);
    expect(() =>
      apply(state, [
        {
          type: 'ChangeBillingRule',
          payload: {
            rule: {
              ...rule,
              effectiveFrom: '2026-01-09',
              anchor: '2026-01-09',
            },
          },
        },
      ]),
    ).toThrow('границе');
  });
});

describe('original-denomination settlement and historical currency values', () => {
  it('100 USD settles a 100 USD obligation even when payment and due-date EUR rates differ', () => {
    const state = pay(setup('USD'), 10000, 'USD', '2026-01-20', () => '1.1');
    expect(state.periods[0].baseExpectedAmount).toBe(9000);
    expect(state.payments[0].baseAmount).toBe(11000);
    expect(state.allocations[0]).toMatchObject({
      amount: 11000,
      paymentAmount: 10000,
      periodAmount: 10000,
    });
    expect(
      getPeriodStatus(state, state.periods[0], '2026-02-01'),
    ).toMatchObject({ settlementState: 'paid', remaining: 0 });
    expect(obligationCredit(state, id('obligation'))).toBe(0);
  });
  it('true overpayment carries to new periods without being altered by FX movements', () => {
    let state = pay(setup('USD'), 25000, 'USD', '2026-01-20', () => '1.1');
    const paymentId = state.payments[0].id;
    expect(paymentOriginalRemaining(state, state.payments[0])).toBe(15000);
    expect(paymentRemaining(state, paymentId)).toBe(16500);
    state = apply(
      state,
      [
        {
          type: 'GeneratePeriods',
          payload: { from: '2026-02-01', to: '2026-04-01' },
        },
      ],
      (_from, _to, date) => (date === '2026-01-20' ? '1.1' : '0.8'),
    );
    expect(
      state.allocations.map((allocation) => allocation.periodAmount),
    ).toEqual([10000, 10000, 5000]);
    expect(paymentOriginalRemaining(state, state.payments[0])).toBe(0);
    expect(paymentRemaining(state, paymentId)).toBe(0);
    expect(
      getPeriodStatus(state, state.periods[2], '2026-04-01').remaining,
    ).toBe(4000);
  });
  it('cross-currency coverage uses the payment-date pair, while preserving actual base cash value', () => {
    const rates = (from: string, to: string) =>
      from === 'USD' && to === 'GBP' ? '0.8' : from === 'USD' ? '0.9' : '1.2';
    const state = pay(setup('GBP'), 12500, 'USD', '2026-01-20', rates);
    expect(state.allocations[0]).toMatchObject({
      paymentAmount: 12500,
      periodAmount: 10000,
      amount: 11250,
    });
    expect(state.periods[0].baseExpectedAmount).toBe(12000);
    expect(
      getPeriodStatus(state, state.periods[0], '2026-02-01').remaining,
    ).toBe(0);
    const requests = requiredExchangeRates(setup('GBP'), [
      {
        type: 'RecordPaymentAndAllocate',
        payload: {
          payment: {
            id: id('cross'),
            payerPersonId: id('bob'),
            obligationId: id('obligation'),
            paidAt: '2026-01-20',
            amount: 12500,
            currency: 'USD',
            source: 'manual',
          },
          allocations: [],
        },
      },
    ]);
    expect(requests).toContainEqual({
      from: 'USD',
      to: 'GBP',
      date: '2026-01-20',
    });
  });
  it('base currency changes revalue originals without changing obligation currency or settlement', () => {
    let state = pay(setup('USD'), 10000, 'USD', '2026-01-20', () => '1.1');
    state = apply(
      state,
      [{ type: 'UpdateHousehold', payload: { currency: 'GBP' } }],
      (_from, _to, date) => (date === '2026-01-20' ? '0.8' : '0.7'),
    );
    expect(state.payments[0]).toMatchObject({
      amount: 10000,
      currency: 'USD',
      baseAmount: 8000,
      baseCurrency: 'GBP',
    });
    expect(state.rules[0].currency).toBe('USD');
    expect(state.allocations[0]).toMatchObject({
      amount: 8000,
      paymentAmount: 10000,
      periodAmount: 10000,
    });
    expect(
      getPeriodStatus(state, state.periods[0], '2026-02-01').remaining,
    ).toBe(0);
    state = apply(
      state,
      [{ type: 'UpdateHousehold', payload: { currency: 'EUR' } }],
      (_from, _to, date) => (date === '2026-01-20' ? '1.1' : '0.9'),
    );
    expect(state.payments[0].baseAmount).toBe(11000);
    expect(state.allocations[0].amount).toBe(11000);
  });
  it('requires server quotes and rejects client-calculated conversion fields or future cash payments', () => {
    const state = setup('USD'),
      payment = {
        id: id('untrusted'),
        obligationId: id('obligation'),
        payerPersonId: id('bob'),
        amount: 10000,
        currency: 'USD',
        paidAt: '2026-01-20',
        source: 'manual' as const,
      };
    expect(() =>
      applyCommands(
        state,
        [
          {
            type: 'RecordPaymentAndAllocate',
            payload: { payment, allocations: [] },
          },
        ],
        context(),
      ),
    ).toThrow('курс');
    expect(() =>
      applyCommands(
        state,
        [
          {
            type: 'RecordPaymentAndAllocate',
            payload: {
              payment: { ...payment, baseAmount: 1 },
              allocations: [],
            },
          },
        ],
        context(),
      ),
    ).toThrow('baseAmount');
    expect(() => pay(state, 10000, 'USD', '2027-01-01')).toThrow('будущем');
  });
  it('uses exact integer conversion across 0/2/3 decimal currencies and rejects overflow', () => {
    expect(convertMinorAmount(100, 'JPY', 'EUR', '0.00625')).toBe(63);
    expect(convertMinorAmount(1234, 'KWD', 'EUR', '3')).toBe(370);
    expect(convertMinorAmount(100, 'EUR', 'JPY', '160.5')).toBe(161);
    expect(convertMinorAmount(1, 'EUR', 'EUR', '0.5')).toBe(1);
    expect(() =>
      convertMinorAmount(Number.MAX_SAFE_INTEGER, 'EUR', 'EUR', '2'),
    ).toThrow('диапазона');
  });
  it('conserves both original and base money when tiny amounts round to zero and are refunded', () => {
    let state = setup('USD');
    state.periods[0].expectedAmount = 1;
    state.periods[0].baseExpectedAmount = 1;
    state.periods[0].exchangeRate = '0.5';
    const second = {
      ...state.periods[0],
      id: id('tiny-second'),
      periodStart: '2026-02-01',
      periodEnd: '2026-03-01',
      dueDate: '2026-02-01',
      exchangeRateDate: '2026-02-01',
    };
    state.periods.push(second);
    state = pay(state, 2, 'USD', '2026-01-20', () => '0.5');
    expect(state.payments[0].baseAmount).toBe(1);
    expect(state.allocations.map((allocation) => allocation.amount)).toEqual([
      1, 0,
    ]);
    expect(
      state.allocations.map((allocation) => allocation.periodAmount),
    ).toEqual([1, 1]);
    const zeroBase = state.allocations[1];
    state = apply(
      state,
      [
        {
          type: 'RefundPayment',
          payload: {
            refund: {
              id: id('tiny-refund'),
              originalPaymentId: state.payments[0].id,
              paidAt: '2026-02-10',
              amount: 1,
              reason: 'One original cent',
            },
            reverseAllocationIds: [zeroBase.id],
          },
        },
      ],
      () => '0.5',
    );
    expect(state.refunds[0].baseAmount).toBe(0);
    expect(paymentOriginalRemaining(state, state.payments[0])).toBe(0);
    expect(paymentRemaining(state, state.payments[0].id)).toBe(0);
    expect(getPeriodStatus(state, second, '2026-03-01')).toMatchObject({
      settlementState: 'unpaid',
      remaining: 1,
    });
  });
  it('does not fetch FX for an unrelated person color change', () => {
    const state = pay(setup('GBP'), 15000, 'USD', '2026-01-20', (_from, to) =>
      to === 'GBP' ? '0.8' : '0.9',
    );
    expect(
      requiredExchangeRates(state, [
        {
          type: 'UpdatePerson',
          payload: { personId: id('alice'), patch: { color: '#FFFFFF' } },
        },
      ]),
    ).toEqual([]);
  });
});

describe('automatic schedules and as-of reports', () => {
  const schedule = {
    id: id('automatic'),
    obligationId: id('obligation'),
    payerPersonId: id('bob'),
    startDate: '2026-01-01',
    enabled: true,
  };
  it('executes each due period once, survives retries and leaves historical payments when deleted', () => {
    let state = apply(setup(), [
      { type: 'AddAutomaticPayment', payload: { schedule } },
    ]);
    state = apply(
      state,
      [
        {
          type: 'ExecuteAutomaticPayments',
          payload: { through: '2026-03-15' },
        },
      ],
      () => '1',
      { allowAutomaticPayments: true },
    );
    expect(state.payments).toHaveLength(3);
    expect(state.automaticPaymentRuns).toHaveLength(3);
    state = apply(
      state,
      [
        {
          type: 'ExecuteAutomaticPayments',
          payload: { through: '2026-03-15' },
        },
      ],
      () => '1',
      { allowAutomaticPayments: true },
    );
    expect(state.payments).toHaveLength(3);
    state = apply(
      state,
      [
        {
          type: 'DeleteAutomaticPayment',
          payload: { scheduleId: schedule.id },
        },
        {
          type: 'ExecuteAutomaticPayments',
          payload: { through: '2026-04-15' },
        },
      ],
      () => '1',
      { allowAutomaticPayments: true },
    );
    expect(state.automaticPayments).toHaveLength(0);
    expect(state.payments).toHaveLength(3);
    expect(state.automaticPaymentRuns).toHaveLength(3);
    state = apply(state, [
      {
        type: 'GeneratePeriods',
        payload: { from: '2026-04-01', to: '2026-05-01' },
      },
    ]);
    expect(
      monthlyFinancialSeries(state, '2026-04', '2026-04')[0].arrearsTotal,
    ).toBe(10000);
  });
  it('uses prepaid original credit before generating another automatic payment and rejects browser execution', () => {
    let state = pay(setup(), 20000);
    state = apply(state, [
      { type: 'AddAutomaticPayment', payload: { schedule } },
    ]);
    expect(() =>
      apply(state, [
        {
          type: 'ExecuteAutomaticPayments',
          payload: { through: '2026-03-01' },
        },
      ]),
    ).toThrow('только сервер');
    state = apply(
      state,
      [
        {
          type: 'ExecuteAutomaticPayments',
          payload: { through: '2026-03-01' },
        },
      ],
      () => '1',
      { allowAutomaticPayments: true },
    );
    expect(state.payments).toHaveLength(2);
    expect(state.automaticPaymentRuns?.map((run) => run.status)).toEqual([
      'covered',
      'covered',
      'paid',
    ]);
  });
  it('a backdated payment reduces the corresponding old arrears, not just the current month', () => {
    let state = setup();
    expect(
      monthlyFinancialSeries(state, '2026-01', '2026-02').map(
        (point) => point.arrearsTotal,
      ),
    ).toEqual([10000, 10000]);
    state = pay(state, 10000, 'EUR', '2026-01-20');
    expect(
      monthlyFinancialSeries(state, '2026-01', '2026-02').map(
        (point) => point.arrearsTotal,
      ),
    ).toEqual([0, 0]);
    const later = pay(setup(), 10000, 'EUR', '2026-02-20');
    expect(
      monthlyFinancialSeries(later, '2026-01', '2026-02').map(
        (point) => point.arrearsTotal,
      ),
    ).toEqual([10000, 0]);
  });
  it('refund replacement is effective on the refund date and does not distort earlier history', () => {
    let state = pay(setup('USD'), 10000, 'USD', '2026-01-20', () => '1.1');
    const payment = state.payments[0],
      allocation = state.allocations[0];
    state = apply(
      state,
      [
        {
          type: 'RefundPayment',
          payload: {
            refund: {
              id: id('refund-fx'),
              originalPaymentId: payment.id,
              paidAt: '2026-02-10',
              amount: 5000,
              reason: 'Returned half',
            },
            reverseAllocationIds: [allocation.id],
            replacementAllocations: [
              {
                id: id('refund-replacement'),
                billingPeriodId: state.periods[0].id,
                amount: 5500,
              },
            ],
          },
        },
      ],
      () => '1.1',
    );
    expect(state.refunds[0].baseAmount).toBe(5500);
    expect(state.allocations[1]).toMatchObject({
      amount: 5500,
      paymentAmount: 5000,
      periodAmount: 5000,
      effectiveDate: '2026-02-10',
    });
    expect(periodRemainingAsOf(state, state.periods[0], '2026-01-31')).toBe(0);
    expect(periodRemainingAsOf(state, state.periods[0], '2026-02-28')).toBe(
      4500,
    );
    expect(paymentRemaining(state, payment.id)).toBe(0);
  });
  it('exports only selected dates, includes original/base currencies, and escapes spreadsheet formulas', () => {
    let state = pay(setup(), 10000);
    state = apply(state, [
      {
        type: 'UpdateObligation',
        payload: {
          obligationId: id('obligation'),
          patch: { title: '=HYPERLINK("bad")' },
        },
      },
    ]);
    const report = exportPeriodCsv(state, {
      from: '2026-01-01',
      toInclusive: '2026-01-31',
    });
    expect(report.paymentsCsv).toContain('"original_currency"');
    expect(report.paymentsCsv).toContain('2026-01-20');
    expect(report.obligationsCsv).toContain("'=HYPERLINK");
    expect(
      exportPeriodCsv(state, { from: '2026-02-01', toInclusive: '2026-02-28' })
        .paymentsCsv,
    ).not.toContain('2026-01-20');
  });
  it('verifies old export checksums before additive migration and keeps original financial amounts', async () => {
    const legacy = structuredClone(setup());
    delete legacy.automaticPayments;
    delete legacy.automaticPaymentRuns;
    delete legacy.household.currencies;
    delete legacy.household.color;
    for (const person of legacy.people) delete person.color;
    for (const obligation of legacy.obligations)
      delete obligation.beneficiaries;
    for (const period of legacy.periods) {
      delete period.baseExpectedAmount;
      delete period.baseCurrency;
      delete period.exchangeRate;
      delete period.exchangeRateDate;
      delete period.exchangeRateSource;
    }
    const exported = {
      format: 'domovoy-export',
      schemaVersion: 1,
      state: legacy,
      checksum: await checksum(legacy),
    };
    const migrated = await validateExport(exported);
    expect(migrated.automaticPayments).toEqual([]);
    expect(migrated.household.color).toBe('#94A3B8');
    expect(migrated.people[0].color).toMatch(/^#/);
    expect(migrated.periods[0].expectedAmount).toBe(10000);
    expect(migrated.periods[0].baseExpectedAmount).toBe(10000);
  });
  it('CSV preview accepts configured foreign currencies while authoritative import requires quotes', () => {
    const state = setup();
    const preview = previewCsv(
      'date;amount;currency\n2026-01-20;100.00;USD',
      state,
      id('bob'),
    );
    expect(preview.validCount).toBe(1);
    expect(() =>
      applyCommands(
        state,
        [
          {
            type: 'ImportPayments',
            payload: { payments: [preview.rows[0].payment!] },
          },
        ],
        context(),
      ),
    ).toThrow('курс');
  });
});

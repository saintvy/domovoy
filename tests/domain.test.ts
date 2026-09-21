import { describe, expect, it } from 'vitest';
import {
  addMonths,
  applyCommands,
  createDemoState,
  createEmptyState,
  currencyMinorDigits,
  exportPaymentsCsv,
  exportState,
  formatMoney,
  generatePeriods,
  getPeriodStatus,
  moneyInputValue,
  parseCsv,
  parseMoney,
  paymentRemaining,
  previewCsv,
  stableId,
  validateExport,
  validateState,
  type Command,
  type State,
} from '../src/domain';

const id = stableId;
const context = (operationId: string) => ({
  actorUserId: 'test-admin',
  operationId,
  now: '2026-09-07T10:00:00Z',
});
function setup(
  anchor = '2026-01-31',
  cadence: 'monthly' | 'quarterly' | 'yearly' = 'monthly',
  amountMode: 'fixed' | 'estimate' = 'fixed',
): State {
  return applyCommands(
    createEmptyState(),
    [
      { type: 'AddPerson', payload: { id: id('person'), displayName: 'Alex' } },
      {
        type: 'AddObligation',
        payload: {
          provider: { id: id('provider'), name: 'Provider', category: 'Home' },
          obligation: {
            id: id('obligation'),
            providerId: id('provider'),
            title: 'Rent',
            coverageMode: 'household',
            ownerPersonId: id('person'),
            activeFrom: anchor,
            lifecycleState: 'active',
          },
          rule: {
            id: id('rule'),
            obligationId: id('obligation'),
            effectiveFrom: anchor,
            anchor,
            cadence,
            dueOffsetDays: 0,
            amountMode,
            amount: 10000,
            currency: 'CZK',
            reminderDays: 3,
            graceDays: 2,
          },
        },
      },
      { type: 'GeneratePeriods', payload: { from: anchor, to: '2027-04-01' } },
    ],
    context('setup'),
  );
}
function payment(
  state: State,
  amount: number,
  allocated: number,
  operationId = 'payment',
): State {
  return applyCommands(
    state,
    [
      {
        type: 'RecordPaymentAndAllocate',
        payload: {
          payment: {
            id: id(operationId),
            paidAt: '2026-02-01',
            amount,
            currency: 'CZK',
            payerPersonId: id('person'),
            source: 'manual',
          },
          allocations: allocated
            ? [
                {
                  id: id(`${operationId}-allocation`),
                  billingPeriodId: state.periods[0].id,
                  amount: allocated,
                },
              ]
            : [],
        },
      },
    ],
    context(operationId),
  );
}

describe('calendar and independent statuses', () => {
  it('preserves Jan 31 anchor through February and leap years', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-01-31', 2)).toBe('2026-03-31');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2024-02-29', 12)).toBe('2025-02-28');
  });
  it('generates deterministic half-open periods without duplicate revisions', () => {
    const s = setup();
    expect(s.periods.slice(0, 3).map((p) => p.periodStart)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
    ]);
    expect(
      generatePeriods(s, '2026-02-01', '2026-04-01').map((p) => p.id),
    ).toEqual(s.periods.slice(0, 3).map((p) => p.id));
    const twice = applyCommands(
      s,
      [
        {
          type: 'GeneratePeriods',
          payload: { from: '2026-01-31', to: '2027-04-01' },
        },
      ],
      context('again'),
    );
    expect(twice.periods).toEqual(s.periods);
  });
  it('generates quarterly and anniversary yearly periods', () => {
    expect(
      setup('2026-01-31', 'quarterly')
        .periods.slice(0, 2)
        .map((x) => x.periodStart),
    ).toEqual(['2026-01-31', '2026-04-30']);
    expect(
      setup('2024-02-29', 'yearly').periods.map((x) => x.periodStart),
    ).toEqual(['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28']);
  });
  it('keeps partial and overdue independent and observes grace days', () => {
    const s = payment(setup(), 4000, 4000);
    expect(getPeriodStatus(s, s.periods[0], '2026-02-02')).toMatchObject({
      settlementState: 'partial',
      timingState: 'due',
      remaining: 6000,
    });
    expect(getPeriodStatus(s, s.periods[0], '2026-02-03')).toMatchObject({
      settlementState: 'partial',
      timingState: 'overdue',
    });
  });
  it('never marks estimates paid until amount confirmation', () => {
    const s = payment(setup('2026-01-31', 'monthly', 'estimate'), 10000, 10000);
    expect(getPeriodStatus(s, s.periods[0], '2026-02-03').settlementState).toBe(
      'undetermined',
    );
    const confirmed = applyCommands(
      s,
      [
        {
          type: 'ConfirmPeriodAmount',
          payload: { periodId: s.periods[0].id, amount: 10000 },
        },
      ],
      context('confirm'),
    );
    expect(
      getPeriodStatus(confirmed, confirmed.periods[0], '2026-02-03'),
    ).toMatchObject({ settlementState: 'paid', needsAction: false });
  });
  it('waivers explain settlement without changing payment history', () => {
    const s = setup();
    const waived = applyCommands(
      s,
      [
        {
          type: 'WaivePeriod',
          payload: { periodId: s.periods[0].id, reason: 'Provider credit' },
        },
      ],
      context('waive'),
    );
    expect(
      getPeriodStatus(waived, waived.periods[0], '2026-09-07').settlementState,
    ).toBe('waived');
    expect(waived.payments).toHaveLength(0);
  });
  it('new prices update generated unpaid periods from the selected boundary and preserve earlier periods', () => {
    const s = setup();
    const changed = applyCommands(
      s,
      [
        {
          type: 'ChangeBillingRule',
          payload: {
            rule: {
              ...s.rules[0],
              id: id('rule-v2'),
              effectiveFrom: '2026-03-31',
              amount: 20000,
            },
          },
        },
      ],
      context('price'),
    );
    expect(changed.periods.slice(0, 2)).toEqual(s.periods.slice(0, 2));
    expect(
      changed.periods
        .slice(2)
        .every((period) => period.expectedAmount === 20000),
    ).toBe(true);
    expect(changed.periods.map((period) => period.id)).toEqual(
      s.periods.map((period) => period.id),
    );
    const future = generatePeriods(changed, '2027-04-01', '2027-07-01');
    expect(
      future.find((p) => p.periodStart === '2027-04-30')?.expectedAmount,
    ).toBe(20000);
  });
  it('rejects price changes inside an existing period', () => {
    const s = setup();
    expect(() =>
      applyCommands(
        s,
        [
          {
            type: 'ChangeBillingRule',
            payload: {
              rule: {
                ...s.rules[0],
                id: id('rule-v2'),
                effectiveFrom: '2026-03-15',
                amount: 20000,
              },
            },
          },
        ],
        context('price'),
      ),
    ).toThrow('границе');
  });
  it('archive stops future generation and preserves existing history', () => {
    const s = setup();
    const changed = applyCommands(
      s,
      [
        {
          type: 'ArchiveObligation',
          payload: { obligationId: id('obligation'), activeTo: '2027-04-01' },
        },
      ],
      context('archive'),
    );
    expect(generatePeriods(changed, '2027-05-01', '2028-01-01')).toHaveLength(
      0,
    );
    expect(changed.periods).toEqual(s.periods);
  });
});

describe('financial invariants and atomicity', () => {
  it('payment alone does not close a period', () => {
    const s = payment(setup(), 10000, 0);
    expect(getPeriodStatus(s, s.periods[0], '2026-09-07').settlementState).toBe(
      'unpaid',
    );
    expect(paymentRemaining(s, id('payment'))).toBe(10000);
  });
  it('rejects two allocations of 700 against payment of 1000 atomically', () => {
    const s = setup();
    const original = JSON.stringify(s);
    expect(() =>
      applyCommands(
        s,
        [
          {
            type: 'RecordPaymentAndAllocate',
            payload: {
              payment: {
                id: id('bad'),
                paidAt: '2026-02-01',
                amount: 1000,
                currency: 'CZK',
                payerPersonId: id('person'),
                source: 'manual',
              },
              allocations: [
                { id: id('a1'), billingPeriodId: s.periods[0].id, amount: 700 },
                { id: id('a2'), billingPeriodId: s.periods[1].id, amount: 700 },
              ],
            },
          },
        ],
        context('bad'),
      ),
    ).toThrow('превышают');
    expect(JSON.stringify(s)).toBe(original);
  });
  it('supports two payers and split payments', () => {
    let s = payment(setup(), 7000, 7000);
    s = applyCommands(
      s,
      [
        {
          type: 'AddPerson',
          payload: { id: id('person2'), displayName: 'Maria' },
        },
        {
          type: 'RecordPaymentAndAllocate',
          payload: {
            payment: {
              id: id('p2'),
              paidAt: '2026-02-02',
              amount: 13000,
              currency: 'CZK',
              payerPersonId: id('person2'),
              source: 'manual',
            },
            allocations: [
              { id: id('p2a'), billingPeriodId: s.periods[0].id, amount: 3000 },
              {
                id: id('p2b'),
                billingPeriodId: s.periods[1].id,
                amount: 10000,
              },
            ],
          },
        },
      ],
      context('p2'),
    );
    expect(
      s.periods
        .slice(0, 2)
        .map((p) => getPeriodStatus(s, p, '2026-09-07').settlementState),
    ).toEqual(['paid', 'paid']);
  });
  it('partial refund reverses old allocation and replaces it without double subtraction', () => {
    const s = payment(setup(), 15000, 10000);
    const after = applyCommands(
      s,
      [
        {
          type: 'RefundPayment',
          payload: {
            refund: {
              id: id('refund'),
              originalPaymentId: id('payment'),
              paidAt: '2026-02-03',
              amount: 7000,
              reason: 'Partial return',
            },
            reverseAllocationIds: [id('payment-allocation')],
            replacementAllocations: [
              {
                id: id('replacement'),
                billingPeriodId: s.periods[0].id,
                amount: 8000,
              },
            ],
          },
        },
      ],
      context('refund'),
    );
    expect(paymentRemaining(after, id('payment'))).toBe(0);
    expect(after.payments[0].amount).toBe(15000);
    expect(after.allocations).toHaveLength(2);
    expect(
      getPeriodStatus(after, after.periods[0], '2026-09-07').allocated,
    ).toBe(8000);
  });
  it('rejects refund that fails to reverse allocated funds', () => {
    const s = payment(setup(), 10000, 10000);
    expect(() =>
      applyCommands(
        s,
        [
          {
            type: 'RefundPayment',
            payload: {
              refund: {
                id: id('refund'),
                originalPaymentId: id('payment'),
                paidAt: '2026-02-03',
                amount: 1,
                reason: 'Return',
              },
              reverseAllocationIds: [],
            },
          },
        ],
        context('refund'),
      ),
    ).toThrow('превышают');
  });
  it('enforces money conservation across a range of partial payments', () => {
    for (let n = 1; n <= 100; n++) {
      const total = n * 137,
        allocated = Math.floor(total * 0.6),
        s = payment(setup(), total, allocated, `p-${n}`);
      expect(
        paymentRemaining(s, id(`p-${n}`)) +
          getPeriodStatus(s, s.periods[0], '2026-09-07').allocated,
      ).toBe(total);
    }
  });
  it('rejects duplicated operation effects and base changes without historical rates', () => {
    const s = payment(setup(), 10000, 0);
    expect(() => payment(s, 10000, 0)).toThrow('уже применена');
    expect(() =>
      applyCommands(
        setup(),
        [{ type: 'UpdateHousehold', payload: { currency: 'EUR' } }],
        context('currency'),
      ),
    ).toThrow('курс');
  });
  it('rejects malformed command payloads, fractional minor units and broken references', () => {
    expect(() =>
      applyCommands(
        setup(),
        [
          {
            type: 'AddPerson',
            payload: { id: id('p3'), displayName: 'X', role: 'admin' },
          },
        ],
        context('invalid'),
      ),
    ).toThrow();
    expect(() => payment(setup(), 1.5, 0)).toThrow();
    const s = setup();
    s.obligations[0].ownerPersonId = id('missing');
    expect(() => validateState(s)).toThrow('не найден');
  });
  it('rejects overlapping seats but allows consecutive assignments', () => {
    const base = setup();
    base.obligations[0].coverageMode = 'multi_account';
    base.obligations[0].seatCapacity = 1;
    base.entitlements = [
      {
        id: id('seat1'),
        obligationId: id('obligation'),
        personId: id('person'),
        seatNo: 1,
        validFrom: '2026-01-01',
        validTo: '2026-02-01',
      },
      {
        id: id('seat2'),
        obligationId: id('obligation'),
        personId: id('person'),
        seatNo: 1,
        validFrom: '2026-02-01',
      },
    ];
    expect(() => validateState(base)).not.toThrow();
    base.entitlements[1].validFrom = '2026-01-31';
    expect(() => validateState(base)).toThrow('занято');
  });
});

describe('CSV and portable verified exports', () => {
  it('parses decimal input exactly and rejects ambiguous precision', () => {
    expect(parseMoney('1 234,56')).toBe(123456);
    expect(parseMoney('0.01')).toBe(1);
    for (const value of ['-1', '1.234', 'NaN', '1e3', '900719925474099.99'])
      expect(() => parseMoney(value)).toThrow();
  });
  it('uses currency minor digits and never loses a minor unit near the safe limit', () => {
    expect(currencyMinorDigits('JPY')).toBe(0);
    expect(currencyMinorDigits('KWD')).toBe(3);
    expect(parseMoney('1234', 'JPY')).toBe(1234);
    expect(() => parseMoney('12.50', 'JPY')).toThrow();
    expect(parseMoney('12.345', 'KWD')).toBe(12345);
    expect(() => parseMoney('12.3456', 'KWD')).toThrow();
    expect(parseMoney('90071992547409.91')).toBe(Number.MAX_SAFE_INTEGER);
    expect(moneyInputValue(Number.MAX_SAFE_INTEGER)).toBe('90071992547409.91');
    expect(moneyInputValue(12345, 'KWD')).toBe('12.345');
    expect(formatMoney(12345, 'JPY', 'en-US')).toBe('¥12,345');
    expect(formatMoney(12345, 'KWD', 'en-US')).toContain('12.345');
  });
  it('parses quoted separators, quotes and newlines', () => {
    expect(parseCsv('date;description\r\n2026-09-01;"A; ""B""\nC"')).toEqual([
      ['date', 'description'],
      ['2026-09-01', 'A; "B"\nC'],
    ]);
    expect(() => parseCsv('date;description\n2026-09-01;"oops')).toThrow();
  });
  it('previews wrong currencies and duplicates and requires explicit import', () => {
    const s = setup();
    const csv =
      'date;amount;currency;description;reference\n2026-09-01;12,50;CZK;Test;abc\n2026-09-01;12,50;CZK;Test;abc\n2026-09-02;10;EUR;Other;def';
    const preview = previewCsv(csv, s, id('person'));
    expect(preview).toMatchObject({
      validCount: 1,
      duplicateCount: 1,
      errorCount: 1,
    });
    expect(s.payments).toHaveLength(0);
    const imported = applyCommands(
      s,
      [
        {
          type: 'ImportPayments',
          payload: { payments: [preview.rows[0].payment!] },
        },
      ],
      context('import'),
    );
    expect(previewCsv(csv, imported, id('person')).validCount).toBe(0);
    expect(() =>
      applyCommands(
        imported,
        [
          {
            type: 'ImportPayments',
            payload: { payments: [preview.rows[0].payment!] },
          },
        ],
        context('again'),
      ),
    ).toThrow('импортирован');
  });
  it('allows two legitimate identical charges without references after preview confirmation', () => {
    const s = setup(),
      csv =
        'date;amount;description\n2026-09-01;10;Coffee\n2026-09-01;10;Coffee';
    const preview = previewCsv(csv, s, id('person'));
    expect(preview.validCount).toBe(2);
    expect(preview.rows.map((r) => [r.duplicate, r.possibleDuplicate])).toEqual(
      [
        [false, false],
        [false, true],
      ],
    );
    const imported = applyCommands(
      s,
      [
        {
          type: 'ImportPayments',
          payload: { payments: preview.rows.map((r) => r.payment!) },
        },
      ],
      context('identical-charges'),
    );
    expect(imported.payments).toHaveLength(2);
    expect(previewCsv(csv, imported, id('person')).duplicateCount).toBe(2);
    const reorderedFile = csv + '\n';
    expect(
      previewCsv(reorderedFile, imported, id('person')).rows.every(
        (r) => !r.duplicate && r.possibleDuplicate,
      ),
    ).toBe(true);
  });
  it('scopes definitive external references to source and account', () => {
    const s = setup(),
      csv =
        'date;amount;reference;account\n2026-09-01;10;ref;bank-a\n2026-09-01;10;ref;bank-b';
    const preview = previewCsv(csv, s, id('person'));
    expect(preview.validCount).toBe(2);
    expect(
      applyCommands(
        s,
        [
          {
            type: 'ImportPayments',
            payload: { payments: preview.rows.map((r) => r.payment!) },
          },
        ],
        context('scoped-refs'),
      ).payments,
    ).toHaveLength(2);
  });
  it('neutralizes spreadsheet formulas in exported free-text fields', () => {
    for (const descriptor of [
      '=1+1',
      '+SUM(1,2)',
      '-1+2',
      '@SUM(A1)',
      '\t=1',
      '\r=1',
      '  =1',
    ]) {
      const s = payment(setup(), 100, 0);
      s.payments[0].descriptor = descriptor;
      s.payments[0].externalRef = descriptor;
      s.payments[0].sourceAccountId = descriptor;
      const cells = parseCsv(exportPaymentsCsv(s))[1];
      expect(cells.slice(3)).toEqual([
        `'${descriptor}`,
        `'${descriptor}`,
        `'${descriptor}`,
      ]);
    }
  });
  it('round-trips JPY and KWD CSV amounts in their own minor units', () => {
    for (const currency of ['JPY', 'KWD']) {
      const s = createEmptyState();
      s.household.currency = currency;
      s.people = [{ id: id('person'), displayName: 'Alex' }];
      s.payments = [
        {
          id: id('currency-payment'),
          paidAt: '2026-09-01',
          amount: 12345,
          currency,
          payerPersonId: id('person'),
          source: 'manual',
        },
      ];
      const target = { ...s, payments: [] };
      expect(
        previewCsv(exportPaymentsCsv(s), target, id('person')).rows[0].payment
          ?.amount,
      ).toBe(12345);
    }
  });
  it('round trips full state and detects financial tampering', async () => {
    const s = createDemoState('2026-09-07');
    const exported = await exportState(s);
    expect(await validateExport(JSON.stringify(exported))).toEqual(s);
    exported.state.payments[0].amount++;
    await expect(validateExport(exported)).rejects.toThrow('сумма');
  });
  it('exports CSV that previews back and preserves descriptions', () => {
    const s = createDemoState('2026-09-07');
    const target = createEmptyState();
    target.people = s.people;
    const result = previewCsv(exportPaymentsCsv(s), target, s.people[0].id);
    expect(result.errorCount).toBe(0);
    expect(result.validCount).toBe(s.payments.length);
  });
});

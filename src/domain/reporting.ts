import type { BillingPeriod, State } from './types';
import { addDays, addMonths, DEFAULT_HOUSEHOLD_COLOR, safeSum } from './core';
import {
  convertMinorAmount,
  paymentBaseAmount,
  periodBaseAmount,
} from './currency';
import { ensure, isISODate } from './validation';
import { moneyInputValue } from './import-export';

export interface MonthlyFinancialPoint {
  month: string;
  obligationsTotal: number;
  arrearsTotal: number;
  unconvertedCount: number;
  byBeneficiary: {
    key: string;
    label: string;
    color: string;
    amount: number;
  }[];
}
function allocationsAsOf(state: State, asOf: string): Map<string, number> {
  const payments = new Map(
    state.payments.map((payment) => [payment.id, payment]),
  );
  const refunds = new Map(state.refunds.map((refund) => [refund.id, refund]));
  const allocated = new Map<string, number>();
  for (const allocation of state.allocations)
    if (
      (payments.get(allocation.paymentId)?.paidAt ?? '9999') <= asOf &&
      (!allocation.effectiveDate || allocation.effectiveDate <= asOf) &&
      (!allocation.reversedBy ||
        (refunds.get(allocation.reversedBy)?.paidAt ?? '0000') > asOf)
    ) {
      allocated.set(
        allocation.billingPeriodId,
        safeSum([
          allocated.get(allocation.billingPeriodId) ?? 0,
          allocation.periodAmount ?? allocation.amount,
        ]),
      );
    }
  return allocated;
}
function remainingAsOf(
  state: State,
  period: BillingPeriod,
  asOf: string,
  allocated: Map<string, number>,
): number | undefined {
  const expected = periodBaseAmount(state, period);
  if (expected === undefined || !period.amountConfirmed) return;
  if (period.waiver && period.waiver.createdAt.slice(0, 10) <= asOf) return 0;
  const original = Math.max(
    0,
    (period.expectedAmount ?? expected) - (allocated.get(period.id) ?? 0),
  );
  const rule = state.rules.find((rule) => rule.id === period.ruleVersionId);
  return rule && period.exchangeRate
    ? convertMinorAmount(
        original,
        rule.currency,
        state.household.currency,
        period.exchangeRate,
      )
    : original;
}
export function periodRemainingAsOf(
  state: State,
  period: BillingPeriod,
  asOf: string,
): number | undefined {
  return remainingAsOf(state, period, asOf, allocationsAsOf(state, asOf));
}
/** Monthly plans use billing due dates; arrears are the balance at each month end, using the actual (possibly backdated) payment date. */
export function monthlyFinancialSeries(
  state: State,
  fromMonth: string,
  toMonthInclusive: string,
): MonthlyFinancialPoint[] {
  ensure(
    /^\d{4}-\d{2}$/.test(fromMonth) &&
      /^\d{4}-\d{2}$/.test(toMonthInclusive) &&
      isISODate(fromMonth + '-01') &&
      isISODate(toMonthInclusive + '-01') &&
      fromMonth <= toMonthInclusive,
    'INVALID_DATE_RANGE',
    'Неверный диапазон месяцев',
  );
  const size =
    (Number(toMonthInclusive.slice(0, 4)) - Number(fromMonth.slice(0, 4))) *
      12 +
    Number(toMonthInclusive.slice(5)) -
    Number(fromMonth.slice(5)) +
    1;
  ensure(
    size <= 300,
    'RANGE_TOO_LARGE',
    'Для графика доступно не более 25 лет',
  );
  const obligations = new Map(
    state.obligations.map((obligation) => [obligation.id, obligation]),
  );
  const rules = new Map(state.rules.map((rule) => [rule.id, rule]));
  const points: MonthlyFinancialPoint[] = [];
  for (let offset = 0; offset < size; offset++) {
    const start = addMonths(fromMonth + '-01', offset),
      next = addMonths(start, 1),
      end = addDays(next, -1);
    const allocated = allocationsAsOf(state, end);
    const byBeneficiary = [
      {
        key: 'household',
        label:
          state.household.locale === 'en'
            ? 'Household / shared'
            : 'Семья / совместные',
        color: state.household.color ?? DEFAULT_HOUSEHOLD_COLOR,
        amount: 0,
      },
      ...state.people.map((person) => ({
        key: person.id,
        label: person.displayName,
        color: person.color ?? '#3B82F6',
        amount: 0,
      })),
    ];
    const buckets = new Map(
      byBeneficiary.map((bucket) => [bucket.key, bucket]),
    );
    let arrearsTotal = 0,
      unconvertedCount = 0;
    for (const period of state.periods) {
      const amount = periodBaseAmount(state, period);
      if (
        period.dueDate >= start &&
        period.dueDate < next &&
        !(period.waiver && period.waiver.createdAt.slice(0, 10) <= end)
      ) {
        if (amount === undefined) unconvertedCount++;
        else {
          const beneficiaries = obligations.get(
            period.obligationId,
          )?.beneficiaries;
          const key =
            beneficiaries?.kind === 'people' &&
            beneficiaries.personIds.length === 1
              ? beneficiaries.personIds[0]
              : 'household';
          const bucket = buckets.get(key) ?? buckets.get('household')!;
          bucket.amount = safeSum([bucket.amount, amount]);
        }
      }
      if (
        addDays(
          period.dueDate,
          rules.get(period.ruleVersionId)?.graceDays ?? 0,
        ) < end
      ) {
        const remaining = remainingAsOf(state, period, end, allocated);
        if (remaining !== undefined)
          arrearsTotal = safeSum([arrearsTotal, remaining]);
      }
    }
    points.push({
      month: start.slice(0, 7),
      byBeneficiary,
      obligationsTotal: safeSum(byBeneficiary.map((bucket) => bucket.amount)),
      arrearsTotal,
      unconvertedCount,
    });
  }
  return points;
}
function csv(rows: (string | number)[][]): string {
  return (
    '\uFEFF' +
    rows
      .map((row) =>
        row
          .map((value) => {
            const text = String(value),
              safe = /^[\s]*[=+\-@]|^[\t\r\n]/.test(text) ? "'" + text : text;
            return '"' + safe.replace(/"/g, '""') + '"';
          })
          .join(';'),
      )
      .join('\r\n')
  );
}
export function exportPeriodCsv(
  state: State,
  range: { from: string; toInclusive: string },
): { obligationsCsv: string; paymentsCsv: string } {
  ensure(
    isISODate(range.from) &&
      isISODate(range.toInclusive) &&
      range.from <= range.toInclusive,
    'INVALID_DATE_RANGE',
    'Неверный период отчёта',
  );
  const obligations = new Map(
      state.obligations.map((obligation) => [obligation.id, obligation]),
    ),
    people = new Map(
      state.people.map((person) => [person.id, person.displayName]),
    ),
    rules = new Map(state.rules.map((rule) => [rule.id, rule]));
  const allocated = allocationsAsOf(state, range.toInclusive);
  const obligationsCsv = csv([
    [
      'obligation',
      'beneficiaries',
      'responsible',
      'period_start',
      'period_end',
      'due_date',
      'original_amount',
      'original_currency',
      'base_amount',
      'base_currency',
      'remaining_as_of',
      'as_of',
    ],
    ...state.periods
      .filter(
        (period) =>
          period.dueDate >= range.from && period.dueDate <= range.toInclusive,
      )
      .sort(
        (a, b) =>
          a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id),
      )
      .map((period) => {
        const obligation = obligations.get(period.obligationId),
          currency =
            rules.get(period.ruleVersionId)?.currency ??
            state.household.currency,
          base = periodBaseAmount(state, period),
          remaining = remainingAsOf(
            state,
            period,
            range.toInclusive,
            allocated,
          );
        const beneficiaries = obligation?.beneficiaries;
        return [
          obligation?.title ?? period.obligationId,
          beneficiaries?.kind === 'people'
            ? beneficiaries.personIds
                .map((id) => people.get(id) ?? id)
                .join(', ')
            : 'Household',
          people.get(obligation?.ownerPersonId ?? '') ?? '',
          period.periodStart,
          period.periodEnd,
          period.dueDate,
          period.expectedAmount === undefined
            ? ''
            : moneyInputValue(period.expectedAmount, currency),
          currency,
          base === undefined
            ? ''
            : moneyInputValue(base, state.household.currency),
          state.household.currency,
          remaining === undefined
            ? ''
            : moneyInputValue(remaining, state.household.currency),
          range.toInclusive,
        ];
      }),
  ]);
  const paymentsCsv = csv([
    [
      'date',
      'obligation',
      'payer',
      'original_amount',
      'original_currency',
      'base_amount',
      'base_currency',
      'exchange_rate',
      'rate_date',
      'rate_source',
      'source',
      'description',
    ],
    ...state.payments
      .filter(
        (payment) =>
          payment.paidAt >= range.from && payment.paidAt <= range.toInclusive,
      )
      .sort(
        (a, b) => a.paidAt.localeCompare(b.paidAt) || a.id.localeCompare(b.id),
      )
      .map((payment) => [
        payment.paidAt,
        obligations.get(payment.obligationId ?? '')?.title ?? '',
        people.get(payment.payerPersonId) ?? '',
        moneyInputValue(payment.amount, payment.currency),
        payment.currency,
        moneyInputValue(paymentBaseAmount(payment), state.household.currency),
        state.household.currency,
        payment.exchangeRate ?? '1',
        payment.exchangeRateDate ?? payment.paidAt,
        payment.exchangeRateSource ?? 'identity',
        payment.source,
        payment.descriptor ?? '',
      ]),
  ]);
  return { obligationsCsv, paymentsCsv };
}

import type {
  BaseValuation,
  BillingPeriod,
  CommandContext,
  ExchangeRate,
  Payment,
  State,
} from './types';
import { ensure } from './validation';
import { currencyMinorDigits } from './import-export';

export function decimalRate(rate: string): {
  numerator: bigint;
  denominator: bigint;
} {
  ensure(
    /^\d{1,20}(\.\d{1,18})?$/.test(rate),
    'INVALID_EXCHANGE_RATE',
    'Курс должен быть положительным десятичным числом',
  );
  const [whole, fraction = ''] = rate.split('.');
  const numerator = BigInt(whole + fraction),
    denominator = 10n ** BigInt(fraction.length);
  ensure(
    numerator > 0n,
    'INVALID_EXCHANGE_RATE',
    'Курс должен быть положительным',
  );
  return { numerator, denominator };
}
function checked(value: bigint): number {
  ensure(
    value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER),
    'MONEY_RANGE',
    'Результат конвертации вне безопасного диапазона',
  );
  return Number(value);
}
/** Integer arithmetic, round half up; no binary floating point money. Rate is target major units/source major unit. */
export function convertMinorAmount(
  amount: number,
  from: string,
  to: string,
  rate: string,
): number {
  ensure(
    Number.isSafeInteger(amount) && amount >= 0,
    'MONEY_RANGE',
    'Неверная сумма',
  );
  const { numerator, denominator } = decimalRate(rate);
  const top =
    BigInt(amount) * numerator * 10n ** BigInt(currencyMinorDigits(to));
  const bottom = denominator * 10n ** BigInt(currencyMinorDigits(from));
  return checked((top + bottom / 2n) / bottom);
}
/** Smallest whole source minor-unit amount sufficient to cover target minor units. */
export function sourceMinorForTarget(
  target: number,
  from: string,
  to: string,
  rate: string,
  maximumSource?: number,
): number {
  const { numerator, denominator } = decimalRate(rate);
  const top =
    BigInt(target) * denominator * 10n ** BigInt(currencyMinorDigits(from));
  const bottom = numerator * 10n ** BigInt(currencyMinorDigits(to));
  const result = (top + bottom - 1n) / bottom;
  return checked(
    maximumSource === undefined
      ? result
      : result > BigInt(maximumSource)
        ? BigInt(maximumSource)
        : result,
  );
}
const rateIndexes = new WeakMap<
  CommandContext,
  { rates: ExchangeRate[] | undefined; index: Map<string, ExchangeRate[]> }
>();
function indexedRates(context: CommandContext): Map<string, ExchangeRate[]> {
  const cached = rateIndexes.get(context);
  if (cached && cached.rates === context.exchangeRates) return cached.index;
  const index = new Map<string, ExchangeRate[]>();
  for (const rate of context.exchangeRates ?? []) {
    const key = `${rate.from}:${rate.to}:${rate.date}`,
      group = index.get(key);
    if (group) group.push(rate);
    else index.set(key, [rate]);
  }
  rateIndexes.set(context, { rates: context.exchangeRates, index });
  return index;
}
export function valueInBase(
  amount: number,
  currency: string,
  date: string,
  base: string,
  context: CommandContext,
): Required<BaseValuation> {
  if (currency === base)
    return {
      baseAmount: amount,
      baseCurrency: base,
      exchangeRate: '1',
      exchangeRateDate: date,
      exchangeRateSource: 'identity',
    };
  const matches =
    indexedRates(context).get(`${currency}:${base}:${date}`) ?? [];
  ensure(
    matches.length > 0,
    'EXCHANGE_RATE_REQUIRED',
    `Нужен подтверждённый сервером курс ${currency}/${base} на ${date}`,
  );
  const quote = matches[0];
  ensure(
    matches.every(
      (other) => other.rate === quote.rate && other.source === quote.source,
    ),
    'EXCHANGE_RATE_CONFLICT',
    'Источники курса расходятся',
  );
  ensure(
    typeof quote.source === 'string' &&
      quote.source.length > 0 &&
      quote.source.length <= 250,
    'INVALID_EXCHANGE_RATE',
    'Не указан источник курса',
  );
  return {
    baseAmount: convertMinorAmount(amount, currency, base, quote.rate),
    baseCurrency: base,
    exchangeRate: quote.rate,
    exchangeRateDate: date,
    exchangeRateSource: quote.source,
  };
}
export const paymentBaseAmount = (payment: Payment) =>
  payment.baseAmount ?? payment.amount;
export function periodBaseAmount(period: BillingPeriod): number | undefined;
export function periodBaseAmount(
  state: State,
  period: BillingPeriod,
): number | undefined;
export function periodBaseAmount(
  stateOrPeriod: State | BillingPeriod,
  period?: BillingPeriod,
): number | undefined {
  if (!period)
    return (
      (stateOrPeriod as BillingPeriod).baseExpectedAmount ??
      (stateOrPeriod as BillingPeriod).expectedAmount
    );
  const state = stateOrPeriod as State;
  return period.baseCurrency === state.household.currency &&
    period.baseExpectedAmount !== undefined
    ? period.baseExpectedAmount
    : state.rules.find((rule) => rule.id === period.ruleVersionId)?.currency ===
        state.household.currency
      ? period.expectedAmount
      : undefined;
}
export function valuePayment(
  payment: Payment,
  state: State,
  context: CommandContext,
): Payment {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: state.household.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(context.now));
  ensure(
    payment.paidAt <= today,
    'PAYMENT_IN_FUTURE',
    'Дата выполненного платежа не может быть в будущем',
  );
  return {
    ...payment,
    ...valueInBase(
      payment.amount,
      payment.currency,
      payment.paidAt,
      state.household.currency,
      context,
    ),
  };
}
export function valuePeriod(
  period: BillingPeriod,
  state: State,
  context: CommandContext,
): void {
  if (period.expectedAmount === undefined) return;
  const rule = state.rules.find((rule) => rule.id === period.ruleVersionId);
  ensure(rule, 'BROKEN_REFERENCE', 'Правило начисления не найдено');
  const { baseAmount, ...valuation } = valueInBase(
    period.expectedAmount,
    rule.currency,
    period.dueDate,
    state.household.currency,
    context,
  );
  Object.assign(period, valuation, { baseExpectedAmount: baseAmount });
}
/** Recompute historical payment values from ORIGINAL amounts. Repeated base changes never compound original-money rounding. */
export function changeBaseCurrency(
  state: State,
  base: string,
  context: CommandContext,
): void {
  const previous = state.household.currency;
  const refundGroups = new Map<string, typeof state.refunds>(),
    allocationGroups = new Map<string, typeof state.allocations>();
  for (const refund of state.refunds) {
    const group = refundGroups.get(refund.originalPaymentId);
    if (group) group.push(refund);
    else refundGroups.set(refund.originalPaymentId, [refund]);
  }
  for (const allocation of state.allocations) {
    const group = allocationGroups.get(allocation.paymentId);
    if (group) group.push(allocation);
    else allocationGroups.set(allocation.paymentId, [allocation]);
  }
  for (const payment of state.payments) {
    Object.assign(
      payment,
      valueInBase(
        payment.amount,
        payment.currency,
        payment.paidAt,
        base,
        context,
      ),
    );
    const refunds = refundGroups.get(payment.id) ?? [];
    // Refunds use the original payment's booked rate, preserving original-money conservation.
    let priorOriginal = 0,
      priorBase = 0;
    for (const refund of refunds.sort(
      (a, b) => a.paidAt.localeCompare(b.paidAt) || a.id.localeCompare(b.id),
    )) {
      priorOriginal += refund.amount;
      const cumulative = convertMinorAmount(
        priorOriginal,
        payment.currency,
        base,
        payment.exchangeRate!,
      );
      refund.baseAmount = cumulative - priorBase;
      priorBase = cumulative;
    }
    const allocations = allocationGroups.get(payment.id) ?? [],
      active = allocations.filter((allocation) => !allocation.reversedBy);
    const originalAllocated = active.reduce(
      (sum, allocation) =>
        sum + (allocation.paymentAmount ?? allocation.amount),
      0,
    );
    const target = Math.min(
      paymentBaseAmount(payment) - priorBase,
      convertMinorAmount(
        originalAllocated,
        payment.currency,
        base,
        payment.exchangeRate!,
      ),
    );
    let assigned = 0;
    const sorted = active
      .map((allocation) => ({
        allocation,
        numerator:
          BigInt(allocation.paymentAmount ?? allocation.amount) *
          BigInt(target),
      }))
      .sort((a, b) =>
        originalAllocated === 0
          ? 0
          : Number(
              (b.numerator % BigInt(originalAllocated)) -
                (a.numerator % BigInt(originalAllocated)),
            ) || a.allocation.id.localeCompare(b.allocation.id),
      );
    for (const row of sorted) {
      row.allocation.amount =
        originalAllocated === 0
          ? 0
          : Number(row.numerator / BigInt(originalAllocated));
      assigned += row.allocation.amount;
    }
    for (let i = 0; assigned < target; i++, assigned++)
      sorted[i % sorted.length].allocation.amount++;
    for (const allocation of allocations.filter(
      (allocation) => allocation.reversedBy,
    )) {
      allocation.amount = convertMinorAmount(
        allocation.paymentAmount ?? allocation.amount,
        payment.currency,
        base,
        payment.exchangeRate!,
      );
    }
  }
  state.household.currency = base;
  state.household.currencies = [
    ...new Set([
      base,
      previous,
      ...(state.household.currencies ?? []),
      ...state.rules.map((rule) => rule.currency),
      ...state.payments.map((payment) => payment.currency),
    ]),
  ];
  for (const period of state.periods) valuePeriod(period, state, context);
  // periodAmount/paymentAmount are original minor units; a base change never changes settlement.
}

import type {
  Allocation,
  BillingPeriod,
  CommandContext,
  Payment,
  State,
} from './types';
import {
  addDays,
  createFinancialIndex,
  generatePeriods,
  householdToday,
  paymentRemaining,
  safeSum,
  stableId,
} from './core';
import {
  convertMinorAmount,
  periodBaseAmount,
  sourceMinorForTarget,
  valueInBase,
  valuePayment,
  valuePeriod,
} from './currency';
import { ensure } from './validation';

/** Allocate an obligation's existing balance in due-date order. Unlinked legacy payments remain manually allocated. */
export function paymentOriginalRemaining(
  state: State,
  payment: Payment,
): number {
  return (
    payment.amount -
    safeSum(
      state.refunds
        .filter((refund) => refund.originalPaymentId === payment.id)
        .map((refund) => refund.amount),
    ) -
    safeSum(
      state.allocations
        .filter(
          (allocation) =>
            allocation.paymentId === payment.id && !allocation.reversedBy,
        )
        .map((allocation) => allocation.paymentAmount ?? allocation.amount),
    )
  );
}
export function periodOriginalAllocated(
  state: State,
  period: BillingPeriod,
): number {
  return safeSum(
    state.allocations
      .filter(
        (allocation) =>
          allocation.billingPeriodId === period.id && !allocation.reversedBy,
      )
      .map((allocation) => allocation.periodAmount ?? allocation.amount),
  );
}
interface SettlementIndex {
  baseRemaining: Map<string, number>;
  originalRemaining: Map<string, number>;
  covered: Map<string, number>;
  rules: Map<string, State['rules'][number]>;
}
function settlementIndex(state: State): SettlementIndex {
  const baseRemaining = new Map(
    state.payments.map((payment) => [
      payment.id,
      payment.baseAmount ?? payment.amount,
    ]),
  );
  const originalRemaining = new Map(
    state.payments.map((payment) => [payment.id, payment.amount]),
  );
  const covered = new Map<string, number>();
  for (const refund of state.refunds) {
    baseRemaining.set(
      refund.originalPaymentId,
      (baseRemaining.get(refund.originalPaymentId) ?? 0) -
        (refund.baseAmount ?? refund.amount),
    );
    originalRemaining.set(
      refund.originalPaymentId,
      (originalRemaining.get(refund.originalPaymentId) ?? 0) - refund.amount,
    );
  }
  for (const allocation of state.allocations)
    if (!allocation.reversedBy) {
      baseRemaining.set(
        allocation.paymentId,
        (baseRemaining.get(allocation.paymentId) ?? 0) - allocation.amount,
      );
      originalRemaining.set(
        allocation.paymentId,
        (originalRemaining.get(allocation.paymentId) ?? 0) -
          (allocation.paymentAmount ?? allocation.amount),
      );
      covered.set(
        allocation.billingPeriodId,
        safeSum([
          covered.get(allocation.billingPeriodId) ?? 0,
          allocation.periodAmount ?? allocation.amount,
        ]),
      );
    }
  return {
    baseRemaining,
    originalRemaining,
    covered,
    rules: new Map(state.rules.map((rule) => [rule.id, rule])),
  };
}
/** Store both original denominations and consumed base value. Exchange-rate movements never create a fictitious debt. */
export function allocateToPeriod(
  state: State,
  payment: Payment,
  period: BillingPeriod,
  context: CommandContext,
  options: {
    id: string;
    baseBudget?: number;
    effectiveDate?: string;
    index?: SettlementIndex;
  },
): Allocation | undefined {
  const originalAvailable = options.index
      ? (options.index.originalRemaining.get(payment.id) ?? 0)
      : paymentOriginalRemaining(state, payment),
    baseAvailable = options.index
      ? (options.index.baseRemaining.get(payment.id) ?? 0)
      : paymentRemaining(state, payment.id);
  if (options.baseBudget !== undefined)
    ensure(
      options.baseBudget <= baseAvailable,
      'OVER_ALLOCATED',
      'Распределения и возвраты превышают платёж',
    );
  const expected = period.expectedAmount;
  if (
    expected === undefined ||
    (!period.amountConfirmed && options.baseBudget === undefined) ||
    period.waiver ||
    originalAvailable <= 0
  )
    return;
  const remaining = Math.max(
    0,
    expected -
      (options.index
        ? (options.index.covered.get(period.id) ?? 0)
        : periodOriginalAllocated(state, period)),
  );
  if (!remaining) return;
  const rule = options.index
    ? options.index.rules.get(period.ruleVersionId)
    : state.rules.find((rule) => rule.id === period.ruleVersionId);
  ensure(rule, 'BROKEN_REFERENCE', 'Правило начисления не найдено');
  const rate =
    payment.currency === rule.currency
      ? '1'
      : rule.currency === state.household.currency
        ? payment.exchangeRate!
        : valueInBase(
            1,
            payment.currency,
            payment.paidAt,
            rule.currency,
            context,
          ).exchangeRate;
  const originalBudget =
    options.baseBudget === undefined || options.baseBudget === baseAvailable
      ? originalAvailable
      : baseAvailable === 0
        ? 0
        : Number(
            (BigInt(originalAvailable) * BigInt(options.baseBudget)) /
              BigInt(baseAvailable),
          );
  const paymentAmount = sourceMinorForTarget(
    remaining,
    payment.currency,
    rule.currency,
    rate,
    originalBudget,
  );
  const periodAmount = Math.min(
    remaining,
    convertMinorAmount(paymentAmount, payment.currency, rule.currency, rate),
  );
  if (!paymentAmount || !periodAmount) return;
  const amount =
    paymentAmount === originalAvailable
      ? baseAvailable
      : Math.min(
          options.baseBudget ?? baseAvailable,
          convertMinorAmount(
            paymentAmount,
            payment.currency,
            state.household.currency,
            payment.exchangeRate!,
          ),
        );
  return {
    id: options.id,
    paymentId: payment.id,
    billingPeriodId: period.id,
    amount,
    paymentAmount,
    periodAmount,
    createdAt: context.now,
    ...(options.effectiveDate ? { effectiveDate: options.effectiveDate } : {}),
  };
}
export function settleObligationCredits(
  state: State,
  context: CommandContext,
  obligationId?: string,
): void {
  const index = settlementIndex(state);
  const payments = state.payments
    .filter(
      (payment) =>
        payment.obligationId &&
        (!obligationId || payment.obligationId === obligationId),
    )
    .sort(
      (a, b) => a.paidAt.localeCompare(b.paidAt) || a.id.localeCompare(b.id),
    );
  const periods = new Map<string, typeof state.periods>();
  for (const period of state.periods
    .filter((period) => period.amountConfirmed && !period.waiver)
    .sort(
      (a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id),
    )) {
    const group = periods.get(period.obligationId);
    if (group) group.push(period);
    else periods.set(period.obligationId, [period]);
  }
  for (const payment of payments) {
    if ((index.originalRemaining.get(payment.id) ?? 0) <= 0) continue;
    for (const period of periods.get(payment.obligationId!) ?? []) {
      if ((index.originalRemaining.get(payment.id) ?? 0) <= 0) break;
      const allocation = allocateToPeriod(state, payment, period, context, {
        id: stableId(
          `${context.operationId}:credit:${payment.id}:${period.id}:${state.allocations.length}`,
        ),
        index,
      });
      if (allocation) {
        state.allocations.push(allocation);
        index.baseRemaining.set(
          payment.id,
          (index.baseRemaining.get(payment.id) ?? 0) - allocation.amount,
        );
        index.originalRemaining.set(
          payment.id,
          (index.originalRemaining.get(payment.id) ?? 0) -
            allocation.paymentAmount!,
        );
        index.covered.set(
          period.id,
          (index.covered.get(period.id) ?? 0) + allocation.periodAmount!,
        );
      }
    }
  }
}
export function obligationCredit(state: State, obligationId: string): number {
  const index = createFinancialIndex(state);
  return safeSum(
    state.payments
      .filter((payment) => payment.obligationId === obligationId)
      .map((payment) => paymentRemaining(state, payment.id, index)),
  );
}
export function automaticGenerationWindow(
  state: State,
  through: string,
): { from: string; to: string } | undefined {
  const schedules = (state.automaticPayments ?? []).filter(
    (schedule) => schedule.enabled && schedule.startDate <= through,
  );
  if (!schedules.length) return;
  const from = schedules.reduce(
    (from, schedule) => (schedule.startDate < from ? schedule.startDate : from),
    through,
  );
  const advance = Math.max(
    0,
    ...state.rules
      .filter((rule) =>
        schedules.some(
          (schedule) => schedule.obligationId === rule.obligationId,
        ),
      )
      .map((rule) => -rule.dueOffsetDays),
  );
  // Include starts after today when the debit is due before the service period begins.
  return { from: addDays(from, -366), to: addDays(through, advance + 1) };
}
/** Called exclusively inside the authoritative server transaction. A run survives schedule deletion as a receipt. */
export function executeAutomaticPayments(
  state: State,
  through: string,
  context: CommandContext,
): void {
  ensure(
    context.allowAutomaticPayments === true,
    'AUTOMATIC_PAYMENT_SERVER_ONLY',
    'Автоплатежи запускает только сервер',
  );
  ensure(
    through <= householdToday(state, new Date(context.now)),
    'AUTOMATIC_PAYMENT_FUTURE',
    'Нельзя выполнить автоплатёж за будущую дату',
  );
  const window = automaticGenerationWindow(state, through);
  if (!window) return;
  const existing = new Set(state.periods.map((period) => period.id));
  for (const period of generatePeriods(state, window.from, window.to))
    if (!existing.has(period.id)) {
      valuePeriod(period, state, context);
      state.periods.push(period);
      existing.add(period.id);
    }
  settleObligationCredits(state, context);
  state.automaticPaymentRuns ??= [];
  const runs = new Set(
    state.automaticPaymentRuns.map(
      (run) => `${run.scheduleId}:${run.periodId}`,
    ),
  );
  for (const schedule of state.automaticPayments ?? []) {
    if (!schedule.enabled) continue;
    const obligation = state.obligations.find(
      (obligation) => obligation.id === schedule.obligationId,
    );
    ensure(
      obligation,
      'BROKEN_REFERENCE',
      'Обязательство автоплатежа не найдено',
    );
    const periods = state.periods
      .filter(
        (period) =>
          period.obligationId === schedule.obligationId &&
          period.dueDate >= schedule.startDate &&
          period.dueDate <= through &&
          (!schedule.endDate || period.dueDate <= schedule.endDate) &&
          (!obligation.activeTo || period.periodStart < obligation.activeTo),
      )
      .sort(
        (a, b) =>
          a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id),
      );
    for (const period of periods) {
      const key = `${schedule.id}:${period.id}`;
      if (
        runs.has(key) ||
        !period.amountConfirmed ||
        period.expectedAmount === undefined
      )
        continue;
      const paid = periodOriginalAllocated(state, period);
      const expected = period.expectedAmount;
      ensure(
        expected !== undefined,
        'EXCHANGE_RATE_REQUIRED',
        'Не сохранён курс начисления',
      );
      const id = stableId(`automatic-run:${key}`);
      if (period.waiver || paid >= expected) {
        state.automaticPaymentRuns.push({
          id,
          scheduleId: schedule.id,
          periodId: period.id,
          paidAt: period.dueDate,
          status: 'covered',
        });
        runs.add(key);
        continue;
      }
      const rule = state.rules.find(
        (rule) => rule.id === period.ruleVersionId,
      )!;
      const currency = schedule.currency ?? rule.currency;
      // An explicit fixed automatic amount is charged as configured. The default covers the remaining due amount.
      let amount = schedule.amount;
      if (amount === undefined) {
        ensure(
          currency === rule.currency,
          'AUTOMATIC_PAYMENT_AMOUNT_REQUIRED',
          'Для другой валюты автоплатежа укажите сумму',
        );
        amount = expected - paid;
      }
      if (amount === 0) {
        state.automaticPaymentRuns.push({
          id,
          scheduleId: schedule.id,
          periodId: period.id,
          paidAt: period.dueDate,
          status: 'covered',
        });
        runs.add(key);
        continue;
      }
      const payment = valuePayment(
        {
          id: stableId(`automatic-payment:${key}`),
          obligationId: obligation.id,
          automaticScheduleId: schedule.id,
          paidAt: period.dueDate,
          amount,
          currency,
          payerPersonId: schedule.payerPersonId,
          createdByUserId: schedule.createdByUserId ?? context.actorUserId,
          source: 'automatic',
          externalRef: key,
          descriptor: obligation.title,
        },
        state,
        context,
      );
      state.payments.push(payment);
      state.automaticPaymentRuns.push({
        id,
        scheduleId: schedule.id,
        periodId: period.id,
        paidAt: period.dueDate,
        paymentId: payment.id,
        status: 'paid',
      });
      runs.add(key);
      settleObligationCredits(state, context, obligation.id);
    }
  }
}

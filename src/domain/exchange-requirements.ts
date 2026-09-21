import type { Command, State } from './types';
import { generatePeriods } from './core';
import { automaticGenerationWindow } from './payments';
import { validateCommands } from './validation';
import { installBillingRuleChange, previewBillingRuleChange } from './billing';
import {
  archiveSchedulePayload,
  deleteObligation,
  installObligationSchedule,
} from './lifecycle';

export interface ExchangeRateRequest {
  from: string;
  to: string;
  date: string;
}
/** Collect requested currency pairs/dates for a server-owned historical-rate provider. Values never come from browser fields. */
export function requiredExchangeRates(
  state: State,
  input: Command[] | unknown,
): ExchangeRateRequest[] {
  const commands = validateCommands(input),
    draft = structuredClone(state),
    requests = new Map<string, ExchangeRateRequest>();
  const quote = (from: string, date: string, to = draft.household.currency) => {
    if (from !== to) requests.set(`${from}:${to}:${date}`, { from, to, date });
  };
  const allocationQuote = (
    payment: State['payments'][number] | undefined,
    periodId: string,
  ) => {
    const period = draft.periods.find((period) => period.id === periodId),
      rule = draft.rules.find((rule) => rule.id === period?.ruleVersionId);
    if (payment && rule) quote(payment.currency, payment.paidAt, rule.currency);
  };
  const periodQuote = (period: State['periods'][number]) => {
    const rule = draft.rules.find((rule) => rule.id === period.ruleVersionId);
    if (rule && period.expectedAmount !== undefined)
      quote(rule.currency, period.dueDate);
  };
  const generate = (from: string, to: string) => {
    const existing = new Set(draft.periods.map((period) => period.id));
    for (const period of generatePeriods(draft, from, to))
      if (!existing.has(period.id)) {
        draft.periods.push(period);
        existing.add(period.id);
        periodQuote(period);
      }
  };
  for (const command of commands) {
    switch (command.type) {
      case 'AddObligation':
        draft.obligations.push(command.payload.obligation);
        draft.rules.push(command.payload.rule);
        break;
      case 'UpdateObligation': {
        const obligation = draft.obligations.find(
          (obligation) => obligation.id === command.payload.obligationId,
        );
        if (obligation && command.payload.patch.activeTo !== undefined)
          obligation.activeTo = command.payload.patch.activeTo ?? undefined;
        break;
      }
      case 'ArchiveObligation':
      case 'UpdateObligationSchedule': {
        const payload =
          command.type === 'ArchiveObligation'
            ? archiveSchedulePayload(
                draft,
                command.payload.obligationId,
                command.payload.activeTo,
                command.payload.outOfRangePaymentPolicy,
              )
            : command.payload;
        const result = installObligationSchedule(draft, payload);
        for (const periodId of result.revaluePeriodIds) {
          const period = draft.periods.find((period) => period.id === periodId);
          if (period) periodQuote(period);
        }
        for (const paymentId of result.revaluePaymentIds) {
          const payment = draft.payments.find(
            (payment) => payment.id === paymentId,
          );
          if (payment) quote(payment.currency, payment.paidAt);
        }
        break;
      }
      case 'DeleteObligation':
        deleteObligation(draft, command.payload.obligationId);
        break;
      case 'RecordPaymentAndAllocate':
        quote(command.payload.payment.currency, command.payload.payment.paidAt);
        draft.payments.push(command.payload.payment);
        for (const allocation of command.payload.allocations)
          allocationQuote(command.payload.payment, allocation.billingPeriodId);
        break;
      case 'AllocatePayment':
        for (const allocation of command.payload.allocations)
          allocationQuote(
            draft.payments.find(
              (payment) => payment.id === command.payload.paymentId,
            ),
            allocation.billingPeriodId,
          );
        break;
      case 'RefundPayment':
        for (const allocation of command.payload.replacementAllocations ?? [])
          allocationQuote(
            draft.payments.find(
              (payment) =>
                payment.id === command.payload.refund.originalPaymentId,
            ),
            allocation.billingPeriodId,
          );
        break;
      case 'ImportPayments':
        for (const payment of command.payload.payments) {
          quote(payment.currency, payment.paidAt);
          draft.payments.push(payment);
        }
        break;
      case 'GeneratePeriods':
        generate(command.payload.from, command.payload.to);
        break;
      case 'ConfirmPeriodAmount': {
        const period = draft.periods.find(
          (period) => period.id === command.payload.periodId,
        );
        if (period) {
          period.expectedAmount = command.payload.amount;
          periodQuote(period);
        }
        break;
      }
      case 'ChangeBillingRule': {
        const preview = previewBillingRuleChange(
          draft,
          command.payload.rule,
          command.payload.fromPeriodId,
        );
        for (const period of installBillingRuleChange(draft, preview))
          periodQuote(period);
        break;
      }
      case 'UpdateHousehold':
        if (
          command.payload.currency &&
          command.payload.currency !== draft.household.currency
        ) {
          draft.household.currency = command.payload.currency;
          for (const payment of draft.payments)
            quote(payment.currency, payment.paidAt);
          for (const period of draft.periods) periodQuote(period);
        }
        break;
      case 'AddAutomaticPayment':
        (draft.automaticPayments ??= []).push(command.payload.schedule);
        break;
      case 'DeleteAutomaticPayment':
        draft.automaticPayments = draft.automaticPayments?.filter(
          (schedule) => schedule.id !== command.payload.scheduleId,
        );
        break;
      case 'ExecuteAutomaticPayments': {
        const window = automaticGenerationWindow(
          draft,
          command.payload.through,
        );
        if (window) generate(window.from, window.to);
        for (const schedule of draft.automaticPayments ?? [])
          if (schedule.enabled)
            for (const period of draft.periods) {
              if (
                period.obligationId === schedule.obligationId &&
                period.dueDate >= schedule.startDate &&
                period.dueDate <= command.payload.through &&
                (!schedule.endDate || period.dueDate <= schedule.endDate)
              ) {
                const rule = draft.rules.find(
                  (rule) => rule.id === period.ruleVersionId,
                );
                if (rule) {
                  quote(schedule.currency ?? rule.currency, period.dueDate);
                  quote(
                    schedule.currency ?? rule.currency,
                    period.dueDate,
                    rule.currency,
                  );
                }
              }
            }
        break;
      }
    }
  }
  if (
    commands.some((command) =>
      [
        'RecordPaymentAndAllocate',
        'ImportPayments',
        'GeneratePeriods',
        'ConfirmPeriodAmount',
        'ChangeBillingRule',
        'UpdateObligationSchedule',
        'ArchiveObligation',
        'UpdateHousehold',
        'ExecuteAutomaticPayments',
      ].includes(command.type),
    )
  ) {
    const balances = new Map(
      draft.payments.map((payment) => [payment.id, payment.amount]),
    );
    for (const refund of draft.refunds)
      balances.set(
        refund.originalPaymentId,
        (balances.get(refund.originalPaymentId) ?? 0) - refund.amount,
      );
    for (const allocation of draft.allocations)
      if (!allocation.reversedBy)
        balances.set(
          allocation.paymentId,
          (balances.get(allocation.paymentId) ?? 0) -
            (allocation.paymentAmount ?? allocation.amount),
        );
    for (const payment of draft.payments)
      if (payment.obligationId && (balances.get(payment.id) ?? 0) > 0) {
        for (const rule of draft.rules.filter(
          (rule) => rule.obligationId === payment.obligationId,
        ))
          quote(payment.currency, payment.paidAt, rule.currency);
      }
  }
  return [...requests.values()].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to),
  );
}

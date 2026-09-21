import { addDays, addMonths } from '../domain/core';
import type { BillingRule, Obligation, State } from '../domain/types';

function paidThrough(rule: BillingRule, paidAt: string): string {
  return rule.cadence === 'weekly'
    ? addDays(paidAt, 7)
    : addMonths(
        paidAt,
        rule.cadence === 'monthly' ? 1 : rule.cadence === 'quarterly' ? 3 : 12,
      );
}

/** Family-directory visibility, not a new financial entitlement or a change to the ledger.
 * A retained positive payment gives one calendar cadence from its payment date, even
 * after archiving. Partial refunds do not invent a prorated service end date.
 * Prepayment can start visibility before the first billing date. Responsibility
 * begins with assignment, so upcoming active obligations also appear for owners.
 * All date windows are [start,end); future payments/refunds are evaluated as of today.
 */
export function availableFamilyObligations(
  state: State,
  today: string,
  relationship: 'benefit' | 'responsible' = 'benefit',
): Obligation[] {
  const periods = new Map(state.periods.map((period) => [period.id, period]));
  const rules = new Map(state.rules.map((rule) => [rule.id, rule]));
  const refunded = new Map<string, number>();
  for (const refund of state.refunds)
    if (refund.paidAt <= today)
      refunded.set(
        refund.originalPaymentId,
        (refunded.get(refund.originalPaymentId) ?? 0) + refund.amount,
      );
  const allocationRules = new Map<string, Map<string, Set<string>>>();
  for (const allocation of state.allocations) {
    if (
      allocation.reversedBy ||
      (allocation.effectiveDate && allocation.effectiveDate > today) ||
      (allocation.periodAmount ?? allocation.amount) <= 0
    )
      continue;
    const period = periods.get(allocation.billingPeriodId);
    if (!period) continue;
    const byObligation =
      allocationRules.get(allocation.paymentId) ??
      new Map<string, Set<string>>();
    const ids = byObligation.get(period.obligationId) ?? new Set<string>();
    ids.add(period.ruleVersionId);
    byObligation.set(period.obligationId, ids);
    allocationRules.set(allocation.paymentId, byObligation);
  }
  const paidUntil = new Map<string, string>();
  for (const payment of state.payments) {
    if (
      payment.paidAt > today ||
      payment.amount - (refunded.get(payment.id) ?? 0) <= 0
    )
      continue;
    const linked =
      allocationRules.get(payment.id) ?? new Map<string, Set<string>>();
    if (payment.obligationId && !linked.has(payment.obligationId))
      linked.set(payment.obligationId, new Set());
    for (const [obligationId, ruleIds] of linked) {
      // Allocated payments keep the original period's cadence when the schedule changes.
      let candidates = [...ruleIds]
        .map((id) => rules.get(id))
        .filter((rule): rule is BillingRule => !!rule);
      if (!candidates.length) {
        const historical = state.rules.filter(
          (rule) =>
            rule.obligationId === obligationId &&
            rule.effectiveFrom <= payment.paidAt &&
            (!rule.effectiveTo || payment.paidAt < rule.effectiveTo),
        );
        const current = historical.filter((rule) => !rule.superseded);
        // Unallocated advance credit may precede the first rule. In that case use
        // the first scheduled cadence rather than silently discarding the payment.
        const first = state.rules
          .filter(
            (rule) => rule.obligationId === obligationId && !rule.superseded,
          )
          .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0];
        const rule =
          (current.length ? current : historical).sort((a, b) =>
            b.effectiveFrom.localeCompare(a.effectiveFrom),
          )[0] ??
          (first && payment.paidAt < first.effectiveFrom ? first : undefined);
        if (rule) candidates = [rule];
      }
      for (const rule of candidates) {
        const end = paidThrough(rule, payment.paidAt);
        if (end > (paidUntil.get(obligationId) ?? ''))
          paidUntil.set(obligationId, end);
      }
    }
  }
  return state.obligations.filter(
    (obligation) =>
      (obligation.lifecycleState === 'active' &&
        (!obligation.activeTo || today < obligation.activeTo) &&
        (relationship === 'responsible' || obligation.activeFrom <= today)) ||
      today < (paidUntil.get(obligation.id) ?? ''),
  );
}

import {
  getPeriodStatus,
  periodBaseAmount,
  safeSum,
  type BillingPeriod,
  type Obligation,
  type PeriodStatus,
  type State,
} from '../domain';

export type MonthlyObligationStatus = 'paid' | 'due' | 'overdue';

export interface MonthlyObligationRow {
  obligation: Obligation;
  periods: BillingPeriod[];
  statuses: PeriodStatus[];
  representative: BillingPeriod;
  expected?: number;
  allocated: number;
  remaining: number;
  status: MonthlyObligationStatus;
  needsAction: boolean;
  estimated: boolean;
}

/** Groups charges due in one selected month without changing ledger periods. */
export function groupMonthlyObligations(
  state: State,
  periods: BillingPeriod[],
  today: string,
): MonthlyObligationRow[] {
  const grouped = new Map<string, BillingPeriod[]>();
  for (const period of periods) {
    const group = grouped.get(period.obligationId);
    if (group) group.push(period);
    else grouped.set(period.obligationId, [period]);
  }

  const rows: MonthlyObligationRow[] = [];
  for (const [obligationId, unsorted] of grouped) {
    const obligation = state.obligations.find(
      (item) => item.id === obligationId,
    );
    if (!obligation) continue;
    const items = [...unsorted].sort(
      (a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id),
    );
    const statuses = items.map((period) =>
      getPeriodStatus(state, period, today),
    );
    const amounts = items.map((period) => periodBaseAmount(state, period));
    const expected = amounts.every((amount) => amount !== undefined)
      ? safeSum(amounts as number[])
      : undefined;
    const allocated = safeSum(statuses.map((status) => status.allocated));
    const remaining = safeSum(
      statuses.map((status) => Math.max(0, status.remaining ?? 0)),
    );
    const overdue = statuses.some(
      (status) => status.needsAction && status.timingState === 'overdue',
    );
    const needsAction = statuses.some((status) => status.needsAction);
    const status: MonthlyObligationStatus = overdue
      ? 'overdue'
      : needsAction
        ? 'due'
        : 'paid';
    const representativeIndex = overdue
      ? statuses.findIndex(
          (item) => item.needsAction && item.timingState === 'overdue',
        )
      : needsAction
        ? statuses.findIndex((item) => item.needsAction)
        : items.length - 1;
    rows.push({
      obligation,
      periods: items,
      statuses,
      representative: items[Math.max(0, representativeIndex)],
      expected,
      allocated,
      remaining,
      status,
      needsAction,
      estimated: items.some((period) => !period.amountConfirmed),
    });
  }
  return rows.sort(
    (a, b) =>
      a.periods[0].dueDate.localeCompare(b.periods[0].dueDate) ||
      a.obligation.id.localeCompare(b.obligation.id),
  );
}

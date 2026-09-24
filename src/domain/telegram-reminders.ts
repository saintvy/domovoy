import { addDays, generatePeriods, getPeriodStatus } from './core';
import { periodOriginalAllocated, settleObligationCredits } from './payments';
import { DomainError } from './validation';
import type {
  BillingPeriod,
  Obligation,
  ReminderSettings,
  State,
} from './types';

export type TelegramReportSection = 'overdue' | 'due' | 'automatic';

export interface TelegramReportItem {
  section: TelegramReportSection;
  obligationId: string;
  periodId: string;
  title: string;
  dueDate: string;
  amount?: number;
  currency: string;
  amountState: 'confirmed' | 'estimated' | 'unknown';
  creditNeedsReview?: boolean;
}

/** Compatibility behavior for snapshots created before per-obligation reminders. */
export function effectiveReminderSettings(
  state: State,
  obligation: Obligation,
): ReminderSettings {
  if (obligation.reminder) return obligation.reminder;
  const automatic = (state.automaticPayments ?? []).some(
    (schedule) => schedule.obligationId === obligation.id && schedule.enabled,
  );
  return automatic
    ? { enabled: false, daysBefore: 1, repeat: 'daily' }
    : { enabled: true, daysBefore: 1, repeat: 'daily' };
}

function automaticForPeriod(state: State, period: BillingPeriod): boolean {
  return (state.automaticPayments ?? []).some(
    (schedule) =>
      schedule.obligationId === period.obligationId &&
      schedule.enabled &&
      schedule.startDate <= period.dueDate &&
      (!schedule.endDate || schedule.endDate >= period.dueDate),
  );
}

/**
 * Pure report selection. One-time delivery receipts are owned by persistence and
 * passed in as `${obligationId}:${periodId}` keys.
 */
export function selectTelegramReportItems(
  state: State,
  input: {
    today: string;
    recipientPersonId: string;
    onceReminderPeriodIds?: ReadonlySet<string>;
  },
): TelegramReportItem[] {
  const relevant = state.obligations.filter(
    (obligation) =>
      obligation.ownerPersonId === input.recipientPersonId &&
      effectiveReminderSettings(state, obligation).enabled,
  );
  if (!relevant.length) return [];
  const relevantIds = new Set(relevant.map((obligation) => obligation.id));
  const forecast = generatePeriods(
    state,
    addDays(input.today, -367),
    addDays(input.today, 732),
  );
  const periods = new Map(state.periods.map((period) => [period.id, period]));
  for (const period of forecast) periods.set(period.id, period);
  const simulation: State = {
    ...state,
    periods: [...periods.values()].filter((period) =>
      relevantIds.has(period.obligationId),
    ),
    allocations: [...state.allocations],
  };
  const creditNeedsReview = new Set<string>();
  for (const obligationId of relevantIds) {
    const persistedAllocations = simulation.allocations;
    simulation.allocations = [...persistedAllocations];
    try {
      settleObligationCredits(
        simulation,
        {
          actorUserId: 'telegram-report',
          operationId: `telegram-report:${input.today}:${input.recipientPersonId}`,
          now: `${input.today}T00:00:00.000Z`,
        },
        obligationId,
      );
    } catch (error) {
      if (
        !(error instanceof DomainError) ||
        error.code !== 'EXCHANGE_RATE_REQUIRED'
      )
        throw error;
      // A report must not fabricate a cross-rate. Ignore projected credit for
      // this obligation and conservatively keep its charge in the report.
      simulation.allocations = persistedAllocations;
      creditNeedsReview.add(obligationId);
    }
  }

  const items: TelegramReportItem[] = [];
  for (const obligation of relevant) {
    const reminder = effectiveReminderSettings(state, obligation);
    if (!reminder.enabled) continue;
    for (const period of periods.values()) {
      if (period.obligationId !== obligation.id) continue;
      if (input.today < addDays(period.dueDate, -reminder.daysBefore)) continue;
      const onceKey = `${obligation.id}:${period.id}`;
      if (
        reminder.repeat === 'once' &&
        input.onceReminderPeriodIds?.has(onceKey)
      )
        continue;
      const status = getPeriodStatus(simulation, period, input.today);
      if (!status.needsAction) continue;
      const rule = state.rules.find(
        (value) => value.id === period.ruleVersionId,
      );
      if (!rule) continue;
      const allocated = periodOriginalAllocated(simulation, period);
      const amount =
        period.expectedAmount === undefined
          ? undefined
          : Math.max(0, period.expectedAmount - allocated);
      if (amount === 0) continue;
      items.push({
        section: automaticForPeriod(state, period)
          ? 'automatic'
          : status.timingState === 'overdue'
            ? 'overdue'
            : 'due',
        obligationId: obligation.id,
        periodId: period.id,
        title: obligation.title,
        dueDate: period.dueDate,
        amount,
        currency: rule.currency,
        amountState:
          period.expectedAmount === undefined
            ? 'unknown'
            : period.amountConfirmed
              ? 'confirmed'
              : 'estimated',
        ...(creditNeedsReview.has(obligation.id)
          ? { creditNeedsReview: true }
          : {}),
      });
    }
  }
  const order: Record<TelegramReportSection, number> = {
    overdue: 0,
    due: 1,
    automatic: 2,
  };
  return items.sort(
    (a, b) =>
      order[a.section] - order[b.section] ||
      a.dueDate.localeCompare(b.dueDate) ||
      a.title.localeCompare(b.title) ||
      a.periodId.localeCompare(b.periodId),
  );
}

import type { BillingPeriod, BillingRule, Command, State } from './types';
import { addDays, addMonths } from './core';
import { ensure } from './validation';

export interface BillingRuleChangePreview {
  rule: BillingRule;
  previousRuleId: string;
  changedPeriodIds: string[];
  preservedPeriodIds: string[];
  supersededRuleIds: string[];
}
export interface HistoricalPricePreview {
  previousRuleId: string;
  removedRuleId?: string;
  rule?: BillingRule;
  affectedPeriodIds: string[];
}

/** A price note changes denomination and amount, never the charge calendar. */
export function previewHistoricalPriceEdit(
  state: State,
  payload: Extract<Command, { type: 'EditHistoricalPrice' }>['payload'],
): HistoricalPricePreview {
  ensure(
    state.household.allowHistoricalPriceEdits,
    'HISTORICAL_PRICE_DISABLED',
    'Historical price editing is disabled',
  );
  const obligation = state.obligations.find(
    (item) => item.id === payload.obligationId,
  );
  ensure(obligation, 'NOT_FOUND', 'Obligation not found');
  ensure(
    payload.effectiveFrom >= obligation.activeFrom &&
      (!obligation.activeTo || payload.effectiveFrom < obligation.activeTo),
    'INVALID_RULE_CHANGE',
    'Price date is outside the obligation',
  );
  const active = state.rules
    .filter(
      (item) => item.obligationId === payload.obligationId && !item.superseded,
    )
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  ensure(
    active[0]?.effectiveFrom === obligation.activeFrom,
    'INVALID_RULE_CHANGE',
    'The first price must start with the obligation',
  );
  const at = active.findIndex(
    (item) => item.effectiveFrom === payload.effectiveFrom,
  );
  const priorIndex = active.findIndex(
    (item) =>
      item.effectiveFrom <= payload.effectiveFrom &&
      (!item.effectiveTo || item.effectiveTo > payload.effectiveFrom),
  );
  ensure(
    priorIndex >= 0,
    'INVALID_RULE_CHANGE',
    'No active price exists on that date',
  );
  const selected = active[at >= 0 ? at : priorIndex];
  const isAdd = payload.action === 'add';
  ensure(
    isAdd
      ? at < 0 && !payload.ruleId
      : at >= 0 && payload.ruleId === selected.id,
    'INVALID_RULE_CHANGE',
    'Price version and date do not match',
  );
  ensure(
    isAdd || payload.action === 'delete' || payload.action === 'update',
    'INVALID_RULE_CHANGE',
    'Invalid price action',
  );
  ensure(
    payload.action !== 'delete' || (at > 0 && !payload.rule),
    'FIRST_PRICE_REQUIRED',
    'The first price can be changed but not deleted',
  );
  ensure(
    payload.action === 'delete' || Boolean(payload.rule),
    'INVALID_RULE_CHANGE',
    'A replacement price is required',
  );
  const previous = active[(isAdd ? priorIndex : at) - (isAdd ? 0 : 1)];
  const replacement = payload.rule;
  if (replacement) {
    ensure(
      replacement.obligationId === payload.obligationId &&
        replacement.effectiveFrom === payload.effectiveFrom &&
        !replacement.effectiveTo &&
        !replacement.superseded &&
        !state.rules.some((item) => item.id === replacement.id),
      'INVALID_RULE_CHANGE',
      'New price needs a fresh matching rule ID',
    );
    const calendar = selected;
    ensure(
      replacement.cadence === calendar.cadence &&
        replacement.anchor === calendar.anchor &&
        replacement.dueOffsetDays === calendar.dueOffsetDays &&
        replacement.reminderDays === calendar.reminderDays &&
        replacement.graceDays === calendar.graceDays &&
        replacement.amountMode === calendar.amountMode,
      'SCHEDULE_CHANGE_CONFLICT',
      'Historical price edit cannot alter the schedule',
    );
    ensure(
      state.household.currencies?.includes(replacement.currency),
      'CURRENCY_MISMATCH',
      'Add the currency to household settings',
    );
  }
  if (isAdd)
    ensure(
      intervalEnd(selected, payload.effectiveFrom),
      'RULE_BOUNDARY',
      'Price date must be a period boundary',
    );
  const next = isAdd ? active[priorIndex + 1] : active[at + 1];
  const end = isAdd
    ? (next?.effectiveFrom ?? selected.effectiveTo)
    : selected.effectiveTo;
  const target = payload.action === 'delete' ? previous : replacement;
  ensure(target, 'FIRST_PRICE_REQUIRED', 'The first price cannot be deleted');
  if (payload.action === 'delete')
    ensure(
      target.cadence === selected.cadence &&
        target.anchor === selected.anchor &&
        target.dueOffsetDays === selected.dueOffsetDays &&
        target.reminderDays === selected.reminderDays &&
        target.graceDays === selected.graceDays &&
        target.amountMode === selected.amountMode,
      'SCHEDULE_CHANGE_CONFLICT',
      'Deleting this price would change the charge schedule or amount mode',
    );
  const affected = state.periods.filter(
    (period) =>
      period.obligationId === payload.obligationId &&
      period.periodStart >= payload.effectiveFrom &&
      (!end || period.periodStart < end),
  );
  for (const period of affected)
    ensure(
      intervalEnd(target, period.periodStart) === period.periodEnd,
      'SCHEDULE_CHANGE_CONFLICT',
      'Price version would change an existing period boundary',
    );
  return {
    previousRuleId: (isAdd ? selected : (previous ?? selected)).id,
    ...(isAdd ? {} : { removedRuleId: selected.id }),
    ...(replacement
      ? { rule: { ...replacement, ...(end ? { effectiveTo: end } : {}) } }
      : {}),
    affectedPeriodIds: affected.map((period) => period.id),
  };
}

export function installHistoricalPriceEdit(
  state: State,
  preview: HistoricalPricePreview,
): BillingPeriod[] {
  const prior = state.rules.find((item) => item.id === preview.previousRuleId)!;
  const removed = state.rules.find((item) => item.id === preview.removedRuleId);
  if (removed) removed.superseded = true;
  if (preview.rule) {
    if (!removed) prior.effectiveTo = preview.rule.effectiveFrom;
    state.rules.push(preview.rule);
  } else if (removed) prior.effectiveTo = removed.effectiveTo;
  const target = preview.rule ?? prior;
  const affected = new Set(preview.affectedPeriodIds);
  return state.periods
    .filter((period) => affected.has(period.id))
    .flatMap((period) => {
      const oldRule = state.rules.find(
        (item) => item.id === period.ruleVersionId,
      )!;
      const revalue =
        period.expectedAmount !== target.amount ||
        period.amountConfirmed !==
          (target.amountMode !== 'estimate' && target.amount !== undefined) ||
        oldRule.currency !== target.currency;
      period.ruleVersionId = target.id;
      if (revalue) {
        period.expectedAmount = target.amount;
        period.amountConfirmed =
          target.amountMode !== 'estimate' && target.amount !== undefined;
        delete period.baseExpectedAmount;
        delete period.baseCurrency;
        delete period.exchangeRate;
        delete period.exchangeRateDate;
        delete period.exchangeRateSource;
      }
      return revalue ? [period] : [];
    });
}
export function intervalEnd(
  rule: BillingRule,
  start: string,
): string | undefined {
  if (rule.cadence === 'weekly') {
    const days = (Date.parse(start) - Date.parse(rule.anchor)) / 86400_000;
    return days >= 0 && days % 7 === 0 ? addDays(start, 7) : undefined;
  }
  const step =
    rule.cadence === 'monthly' ? 1 : rule.cadence === 'quarterly' ? 3 : 12;
  const months =
    (Number(start.slice(0, 4)) - Number(rule.anchor.slice(0, 4))) * 12 +
    Number(start.slice(5, 7)) -
    Number(rule.anchor.slice(5, 7));
  return months >= 0 &&
    months % step === 0 &&
    addMonths(rule.anchor, months) === start
    ? addMonths(rule.anchor, months + step)
    : undefined;
}
/** An allocation remains financial history after reversal; such a period must never be repriced. */
export function lockedBillingPeriodIds(state: State): Set<string> {
  return new Set([
    ...state.allocations.map((allocation) => allocation.billingPeriodId),
    ...state.periods
      .filter((period) => period.waiver)
      .map((period) => period.id),
    ...(state.automaticPaymentRuns ?? []).map((run) => run.periodId),
    ...state.periods
      .filter((period) => period.amountConfirmed && period.expectedAmount === 0)
      .map((period) => period.id),
  ]);
}
/** Pure preview shared by the server and UI. The selected price applies onward, with explicit protected-period exceptions. */
export function previewBillingRuleChange(
  state: State,
  requested: BillingRule,
  fromPeriodId?: string,
): BillingRuleChangePreview {
  const obligation = state.obligations.find(
    (obligation) => obligation.id === requested.obligationId,
  );
  ensure(obligation, 'NOT_FOUND', 'Обязательство не найдено');
  ensure(
    !state.rules.some((rule) => rule.id === requested.id),
    'INVALID_RULE_CHANGE',
    'Для изменения нужна новая версия правила',
  );
  ensure(
    requested.effectiveFrom >= obligation.activeFrom &&
      (!obligation.activeTo || requested.effectiveFrom < obligation.activeTo),
    'INVALID_RULE_CHANGE',
    'Выберите период в пределах срока обязательства',
  );
  const active = state.rules
    .filter(
      (rule) =>
        rule.obligationId === requested.obligationId && !rule.superseded,
    )
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const prior = active
    .filter(
      (rule) =>
        rule.effectiveFrom <= requested.effectiveFrom &&
        (!rule.effectiveTo || rule.effectiveTo > requested.effectiveFrom),
    )
    .at(-1);
  ensure(
    prior,
    'INVALID_RULE_CHANGE',
    'Для выбранного периода не найдено действующее правило',
  );
  ensure(
    intervalEnd(prior, requested.effectiveFrom),
    'RULE_BOUNDARY',
    'Изменение цены допускается только на границе периода',
  );
  ensure(
    requested.anchor === requested.effectiveFrom ||
      (requested.cadence === prior.cadence &&
        requested.anchor === prior.anchor),
    'RULE_BOUNDARY',
    'Новый якорь должен совпадать с границей',
  );
  const selected = fromPeriodId
    ? state.periods.find((period) => period.id === fromPeriodId)
    : state.periods.find(
        (period) =>
          period.obligationId === requested.obligationId &&
          period.periodStart === requested.effectiveFrom,
      );
  if (fromPeriodId)
    ensure(
      selected &&
        selected.obligationId === requested.obligationId &&
        selected.periodStart === requested.effectiveFrom,
      'PERIOD_SELECTION_MISMATCH',
      'Выбранное начисление не соответствует дате изменения цены',
    );
  const locked = lockedBillingPeriodIds(state);
  ensure(
    !selected || !locked.has(selected.id),
    'PERIOD_PRICE_LOCKED',
    'Цена выбранного начисления защищена оплатой, возвратом, освобождением или завершённым автоплатежом. Выберите неоплаченный период.',
  );
  const {
    effectiveTo: _oldEnd,
    superseded: _oldSuperseded,
    ...rule
  } = requested;
  const affected = state.periods.filter(
    (period) =>
      period.obligationId === requested.obligationId &&
      period.periodStart >= requested.effectiveFrom &&
      (!obligation.activeTo || period.periodStart < obligation.activeTo),
  );
  for (const period of affected)
    ensure(
      intervalEnd(rule, period.periodStart) === period.periodEnd,
      'SCHEDULE_CHANGE_CONFLICT',
      'Новый график пересекается с уже созданными начислениями. Измените цену без смены периодичности или выберите дату после созданных периодов.',
    );
  return {
    rule,
    previousRuleId: prior.id,
    changedPeriodIds: affected
      .filter((period) => !locked.has(period.id))
      .map((period) => period.id),
    preservedPeriodIds: affected
      .filter((period) => locked.has(period.id))
      .map((period) => period.id),
    supersededRuleIds: active
      .filter((version) => version.effectiveFrom >= rule.effectiveFrom)
      .map((version) => version.id),
  };
}
/** Apply only the planned schedule mutation. Callers separately obtain trusted FX and settle any existing credit. */
export function installBillingRuleChange(
  state: State,
  preview: BillingRuleChangePreview,
): BillingPeriod[] {
  const prior = state.rules.find((rule) => rule.id === preview.previousRuleId)!;
  if (prior.effectiveFrom < preview.rule.effectiveFrom)
    prior.effectiveTo = preview.rule.effectiveFrom;
  const superseded = new Set(preview.supersededRuleIds);
  for (const rule of state.rules)
    if (superseded.has(rule.id)) rule.superseded = true;
  state.rules.push({ ...preview.rule });
  const changed = new Set(preview.changedPeriodIds),
    periods: BillingPeriod[] = [];
  for (const period of state.periods)
    if (changed.has(period.id)) {
      period.ruleVersionId = preview.rule.id;
      period.expectedAmount = preview.rule.amount;
      period.amountConfirmed =
        preview.rule.amountMode !== 'estimate' &&
        preview.rule.amount !== undefined;
      period.dueDate = addDays(period.periodStart, preview.rule.dueOffsetDays);
      delete period.baseExpectedAmount;
      delete period.baseCurrency;
      delete period.exchangeRate;
      delete period.exchangeRateDate;
      delete period.exchangeRateSource;
      periods.push(period);
    }
  return periods;
}

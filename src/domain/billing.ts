import type { BillingPeriod, BillingRule, State } from './types';
import { addDays, addMonths } from './core';
import { ensure } from './validation';

export interface BillingRuleChangePreview {
  rule: BillingRule;
  previousRuleId: string;
  changedPeriodIds: string[];
  preservedPeriodIds: string[];
  supersededRuleIds: string[];
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

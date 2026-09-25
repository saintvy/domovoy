import type {
  Beneficiaries,
  BillingPeriod,
  BillingRule,
  CommandContext,
  Obligation,
  ObligationScheduleChange,
  OutOfRangePaymentPolicy,
  State,
} from './types';
import { addDays, addMonths, generatePeriods, safeSum, stableId } from './core';
import { ensure, isISODate } from './validation';
import { convertMinorAmount, valuePayment, valuePeriod } from './currency';
import { settleObligationCredits } from './payments';
import { intervalEnd, lockedBillingPeriodIds } from './billing';

export const NOBODY_PERSON_ID = '00000000-0000-5000-a000-000000000000';
export const DEFAULT_NOBODY_COLOR = '#000000';

export interface PersonLifecyclePreview {
  soleBeneficiaryObligationIds: string[];
  restorableObligationIds: string[];
  stoppedObligations: {
    obligationId: string;
    activeTo: string;
    preservedFuturePeriodIds: string[];
    removedFuturePeriodIds: string[];
    automaticPaymentIds: string[];
  }[];
}

function nobodyBeneficiaries(
  beneficiaries: Beneficiaries,
  personId: string,
): Beneficiaries {
  if (beneficiaries.kind === 'household') return beneficiaries;
  const personIds = [
    ...new Set(
      beneficiaries.personIds.map((id) =>
        id === personId ? NOBODY_PERSON_ID : id,
      ),
    ),
  ];
  return { kind: 'people', personIds };
}

function appendAttributionSnapshot(
  obligation: Obligation,
  through: string,
): void {
  const history = (obligation.attributionHistory ??= []);
  if (history.length && history.at(-1)!.through >= through) return;
  history.push({
    through,
    ownerPersonId: obligation.ownerPersonId,
    beneficiaries: structuredClone(
      obligation.beneficiaries ?? { kind: 'household' },
    ),
  });
}

export function personAttributionForDate(
  obligation: Obligation,
  date: string,
): { ownerPersonId?: string; beneficiaries: Beneficiaries } {
  const historical = obligation.attributionHistory?.find(
    (entry) => entry.through >= date,
  );
  return historical
    ? {
        ownerPersonId: historical.ownerPersonId,
        beneficiaries: historical.beneficiaries,
      }
    : {
        ownerPersonId: obligation.ownerPersonId,
        beneficiaries: obligation.beneficiaries ?? { kind: 'household' },
      };
}

function stopPlan(state: State, obligation: Obligation, today: string) {
  const candidates = new Map(
    state.periods
      .filter((period) => period.obligationId === obligation.id)
      .map((period) => [period.id, period]),
  );
  if (!obligation.activeTo || obligation.activeTo > today) {
    const rules = state.rules.filter(
        (rule) => rule.obligationId === obligation.id && !rule.superseded,
      ),
      finalRuleEnd = rules
        .map((rule) => rule.effectiveTo)
        .filter((date): date is string => !!date)
        .sort()
        .at(-1),
      reference =
        rules.every((rule) => !!rule.effectiveTo) &&
        finalRuleEnd &&
        finalRuleEnd <= today
          ? addDays(finalRuleEnd, -1)
          : today,
      from =
        obligation.activeFrom > addDays(reference, -800)
          ? obligation.activeFrom
          : addDays(reference, -800),
      toCandidate = addDays(reference, 367),
      to =
        toCandidate < addDays(today, 367) ? toCandidate : addDays(today, 367);
    if (from < to) {
      const isolated = {
        ...state,
        obligations: [obligation],
        rules,
        periods: [...candidates.values()],
      };
      for (const period of generatePeriods(isolated, from, to))
        candidates.set(period.id, period);
    }
  }
  const accrued = [...candidates.values()].filter(
    (period) => period.dueDate <= today,
  );
  let activeTo =
    obligation.activeTo && obligation.activeTo <= today
      ? obligation.activeTo
      : (accrued
          .map((period) => period.periodEnd)
          .sort()
          .at(-1) ?? obligation.activeFrom);
  if (obligation.activeTo && obligation.activeTo < activeTo)
    activeTo = obligation.activeTo;
  const locked = lockedBillingPeriodIds(state),
    future = state.periods.filter(
      (period) =>
        period.obligationId === obligation.id && period.periodStart >= activeTo,
    ),
    protectedIds = new Set(
      future
        .filter((period) => locked.has(period.id) || period.dueDate <= today)
        .map((period) => period.id),
    );
  return {
    obligationId: obligation.id,
    activeTo,
    preservedFuturePeriodIds: future
      .filter((period) => protectedIds.has(period.id))
      .map((period) => period.id),
    removedFuturePeriodIds: future
      .filter((period) => !protectedIds.has(period.id))
      .map((period) => period.id),
    automaticPaymentIds: (state.automaticPayments ?? [])
      .filter((schedule) => schedule.obligationId === obligation.id)
      .map((schedule) => schedule.id),
  };
}

export function previewPersonLifecycle(
  state: State,
  personId: string,
  today: string,
): PersonLifecyclePreview {
  ensure(
    state.people.some((person) => person.id === personId),
    'NOT_FOUND',
    'Член семьи не найден',
  );
  ensure(isISODate(today), 'INVALID_DATE_RANGE', 'Проверьте дату семьи');
  const sole = state.obligations.filter(
    (obligation) =>
      obligation.beneficiaries?.kind === 'people' &&
      obligation.beneficiaries.personIds.length === 1 &&
      obligation.beneficiaries.personIds[0] === personId,
  );
  return {
    soleBeneficiaryObligationIds: sole.map((obligation) => obligation.id),
    restorableObligationIds: state.obligations
      .filter(
        (obligation) =>
          obligation.beneficiaryArchive?.personIds.includes(personId) &&
          obligation.beneficiaries?.kind === 'people' &&
          obligation.beneficiaries.personIds.includes(NOBODY_PERSON_ID),
      )
      .map((obligation) => obligation.id),
    stoppedObligations: sole.map((obligation) =>
      stopPlan(state, obligation, today),
    ),
  };
}

export function archivePerson(
  state: State,
  personId: string,
  policy: 'keep_nobody' | 'end_at_last_accrual',
  context: CommandContext,
  today: string,
): PersonLifecyclePreview {
  const person = state.people.find((candidate) => candidate.id === personId);
  ensure(person, 'NOT_FOUND', 'Член семьи не найден');
  ensure(
    !person.archivedAt,
    'PERSON_ALREADY_ARCHIVED',
    'Член семьи уже в архиве',
  );
  const preview = previewPersonLifecycle(state, personId, today),
    sole = new Set(preview.soleBeneficiaryObligationIds);
  for (const obligation of state.obligations) {
    const owns = obligation.ownerPersonId === personId,
      benefits =
        obligation.beneficiaries?.kind === 'people' &&
        obligation.beneficiaries.personIds.includes(personId);
    if (!owns && !benefits) continue;
    appendAttributionSnapshot(obligation, today);
    if (owns) obligation.ownerPersonId = NOBODY_PERSON_ID;
    if (benefits) {
      const provenance = (obligation.beneficiaryArchive ??= {
        personIds: [],
        hadNobody:
          obligation.beneficiaries!.kind === 'people' &&
          obligation.beneficiaries!.personIds.includes(NOBODY_PERSON_ID),
      });
      if (!provenance.personIds.includes(personId))
        provenance.personIds.push(personId);
      obligation.beneficiaries = nobodyBeneficiaries(
        obligation.beneficiaries!,
        personId,
      );
    }
  }
  for (const schedule of state.automaticPayments ?? [])
    if (schedule.payerPersonId === personId)
      schedule.payerPersonId = NOBODY_PERSON_ID;
  if (policy === 'end_at_last_accrual') {
    for (const plan of preview.stoppedObligations) {
      if (!sole.has(plan.obligationId)) continue;
      const obligation = state.obligations.find(
        (candidate) => candidate.id === plan.obligationId,
      )!;
      obligation.activeTo = plan.activeTo;
      obligation.lifecycleState = 'archived';
      const removed = new Set(plan.removedFuturePeriodIds);
      state.periods = state.periods.filter((period) => !removed.has(period.id));
      for (const schedule of state.automaticPayments ?? [])
        if (schedule.obligationId === obligation.id) schedule.enabled = false;
    }
  }
  person.archivedAt = context.now;
  return preview;
}

export function restorePerson(
  state: State,
  personId: string,
  restoreBeneficiaries: boolean,
  today: string,
): PersonLifecyclePreview {
  const person = state.people.find((candidate) => candidate.id === personId);
  ensure(person, 'NOT_FOUND', 'Член семьи не найден');
  ensure(
    person.archivedAt,
    'PERSON_NOT_ARCHIVED',
    'Член семьи не находится в архиве',
  );
  const preview = previewPersonLifecycle(state, personId, today);
  for (const obligation of state.obligations) {
    const provenance = obligation.beneficiaryArchive;
    if (!provenance?.personIds.includes(personId)) continue;
    const hasNobody =
      obligation.beneficiaries?.kind === 'people' &&
      obligation.beneficiaries.personIds.includes(NOBODY_PERSON_ID);
    if (restoreBeneficiaries && hasNobody) {
      appendAttributionSnapshot(obligation, today);
      const remaining = provenance.personIds.filter((id) => id !== personId),
        removeNobody = remaining.length === 0 && !provenance.hadNobody,
        personIds =
          obligation.beneficiaries!.kind === 'people'
            ? obligation.beneficiaries!.personIds.filter(
                (id) => id !== NOBODY_PERSON_ID || !removeNobody,
              )
            : [];
      if (!personIds.includes(personId)) personIds.push(personId);
      obligation.beneficiaries = { kind: 'people', personIds };
      if (remaining.length)
        obligation.beneficiaryArchive = { ...provenance, personIds: remaining };
      else delete obligation.beneficiaryArchive;
    } else {
      const remaining = provenance.personIds.filter((id) => id !== personId);
      if (remaining.length)
        obligation.beneficiaryArchive = {
          personIds: remaining,
          hadNobody: true,
        };
      else delete obligation.beneficiaryArchive;
    }
  }
  delete person.archivedAt;
  return preview;
}

export function deletePerson(state: State, personId: string): void {
  const index = state.people.findIndex((person) => person.id === personId);
  ensure(index >= 0, 'NOT_FOUND', 'Член семьи не найден');
  for (const obligation of state.obligations) {
    if (obligation.ownerPersonId === personId)
      obligation.ownerPersonId = NOBODY_PERSON_ID;
    const deletedCurrentBeneficiary =
      obligation.beneficiaries?.kind === 'people' &&
      obligation.beneficiaries.personIds.includes(personId);
    if (obligation.beneficiaries)
      obligation.beneficiaries = nobodyBeneficiaries(
        obligation.beneficiaries,
        personId,
      );
    if (deletedCurrentBeneficiary && obligation.beneficiaryArchive)
      obligation.beneficiaryArchive.hadNobody = true;
    for (const entry of obligation.attributionHistory ?? []) {
      if (entry.ownerPersonId === personId)
        entry.ownerPersonId = NOBODY_PERSON_ID;
      entry.beneficiaries = nobodyBeneficiaries(entry.beneficiaries, personId);
    }
    if (obligation.beneficiaryArchive?.personIds.includes(personId)) {
      const remaining = obligation.beneficiaryArchive.personIds.filter(
        (id) => id !== personId,
      );
      if (remaining.length)
        obligation.beneficiaryArchive = {
          personIds: remaining,
          hadNobody: true,
        };
      else delete obligation.beneficiaryArchive;
    }
  }
  for (const payment of state.payments)
    if (payment.payerPersonId === personId)
      payment.payerPersonId = NOBODY_PERSON_ID;
  for (const schedule of state.automaticPayments ?? [])
    if (schedule.payerPersonId === personId)
      schedule.payerPersonId = NOBODY_PERSON_ID;
  for (const entitlement of state.entitlements)
    if (entitlement.personId === personId)
      entitlement.personId = NOBODY_PERSON_ID;
  state.people.splice(index, 1);
}

export interface ObligationSchedulePreview {
  affectedPeriodIds: string[];
  removedPeriodIds: string[];
  createdPeriodIds: string[];
  changedPeriodIds: string[];
  preservedPeriodIds: string[];
  affectedPaymentIds: string[];
  outOfRangePaymentIds: string[];
  sharedPaymentIds: string[];
  paymentDateChanges: { paymentId: string; from: string; to: string }[];
  deletedPaymentIds: string[];
  preservedCreditPaymentIds: string[];
  blockedReasons: string[];
  periodsBefore: number;
  periodsAfter: number;
  normalizedActiveTo?: string;
  cancelledBeforeStart: boolean;
}
export interface ObligationDeletionPreview {
  periodIds: string[];
  paymentIds: string[];
  refundIds: string[];
  allocationIds: string[];
  automaticPaymentIds: string[];
  sharedPaymentIds: string[];
  totalsByCurrency: { currency: string; amount: number }[];
  blockedReasons: string[];
}
function relationships(state: State, obligationId: string) {
  const periodIds = new Set(
    state.periods
      .filter((period) => period.obligationId === obligationId)
      .map((period) => period.id),
  );
  const related = new Set(
    state.payments
      .filter((payment) => payment.obligationId === obligationId)
      .map((payment) => payment.id),
  );
  for (const allocation of state.allocations)
    if (periodIds.has(allocation.billingPeriodId))
      related.add(allocation.paymentId);
  const shared = new Set(
    state.allocations
      .filter(
        (allocation) =>
          related.has(allocation.paymentId) &&
          !periodIds.has(allocation.billingPeriodId),
      )
      .map((allocation) => allocation.paymentId),
  );
  return { periodIds, related, shared };
}
function buildPlan(state: State, payload: ObligationScheduleChange) {
  const obligation = state.obligations.find(
    (obligation) => obligation.id === payload.obligationId,
  );
  ensure(obligation, 'NOT_FOUND', 'Обязательство не найдено');
  ensure(
    isISODate(payload.activeFrom) &&
      isISODate(payload.anchor) &&
      (!payload.activeTo || isISODate(payload.activeTo)),
    'INVALID_DATE_RANGE',
    'Проверьте даты графика',
  );
  ensure(
    !payload.archive || payload.activeTo,
    'INVALID_DATE_RANGE',
    'Для архивации нужна дата окончания',
  );
  const cancelledBeforeStart =
    !!payload.archive &&
    !!payload.activeTo &&
    payload.activeTo <= payload.activeFrom;
  const activeTo = cancelledBeforeStart
    ? payload.activeFrom
    : (payload.activeTo ?? undefined);
  ensure(
    !activeTo || activeTo > payload.activeFrom || cancelledBeforeStart,
    'INVALID_DATE_RANGE',
    'Конец должен быть позже начала; для отмены до начала используйте архивацию или удаление',
  );
  const active = state.rules
    .filter((rule) => rule.obligationId === obligation.id && !rule.superseded)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  ensure(active.length, 'BROKEN_REFERENCE', 'График обязательства не найден');
  const latest = active.at(-1)!;
  const calendarChanged =
    latest.anchor !== payload.anchor ||
    latest.cadence !== payload.cadence ||
    latest.dueOffsetDays !== payload.dueOffsetDays;
  const firstIndex = active.reduce(
    (selected, rule, index) =>
      rule.effectiveFrom <= payload.activeFrom ? index : selected,
    0,
  );
  const chosen = active
    .slice(firstIndex)
    .filter(
      (rule, index) =>
        index === 0 || !activeTo || rule.effectiveFrom < activeTo,
    );
  const newRules: BillingRule[] = chosen.map((rule, index) => ({
    ...rule,
    id: stableId(
      `schedule:${obligation.id}:${state.revision}:${JSON.stringify(payload)}:${rule.id}`,
    ),
    superseded: undefined,
    effectiveFrom: index === 0 ? payload.activeFrom : rule.effectiveFrom,
    effectiveTo: chosen[index + 1]?.effectiveFrom,
    ...(calendarChanged
      ? {
          anchor: payload.anchor,
          cadence: payload.cadence,
          dueOffsetDays: payload.dueOffsetDays,
        }
      : {}),
  }));
  const blockedReasons: string[] = [];
  if (
    calendarChanged &&
    newRules.some(
      (rule, index) =>
        index > 0 && !intervalEnd(newRules[index - 1], rule.effectiveFrom),
    )
  )
    blockedReasons.push('SCHEDULE_PRICE_BOUNDARY');
  const nextObligation = {
    ...obligation,
    activeFrom: payload.activeFrom,
    activeTo,
    lifecycleState: payload.archive
      ? ('archived' as const)
      : obligation.lifecycleState,
  };
  const existing = state.periods.filter(
      (period) => period.obligationId === obligation.id,
    ),
    oldById = new Map(existing.map((period) => [period.id, period]));
  const horizon = existing.reduce(
    (end, period) => (period.periodEnd > end ? period.periodEnd : end),
    addMonths(payload.activeFrom, 12),
  );
  const to = activeTo && activeTo < horizon ? activeTo : horizon;
  const generated = blockedReasons.length
    ? existing
    : to > payload.activeFrom
      ? generatePeriods(
          {
            ...state,
            obligations: [nextObligation],
            rules: newRules,
            periods: [],
          },
          payload.activeFrom,
          to,
        )
      : [];
  const periods = generated.map((period) => {
    const old = oldById.get(period.id);
    // Existing amounts, waivers and rule references remain when the billing interval survives.
    if (old) {
      const kept = { ...old, dueDate: period.dueDate };
      if (kept.dueDate !== old.dueDate) {
        delete kept.baseExpectedAmount;
        delete kept.baseCurrency;
        delete kept.exchangeRate;
        delete kept.exchangeRateDate;
        delete kept.exchangeRateSource;
      }
      return kept;
    }
    return period;
  });
  const nextIds = new Set(periods.map((period) => period.id)),
    links = relationships(state, obligation.id);
  const removedPeriodIds = existing
    .filter((period) => !nextIds.has(period.id))
    .map((period) => period.id);
  const changedPeriodIds = periods
    .filter(
      (period) =>
        oldById.has(period.id) &&
        oldById.get(period.id)!.dueDate !== period.dueDate,
    )
    .map((period) => period.id);
  const createdPeriodIds = periods
    .filter((period) => !oldById.has(period.id))
    .map((period) => period.id);
  const outOfRange = state.payments.filter(
    (payment) =>
      links.related.has(payment.id) &&
      (payment.paidAt < payload.activeFrom ||
        (activeTo && payment.paidAt >= activeTo)),
  );
  const policy = payload.outOfRangePaymentPolicy;
  if (
    outOfRange.length &&
    policy === 'move_inside' &&
    activeTo === payload.activeFrom
  )
    blockedReasons.push('NO_DATES_INSIDE_RANGE');
  if (
    (policy === 'delete' || policy === 'move_inside') &&
    outOfRange.some((payment) => links.shared.has(payment.id))
  )
    blockedReasons.push('SHARED_PAYMENT_CONFLICT');
  const paymentDateChanges =
    policy === 'move_inside' && activeTo !== payload.activeFrom
      ? outOfRange.map((payment) => ({
          paymentId: payment.id,
          from: payment.paidAt,
          to:
            payment.paidAt < payload.activeFrom
              ? payload.activeFrom
              : addDays(activeTo!, -1),
        }))
      : [];
  if (
    paymentDateChanges.some((change) =>
      state.refunds.some(
        (refund) =>
          refund.originalPaymentId === change.paymentId &&
          refund.paidAt < change.to,
      ),
    )
  )
    blockedReasons.push('MOVE_AFTER_REFUND_DATE');
  const preview: ObligationSchedulePreview = {
    affectedPeriodIds: [
      ...removedPeriodIds,
      ...changedPeriodIds,
      ...createdPeriodIds,
    ],
    removedPeriodIds,
    createdPeriodIds,
    changedPeriodIds,
    preservedPeriodIds: periods
      .filter(
        (period) =>
          oldById.has(period.id) && !changedPeriodIds.includes(period.id),
      )
      .map((period) => period.id),
    affectedPaymentIds: [...links.related],
    outOfRangePaymentIds: outOfRange.map((payment) => payment.id),
    sharedPaymentIds: [...links.shared],
    paymentDateChanges,
    deletedPaymentIds:
      policy === 'delete' ? outOfRange.map((payment) => payment.id) : [],
    preservedCreditPaymentIds:
      policy === 'keep_credit' ? outOfRange.map((payment) => payment.id) : [],
    blockedReasons,
    periodsBefore: existing.length,
    periodsAfter: periods.length,
    normalizedActiveTo: activeTo,
    cancelledBeforeStart,
  };
  return { preview, nextObligation, newRules, periods, links };
}
export function previewObligationSchedule(
  state: State,
  payload: ObligationScheduleChange,
): ObligationSchedulePreview {
  return buildPlan(state, payload).preview;
}
/** Deterministic structural change used by the FX request collector and the authoritative transaction. */
export function installObligationSchedule(
  state: State,
  payload: ObligationScheduleChange,
) {
  const { preview, nextObligation, newRules, periods, links } = buildPlan(
    state,
    payload,
  );
  ensure(
    !preview.blockedReasons.includes('SCHEDULE_PRICE_BOUNDARY'),
    'SCHEDULE_PRICE_BOUNDARY',
    'Новый календарь не совпадает с датами существующих изменений цены. Сначала согласуйте границы версий цены с новым графиком.',
  );
  ensure(
    !preview.outOfRangePaymentIds.length || payload.outOfRangePaymentPolicy,
    'PAYMENT_POLICY_REQUIRED',
    'Выберите действие для платежей за пределами нового срока',
  );
  ensure(
    !preview.blockedReasons.length,
    preview.blockedReasons[0] ?? 'SCHEDULE_CHANGE_BLOCKED',
    preview.blockedReasons.includes('SHARED_PAYMENT_CONFLICT')
      ? 'Общий платёж относится и к другому обязательству: нельзя удалить его или изменить его дату. Выберите сохранение средств.'
      : preview.blockedReasons.includes('MOVE_AFTER_REFUND_DATE')
        ? 'Нельзя перенести платёж позже его возврата. Выберите сохранение средств.'
        : 'В пустом сроке нет даты для переноса платежей. Выберите сохранение средств или удаление.',
  );
  const removedPeriods = new Set(preview.removedPeriodIds),
    deletedPayments = new Set(preview.deletedPaymentIds),
    moved = new Set(
      preview.paymentDateChanges.map((change) => change.paymentId),
    ),
    outOfRange = new Set(preview.outOfRangePaymentIds);
  const removedAllocations = state.allocations.filter(
    (allocation) =>
      removedPeriods.has(allocation.billingPeriodId) ||
      deletedPayments.has(allocation.paymentId) ||
      (links.periodIds.has(allocation.billingPeriodId) &&
        (moved.has(allocation.paymentId) ||
          outOfRange.has(allocation.paymentId))),
  );
  const removedAllocationIds = new Set(
    removedAllocations.map((allocation) => allocation.id),
  );
  const details: Record<string, unknown> = {
    previousObligation: structuredClone(
      state.obligations.find(
        (obligation) => obligation.id === payload.obligationId,
      ),
    ),
    nextObligation: structuredClone(nextObligation),
    removedPeriods: state.periods.filter((period) =>
      removedPeriods.has(period.id),
    ),
    removedAllocations,
    paymentDateChanges: preview.paymentDateChanges,
    deletedPaymentIds: preview.deletedPaymentIds,
    outOfRangePaymentPolicy: payload.outOfRangePaymentPolicy ?? null,
  };
  state.obligations = state.obligations.map((obligation) =>
    obligation.id === payload.obligationId ? nextObligation : obligation,
  );
  for (const rule of state.rules)
    if (rule.obligationId === payload.obligationId) rule.superseded = true;
  state.rules.push(...newRules);
  state.periods = state.periods
    .filter((period) => period.obligationId !== payload.obligationId)
    .concat(periods);
  state.allocations = state.allocations.filter(
    (allocation) => !removedAllocationIds.has(allocation.id),
  );
  state.payments = state.payments.filter(
    (payment) => !deletedPayments.has(payment.id),
  );
  state.refunds = state.refunds.filter(
    (refund) => !deletedPayments.has(refund.originalPaymentId),
  );
  for (const payment of state.payments)
    if (links.related.has(payment.id) && !links.shared.has(payment.id))
      payment.obligationId = payload.obligationId;
  for (const change of preview.paymentDateChanges)
    state.payments.find((payment) => payment.id === change.paymentId)!.paidAt =
      change.to;
  state.automaticPaymentRuns = (state.automaticPaymentRuns ?? []).filter(
    (run) =>
      !removedPeriods.has(run.periodId) &&
      (!run.paymentId || !deletedPayments.has(run.paymentId)),
  );
  for (const run of state.automaticPaymentRuns)
    if (run.paymentId && moved.has(run.paymentId))
      run.paidAt = state.payments.find(
        (payment) => payment.id === run.paymentId,
      )!.paidAt;
  for (const schedule of state.automaticPayments ?? [])
    if (schedule.obligationId === payload.obligationId) {
      if (schedule.startDate < payload.activeFrom)
        schedule.startDate = payload.activeFrom;
      if (nextObligation.activeTo) {
        const end = addDays(nextObligation.activeTo, -1);
        if (!schedule.endDate || schedule.endDate > end) schedule.endDate = end;
      }
      if (
        payload.archive ||
        (schedule.endDate && schedule.endDate < schedule.startDate)
      ) {
        schedule.enabled = false;
        if (schedule.endDate && schedule.endDate < schedule.startDate)
          schedule.endDate = schedule.startDate;
      }
    }
  return {
    preview,
    details,
    revaluePeriodIds: [
      ...preview.createdPeriodIds,
      ...preview.changedPeriodIds,
    ],
    revaluePaymentIds: [...moved],
  };
}
export function applyObligationSchedule(
  state: State,
  payload: ObligationScheduleChange,
  context: CommandContext,
) {
  const result = installObligationSchedule(state, payload);
  for (const periodId of result.revaluePeriodIds)
    valuePeriod(
      state.periods.find((period) => period.id === periodId)!,
      state,
      context,
    );
  for (const paymentId of result.revaluePaymentIds) {
    const payment = state.payments.find((payment) => payment.id === paymentId)!;
    Object.assign(payment, valuePayment(payment, state, context));
    let original = 0,
      base = 0;
    for (const refund of state.refunds
      .filter((refund) => refund.originalPaymentId === paymentId)
      .sort(
        (a, b) => a.paidAt.localeCompare(b.paidAt) || a.id.localeCompare(b.id),
      )) {
      original = safeSum([original, refund.amount]);
      const converted = convertMinorAmount(
        original,
        payment.currency,
        state.household.currency,
        payment.exchangeRate!,
      );
      refund.baseAmount = converted - base;
      base = converted;
    }
  }
  settleObligationCredits(state, context, payload.obligationId);
  return result;
}
export function archiveSchedulePayload(
  state: State,
  obligationId: string,
  activeTo: string,
  outOfRangePaymentPolicy?: OutOfRangePaymentPolicy,
): ObligationScheduleChange {
  const obligation = state.obligations.find(
      (obligation) => obligation.id === obligationId,
    ),
    rule = state.rules
      .filter((rule) => rule.obligationId === obligationId && !rule.superseded)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  ensure(obligation && rule, 'NOT_FOUND', 'Обязательство не найдено');
  return {
    obligationId,
    activeFrom: obligation.activeFrom,
    activeTo,
    anchor: rule.anchor,
    cadence: rule.cadence,
    dueOffsetDays: rule.dueOffsetDays,
    outOfRangePaymentPolicy,
    archive: true,
  };
}
export function previewObligationDeletion(
  state: State,
  obligationId: string,
): ObligationDeletionPreview {
  ensure(
    state.obligations.some((obligation) => obligation.id === obligationId),
    'NOT_FOUND',
    'Обязательство не найдено',
  );
  const links = relationships(state, obligationId),
    totals = new Map<string, number>();
  for (const payment of state.payments)
    if (links.related.has(payment.id))
      totals.set(
        payment.currency,
        safeSum([totals.get(payment.currency) ?? 0, payment.amount]),
      );
  return {
    periodIds: [...links.periodIds],
    paymentIds: [...links.related],
    sharedPaymentIds: [...links.shared],
    refundIds: state.refunds
      .filter((refund) => links.related.has(refund.originalPaymentId))
      .map((refund) => refund.id),
    allocationIds: state.allocations
      .filter(
        (allocation) =>
          links.periodIds.has(allocation.billingPeriodId) ||
          links.related.has(allocation.paymentId),
      )
      .map((allocation) => allocation.id),
    automaticPaymentIds: (state.automaticPayments ?? [])
      .filter((schedule) => schedule.obligationId === obligationId)
      .map((schedule) => schedule.id),
    totalsByCurrency: [...totals].map(([currency, amount]) => ({
      currency,
      amount,
    })),
    blockedReasons: links.shared.size ? ['SHARED_PAYMENT_CONFLICT'] : [],
  };
}
export function deleteObligation(
  state: State,
  obligationId: string,
): ObligationDeletionPreview {
  const preview = previewObligationDeletion(state, obligationId);
  ensure(
    !preview.sharedPaymentIds.length,
    'SHARED_PAYMENT_CONFLICT',
    'Есть общий платёж с другим обязательством. Сначала разделите или перераспределите его; удаление отменено.',
  );
  const paymentIds = new Set(preview.paymentIds),
    periodIds = new Set(preview.periodIds);
  state.obligations = state.obligations.filter(
    (obligation) => obligation.id !== obligationId,
  );
  state.rules = state.rules.filter(
    (rule) => rule.obligationId !== obligationId,
  );
  state.periods = state.periods.filter((period) => !periodIds.has(period.id));
  state.payments = state.payments.filter(
    (payment) => !paymentIds.has(payment.id),
  );
  state.refunds = state.refunds.filter(
    (refund) => !paymentIds.has(refund.originalPaymentId),
  );
  state.allocations = state.allocations.filter(
    (allocation) =>
      !periodIds.has(allocation.billingPeriodId) &&
      !paymentIds.has(allocation.paymentId),
  );
  state.entitlements = state.entitlements.filter(
    (entitlement) => entitlement.obligationId !== obligationId,
  );
  state.automaticPayments = (state.automaticPayments ?? []).filter(
    (schedule) => schedule.obligationId !== obligationId,
  );
  state.automaticPaymentRuns = (state.automaticPaymentRuns ?? []).filter(
    (run) =>
      !periodIds.has(run.periodId) &&
      (!run.paymentId || !paymentIds.has(run.paymentId)),
  );
  return preview;
}

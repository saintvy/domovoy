import type {
  AllocationInput,
  BillingPeriod,
  Command,
  CommandContext,
  Payment,
  PeriodStatus,
  State,
} from './types';
import { ensure, isISODate, parseState, validateCommands } from './validation';
import {
  changeBaseCurrency,
  convertMinorAmount,
  paymentBaseAmount,
  periodBaseAmount,
  valuePayment,
  valuePeriod,
} from './currency';
import {
  allocateToPeriod,
  executeAutomaticPayments,
  settleObligationCredits,
} from './payments';
import { installBillingRuleChange, previewBillingRuleChange } from './billing';
import {
  applyObligationSchedule,
  archivePerson,
  archiveSchedulePayload,
  DEFAULT_NOBODY_COLOR,
  deletePerson,
  deleteObligation,
  NOBODY_PERSON_ID,
  restorePerson,
} from './lifecycle';

/** Stable UUID-shaped identifier for derived entities, never an authentication secret. */
export function stableId(key: string): string {
  const words = [2166136261, 2246822519, 3266489917, 668265263]
    .map((seed) => {
      let h = seed;
      for (let i = 0; i < key.length; i++)
        h = Math.imul(h ^ key.charCodeAt(i), 16777619);
      return (h >>> 0).toString(16).padStart(8, '0');
    })
    .join('');
  return `${words.slice(0, 8)}-${words.slice(8, 12)}-5${words.slice(13, 16)}-a${words.slice(17, 20)}-${words.slice(20, 32)}`;
}
export function paymentFingerprint(
  payment: Pick<
    Payment,
    | 'paidAt'
    | 'amount'
    | 'currency'
    | 'descriptor'
    | 'sourceAccountId'
    | 'externalRef'
  >,
): string {
  return stableId(
    JSON.stringify([
      payment.sourceAccountId ?? '',
      payment.externalRef ?? '',
      payment.paidAt,
      payment.amount,
      payment.currency,
      (payment.descriptor ?? '').trim().toLowerCase(),
    ]),
  );
}
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function addMonths(anchor: string, months: number): string {
  const [y, m, d] = anchor.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}
export function householdToday(state: State, now = new Date()): string {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: state.household.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const v = (t: string) => p.find((x) => x.type === t)!.value;
  return `${v('year')}-${v('month')}-${v('day')}`;
}
export function safeSum(values: number[]): number {
  const sum = values.reduce((a, b) => a + b, 0);
  ensure(
    Number.isSafeInteger(sum),
    'MONEY_RANGE',
    'Сумма выходит за безопасный диапазон',
  );
  return sum;
}
function groupBy<T>(
  items: readonly T[],
  key: (item: T) => string,
): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = result.get(k);
    if (group) group.push(item);
    else result.set(k, [item]);
  }
  return result;
}
function indexed<T extends { id: string }>(
  items: readonly T[],
): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}
function addTotal(
  totals: Map<string, number>,
  key: string,
  amount: number,
): void {
  const value = (totals.get(key) ?? 0) + amount;
  ensure(
    Number.isSafeInteger(value),
    'MONEY_RANGE',
    'Сумма выходит за безопасный диапазон',
  );
  totals.set(key, value);
}
/** Build once per immutable state revision for dashboards or exports with many queries. */
export function createFinancialIndex(state: State) {
  const byPeriod = new Map<string, number>(),
    byPeriodOriginal = new Map<string, number>(),
    byPayment = new Map<string, number>(),
    refunded = new Map<string, number>();
  for (const a of state.allocations)
    if (!a.reversedBy) {
      addTotal(byPeriod, a.billingPeriodId, a.amount);
      addTotal(byPeriodOriginal, a.billingPeriodId, a.periodAmount ?? a.amount);
      addTotal(byPayment, a.paymentId, a.amount);
    }
  for (const r of state.refunds)
    addTotal(refunded, r.originalPaymentId, r.baseAmount ?? r.amount);
  return {
    byPeriod,
    byPeriodOriginal,
    byPayment,
    refunded,
    payments: indexed(state.payments),
    rules: indexed(state.rules),
  };
}
export type FinancialIndex = ReturnType<typeof createFinancialIndex>;
export function paymentRemaining(
  state: State,
  paymentId: string,
  index?: FinancialIndex,
): number {
  const p = index
    ? index.payments.get(paymentId)
    : state.payments.find((x) => x.id === paymentId);
  ensure(p, 'NOT_FOUND', 'Платёж не найден');
  return (
    paymentBaseAmount(p) -
    (index
      ? (index.refunded.get(paymentId) ?? 0)
      : safeSum(
          state.refunds
            .filter((x) => x.originalPaymentId === paymentId)
            .map((x) => x.baseAmount ?? x.amount),
        )) -
    (index
      ? (index.byPayment.get(paymentId) ?? 0)
      : safeSum(
          state.allocations
            .filter((x) => x.paymentId === paymentId && !x.reversedBy)
            .map((x) => x.amount),
        ))
  );
}
export function getPeriodStatus(
  state: State,
  period: BillingPeriod,
  today: string,
  index?: FinancialIndex,
): PeriodStatus {
  const covered = index
    ? (index.byPeriodOriginal.get(period.id) ?? 0)
    : safeSum(
        state.allocations
          .filter((x) => x.billingPeriodId === period.id && !x.reversedBy)
          .map((x) => x.periodAmount ?? x.amount),
      );
  const rule = index
      ? index.rules.get(period.ruleVersionId)
      : state.rules.find((x) => x.id === period.ruleVersionId),
    expected = periodBaseAmount(state, period);
  const dataState =
    period.amountConfirmed && expected !== undefined
      ? 'confirmed'
      : expected !== undefined
        ? 'estimated'
        : 'unknown';
  const originalRemaining =
    period.expectedAmount === undefined
      ? undefined
      : Math.max(0, period.expectedAmount - covered);
  const remaining =
    expected === undefined || originalRemaining === undefined
      ? null
      : period.exchangeRate && rule
        ? convertMinorAmount(
            originalRemaining,
            rule.currency,
            state.household.currency,
            period.exchangeRate,
          )
        : originalRemaining;
  const allocated =
    expected === undefined || remaining === null
      ? 0
      : Math.max(0, expected - remaining);
  const settlementState = period.waiver
    ? 'waived'
    : dataState !== 'confirmed'
      ? 'undetermined'
      : originalRemaining === 0
        ? 'paid'
        : covered > 0
          ? 'partial'
          : 'unpaid';
  const timingState =
    today < period.dueDate
      ? 'upcoming'
      : today > addDays(period.dueDate, rule?.graceDays ?? 0)
        ? 'overdue'
        : 'due';
  return {
    settlementState,
    timingState,
    dataState,
    allocated,
    remaining,
    needsAction: settlementState !== 'paid' && settlementState !== 'waived',
  };
}
export const calculatePeriodStatus = getPeriodStatus;

/** Calendar forecast is pure. Persist only via a GeneratePeriods command. Window is [from,to). */
export function generatePeriods(
  state: State,
  from: string,
  to: string,
): BillingPeriod[] {
  ensure(
    isISODate(from) && isISODate(to) && from < to,
    'INVALID_RANGE',
    'Неверный диапазон начислений',
  );
  ensure(
    new Date(to).getTime() - new Date(from).getTime() <= 366 * 25 * 86400000,
    'RANGE_TOO_LARGE',
    'Запрашивайте не более 25 лет за один раз',
  );
  const periods = new Map(
    state.periods
      .filter((p) => p.periodStart < to && p.periodEnd > from)
      .map((p) => [p.id, p]),
  );
  const savedByObligation = groupBy(state.periods, (p) => p.obligationId),
    rulesByObligation = groupBy(state.rules, (r) => r.obligationId);
  const overlaps = (items: BillingPeriod[], start: string, end: string) => {
    let low = 0,
      high = items.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (items[middle].periodStart < end) low = middle + 1;
      else high = middle;
    }
    return low > 0 && items[low - 1].periodEnd > start;
  };
  for (const o of state.obligations) {
    const saved = (savedByObligation.get(o.id) ?? []).sort((a, b) =>
      a.periodStart.localeCompare(b.periodStart),
    );
    const savedStarts = new Set(saved.map((p) => p.periodStart));
    const generated: BillingPeriod[] = [];
    for (const r of (rulesByObligation.get(o.id) ?? [])
      .filter((rule) => !rule.superseded)
      .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))) {
      const step =
        r.cadence === 'monthly' ? 1 : r.cadence === 'quarterly' ? 3 : 12;
      const monthDelta =
        (Number(from.slice(0, 4)) - Number(r.anchor.slice(0, 4))) * 12 +
        Number(from.slice(5, 7)) -
        Number(r.anchor.slice(5, 7));
      const first = Math.max(
        0,
        r.cadence === 'weekly'
          ? Math.floor(
              (Date.parse(from) - Date.parse(r.anchor)) / (7 * 86400_000),
            ) - 1
          : Math.floor(monthDelta / step) - 1,
      );
      for (
        let n = first;
        n < first + (r.cadence === 'weekly' ? 1400 : 400);
        n++
      ) {
        const start =
            r.cadence === 'weekly'
              ? addDays(r.anchor, n * 7)
              : addMonths(r.anchor, n * step),
          end =
            r.cadence === 'weekly'
              ? addDays(r.anchor, (n + 1) * 7)
              : addMonths(r.anchor, (n + 1) * step);
        if (
          start >= to ||
          (r.effectiveTo && start >= r.effectiveTo) ||
          (o.activeTo && start >= o.activeTo)
        )
          break;
        if (end <= from || start < o.activeFrom || start < r.effectiveFrom)
          continue;
        const id = stableId(`${o.id}:${start}:${end}`);
        if (savedStarts.has(start)) continue;
        ensure(
          !overlaps(saved, start, end) && !overlaps(generated, start, end),
          'PERIOD_OVERLAP',
          'Графики начислений пересекаются',
        );
        const period = {
          id,
          obligationId: o.id,
          ruleVersionId: r.id,
          periodStart: start,
          periodEnd: end,
          dueDate: addDays(start, r.dueOffsetDays),
          expectedAmount: r.amount,
          amountConfirmed:
            r.amountMode !== 'estimate' && r.amount !== undefined,
        };
        periods.set(id, period);
        generated.push(period);
      }
    }
  }
  return [...periods.values()].sort(
    (a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id),
  );
}

export function validateState(input: unknown): State {
  const s = parseState(input);
  initializeDefaults(s);
  const groups = [
    s.people,
    s.providers,
    s.obligations,
    s.rules,
    s.periods,
    s.accounts,
    s.entitlements,
    s.payments,
    s.allocations,
    s.refunds,
    s.audit,
    s.automaticPayments!,
    s.automaticPaymentRuns!,
  ];
  const allIds = new Set<string>();
  for (const group of groups)
    for (const entity of group) {
      ensure(
        !allIds.has(entity.id),
        'DUPLICATE_ID',
        'Повторяющийся идентификатор',
      );
      allIds.add(entity.id);
    }
  const people = indexed(s.people),
    providers = indexed(s.providers),
    obligations = indexed(s.obligations),
    rules = indexed(s.rules),
    periods = indexed(s.periods),
    accounts = indexed(s.accounts),
    payments = indexed(s.payments),
    refunds = indexed(s.refunds);
  const rulesByObligation = groupBy(
      s.rules.filter((rule) => !rule.superseded),
      (r) => r.obligationId,
    ),
    periodsByObligation = groupBy(s.periods, (p) => p.obligationId);
  ensure(
    !people.has(NOBODY_PERSON_ID),
    'RESERVED_PERSON_ID',
    'Зарезервированный участник Никто не хранится в списке семьи',
  );
  const knownPerson = (personId: string) =>
    personId === NOBODY_PERSON_ID || people.has(personId);
  for (const o of s.obligations) {
    ensure(
      providers.has(o.providerId) &&
        (!o.ownerPersonId || knownPerson(o.ownerPersonId)),
      'BROKEN_REFERENCE',
      'Поставщик или ответственный не найден',
    );
    if (o.beneficiaries?.kind === 'people')
      ensure(
        o.beneficiaries.personIds.every(knownPerson),
        'BROKEN_REFERENCE',
        'Выгодоприобретатель не найден',
      );
    let previousThrough = '';
    for (const entry of o.attributionHistory ?? []) {
      ensure(
        entry.through > previousThrough &&
          (!entry.ownerPersonId || knownPerson(entry.ownerPersonId)) &&
          (entry.beneficiaries.kind !== 'people' ||
            entry.beneficiaries.personIds.every(knownPerson)),
        'INVALID_ATTRIBUTION_HISTORY',
        'История ответственных и бенефициаров повреждена',
      );
      previousThrough = entry.through;
    }
    if (o.beneficiaryArchive)
      ensure(
        o.beneficiaryArchive.personIds.every((id) => people.has(id)),
        'BROKEN_REFERENCE',
        'Архивный бенефициар не найден',
      );
    ensure(
      !o.activeTo ||
        o.activeTo > o.activeFrom ||
        (o.lifecycleState === 'archived' && o.activeTo === o.activeFrom),
      'INVALID_DATE_RANGE',
      'Конец обязательства должен быть позже начала',
    );
    ensure(
      o.coverageMode !== 'multi_account' || o.seatCapacity,
      'SEAT_CAPACITY',
      'Укажите число мест',
    );
  }
  for (const r of s.rules) {
    ensure(
      obligations.has(r.obligationId),
      'BROKEN_REFERENCE',
      'Обязательство правила не найдено',
    );
    ensure(
      s.household.currencies!.includes(r.currency),
      'CURRENCY_MISMATCH',
      'Добавьте валюту обязательства в настройки семьи',
    );
    ensure(
      !r.effectiveTo || r.effectiveTo > r.effectiveFrom,
      'INVALID_DATE_RANGE',
      'Неверный срок действия правила',
    );
    ensure(
      r.amountMode !== 'fixed' || r.amount !== undefined,
      'AMOUNT_REQUIRED',
      'Фиксированная цена обязательна',
    );
  }
  for (const versions of rulesByObligation.values()) {
    versions.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    for (let i = 1; i < versions.length; i++)
      ensure(
        (versions[i - 1].effectiveTo ?? '9999') <= versions[i].effectiveFrom,
        'RULE_OVERLAP',
        'Версии правила пересекаются',
      );
  }
  for (const p of s.periods) {
    const r = rules.get(p.ruleVersionId);
    ensure(
      r && r.obligationId === p.obligationId,
      'BROKEN_REFERENCE',
      'Правило начисления не найдено',
    );
    ensure(
      p.periodStart < p.periodEnd,
      'INVALID_DATE_RANGE',
      'Неверный интервал начисления',
    );
    ensure(
      !p.amountConfirmed || p.expectedAmount !== undefined,
      'AMOUNT_REQUIRED',
      'Подтверждённому начислению нужна сумма',
    );
    if (p.expectedAmount !== undefined) {
      ensure(
        p.baseCurrency === s.household.currency &&
          p.baseExpectedAmount !== undefined &&
          p.exchangeRate &&
          p.exchangeRateDate === p.dueDate &&
          p.exchangeRateSource,
        'EXCHANGE_RATE_REQUIRED',
        'Не сохранена конвертация начисления',
      );
      ensure(
        convertMinorAmount(
          p.expectedAmount,
          r.currency,
          s.household.currency,
          p.exchangeRate!,
        ) === p.baseExpectedAmount,
        'INVALID_EXCHANGE_RATE',
        'Сумма начисления не соответствует курсу',
      );
    }
  }
  for (const ps of periodsByObligation.values()) {
    ps.sort((a, b) => a.periodStart.localeCompare(b.periodStart));
    for (let i = 1; i < ps.length; i++)
      ensure(
        ps[i - 1].periodEnd <= ps[i].periodStart,
        'PERIOD_OVERLAP',
        'Начисления пересекаются',
      );
  }
  for (const a of s.accounts)
    ensure(
      providers.has(a.providerId),
      'BROKEN_REFERENCE',
      'Поставщик аккаунта не найден',
    );
  const seats = new Map<string, typeof s.entitlements>();
  const singleAccounts = new Map<string, typeof s.entitlements>();
  for (const e of s.entitlements) {
    const o = obligations.get(e.obligationId);
    ensure(
      o &&
        (!e.personId || knownPerson(e.personId)) &&
        (!e.serviceAccountId || accounts.has(e.serviceAccountId)),
      'BROKEN_REFERENCE',
      'Назначение содержит неизвестную ссылку',
    );
    ensure(
      e.personId || e.serviceAccountId,
      'EMPTY_ENTITLEMENT',
      'Укажите участника или сервисный аккаунт',
    );
    ensure(
      !e.validTo || e.validTo > e.validFrom,
      'INVALID_DATE_RANGE',
      'Неверный срок назначения',
    );
    if (e.serviceAccountId)
      ensure(
        accounts.get(e.serviceAccountId)!.providerId === o.providerId,
        'PROVIDER_MISMATCH',
        'Аккаунт другого поставщика',
      );
    if (o.coverageMode === 'multi_account') {
      ensure(
        e.seatNo && e.seatNo <= o.seatCapacity!,
        'SEAT_CAPACITY',
        'Место вне ёмкости подписки',
      );
      const key = `${o.id}:${e.seatNo}`,
        group = seats.get(key);
      if (group) group.push(e);
      else seats.set(key, [e]);
    }
    if (o.coverageMode === 'single_account' && e.serviceAccountId) {
      const group = singleAccounts.get(o.id);
      if (group) group.push(e);
      else singleAccounts.set(o.id, [e]);
    }
  }
  for (const es of seats.values()) {
    es.sort((a, b) => a.validFrom.localeCompare(b.validFrom));
    for (let i = 1; i < es.length; i++)
      ensure(
        (es[i - 1].validTo ?? '9999') <= es[i].validFrom,
        'SEAT_OVERLAP',
        'Место уже занято в этом интервале',
      );
  }
  for (const es of singleAccounts.values()) {
    es.sort((a, b) => a.validFrom.localeCompare(b.validFrom));
    let activeAccount = '',
      activeUntil = '';
    for (const e of es) {
      ensure(
        e.validFrom >= activeUntil || e.serviceAccountId === activeAccount,
        'ACCOUNT_OVERLAP',
        'Личная подписка покрывает только один сервисный аккаунт одновременно',
      );
      if (e.validFrom >= activeUntil) {
        activeAccount = e.serviceAccountId!;
        activeUntil = e.validTo ?? '9999';
      } else if ((e.validTo ?? '9999') > activeUntil)
        activeUntil = e.validTo ?? '9999';
    }
  }
  const allocated = new Map<string, number>(),
    refunded = new Map<string, number>(),
    originalAllocated = new Map<string, number>(),
    originalRefunded = new Map<string, number>();
  for (const a of s.allocations) {
    ensure(
      payments.has(a.paymentId) && periods.has(a.billingPeriodId),
      'BROKEN_REFERENCE',
      'Платёж или начисление не найдено',
    );
    ensure(
      !payments.get(a.paymentId)!.obligationId ||
        payments.get(a.paymentId)!.obligationId ===
          periods.get(a.billingPeriodId)!.obligationId,
      'OBLIGATION_MISMATCH',
      'Платёж относится к другому обязательству',
    );
    if (a.reversedBy)
      ensure(
        refunds.get(a.reversedBy)?.originalPaymentId === a.paymentId,
        'BROKEN_REFERENCE',
        'Возврат распределения не найден',
      );
    else {
      addTotal(allocated, a.paymentId, a.amount);
      addTotal(originalAllocated, a.paymentId, a.paymentAmount ?? a.amount);
    }
  }
  for (const r of s.refunds) {
    ensure(
      payments.has(r.originalPaymentId),
      'BROKEN_REFERENCE',
      'Исходный платёж возврата не найден',
    );
    ensure(
      r.paidAt >= payments.get(r.originalPaymentId)!.paidAt,
      'INVALID_REFUND_DATE',
      'Возврат не может предшествовать платежу',
    );
    addTotal(refunded, r.originalPaymentId, r.baseAmount ?? r.amount);
    addTotal(originalRefunded, r.originalPaymentId, r.amount);
  }
  for (const p of s.payments) {
    ensure(
      knownPerson(p.payerPersonId),
      'BROKEN_REFERENCE',
      'Плательщик не найден',
    );
    ensure(
      !p.obligationId || obligations.has(p.obligationId),
      'BROKEN_REFERENCE',
      'Обязательство платежа не найдено',
    );
    ensure(
      s.household.currencies!.includes(p.currency),
      'CURRENCY_MISMATCH',
      'Добавьте валюту платежа в настройки семьи',
    );
    ensure(
      p.baseCurrency === s.household.currency &&
        p.baseAmount !== undefined &&
        p.exchangeRate &&
        p.exchangeRateDate === p.paidAt &&
        p.exchangeRateSource,
      'EXCHANGE_RATE_REQUIRED',
      'Не сохранена конвертация платежа',
    );
    ensure(
      convertMinorAmount(
        p.amount,
        p.currency,
        s.household.currency,
        p.exchangeRate!,
      ) === p.baseAmount,
      'INVALID_EXCHANGE_RATE',
      'Сумма платежа не соответствует курсу',
    );
    ensure(
      (refunded.get(p.id) ?? 0) <= paymentBaseAmount(p) &&
        (allocated.get(p.id) ?? 0) <=
          paymentBaseAmount(p) - (refunded.get(p.id) ?? 0),
      'OVER_ALLOCATED',
      'Распределения и возвраты превышают платёж',
    );
    ensure(
      safeSum([
        originalRefunded.get(p.id) ?? 0,
        originalAllocated.get(p.id) ?? 0,
      ]) <= p.amount,
      'OVER_ALLOCATED',
      'Распределения и возвраты превышают исходный платёж',
    );
  }
  for (const schedule of s.automaticPayments!) {
    ensure(
      obligations.has(schedule.obligationId) &&
        knownPerson(schedule.payerPersonId),
      'BROKEN_REFERENCE',
      'Не найдено обязательство или плательщик автоплатежа',
    );
    ensure(
      !schedule.endDate || schedule.endDate >= schedule.startDate,
      'INVALID_DATE_RANGE',
      'Неверный срок автоплатежа',
    );
    ensure(
      !schedule.currency || s.household.currencies!.includes(schedule.currency),
      'CURRENCY_MISMATCH',
      'Не настроена валюта автоплатежа',
    );
  }
  const runKeys = new Set<string>();
  for (const run of s.automaticPaymentRuns!) {
    ensure(
      periods.has(run.periodId) &&
        (!run.paymentId || payments.has(run.paymentId)),
      'BROKEN_REFERENCE',
      'Не найдены данные выполненного автоплатежа',
    );
    const key = `${run.scheduleId}:${run.periodId}`;
    ensure(
      !runKeys.has(key),
      'DUPLICATE_AUTOMATIC_PAYMENT',
      'Автоплатёж за период уже выполнен',
    );
    runKeys.add(key);
  }
  return s;
}

const personColors = [
  '#3B82F6',
  '#E879A7',
  '#F59E0B',
  '#10B981',
  '#8B5CF6',
  '#06B6D4',
  '#EF4444',
  '#84CC16',
];
export const DEFAULT_HOUSEHOLD_COLOR = '#94A3B8';
/** Additive migration: old same-currency amounts retain their exact integer values. */
export function initializeDefaults(s: State): void {
  s.automaticPayments ??= [];
  s.automaticPaymentRuns ??= [];
  s.household.currencies ??= [s.household.currency];
  s.household.telegramReportTime ??= {
    hour: 9,
    timeZone: s.household.timezone,
  };
  s.household.color ??= DEFAULT_HOUSEHOLD_COLOR;
  s.household.nobodyColor ??= DEFAULT_NOBODY_COLOR;
  for (const [index, person] of s.people.entries())
    person.color ??= personColors[index % personColors.length];
  for (const obligation of s.obligations) {
    obligation.reminder ??= {
      enabled: !s.automaticPayments!.some(
        (schedule) =>
          schedule.obligationId === obligation.id && schedule.enabled,
      ),
      daysBefore: 1,
      repeat: 'daily',
    };
    if (!obligation.beneficiaries) {
      const ids = [
        ...new Set(
          s.entitlements
            .filter(
              (entitlement) =>
                entitlement.obligationId === obligation.id &&
                entitlement.personId,
            )
            .map((entitlement) => entitlement.personId!),
        ),
      ];
      obligation.beneficiaries =
        obligation.coverageMode === 'household' || !ids.length
          ? { kind: 'household' }
          : { kind: 'people', personIds: ids };
    }
  }
  for (const payment of s.payments)
    if (
      payment.baseAmount === undefined &&
      payment.currency === s.household.currency
    )
      Object.assign(payment, {
        baseAmount: payment.amount,
        baseCurrency: s.household.currency,
        exchangeRate: '1',
        exchangeRateDate: payment.paidAt,
        exchangeRateSource: 'identity',
      });
  const rules = new Map(s.rules.map((rule) => [rule.id, rule]));
  for (const period of s.periods)
    if (
      period.baseExpectedAmount === undefined &&
      period.expectedAmount !== undefined &&
      rules.get(period.ruleVersionId)?.currency === s.household.currency
    )
      Object.assign(period, {
        baseExpectedAmount: period.expectedAmount,
        baseCurrency: s.household.currency,
        exchangeRate: '1',
        exchangeRateDate: period.dueDate,
        exchangeRateSource: 'identity',
      });
  const payments = new Map(s.payments.map((payment) => [payment.id, payment])),
    periods = new Map(s.periods.map((period) => [period.id, period]));
  for (const allocation of s.allocations) {
    const payment = payments.get(allocation.paymentId),
      period = periods.get(allocation.billingPeriodId);
    if (!payment || !period) continue;
    if (allocation.paymentAmount === undefined)
      allocation.paymentAmount =
        paymentBaseAmount(payment) === 0
          ? 0
          : Number(
              (BigInt(allocation.amount) * BigInt(payment.amount) +
                BigInt(paymentBaseAmount(payment)) / 2n) /
                BigInt(paymentBaseAmount(payment)),
            );
    if (allocation.periodAmount === undefined)
      allocation.periodAmount =
        payment.currency === rules.get(period.ruleVersionId)?.currency
          ? allocation.paymentAmount
          : !period.baseExpectedAmount || period.expectedAmount === undefined
            ? allocation.amount
            : Number(
                (BigInt(allocation.amount) * BigInt(period.expectedAmount) +
                  BigInt(period.baseExpectedAmount) / 2n) /
                  BigInt(period.baseExpectedAmount),
              );
  }
}

export function applyCommands(
  state: State,
  input: Command[] | unknown,
  context: CommandContext,
): State {
  const commands = validateCommands(input);
  ensure(
    !state.audit.some((a) => a.operationId === context.operationId),
    'OPERATION_ALREADY_APPLIED',
    'Операция уже применена; проверьте сохранённый результат',
  );
  ensure(
    context.actorUserId &&
      context.operationId &&
      Number.isFinite(Date.parse(context.now)),
    'INVALID_CONTEXT',
    'Неверный контекст операции',
  );
  const s = structuredClone(state);
  initializeDefaults(s);
  const ensureAssignable = (personId: string | undefined) => {
    if (!personId) return;
    ensure(
      personId === NOBODY_PERSON_ID ||
        s.people.some(
          (person) => person.id === personId && person.archivedAt === undefined,
        ),
      'PERSON_NOT_ACTIVE',
      'Выберите активного члена семьи или Никого',
    );
  };
  const ensureAssignableBeneficiaries = (
    beneficiaries: import('./types').Beneficiaries | undefined,
  ) => {
    if (beneficiaries?.kind === 'people')
      for (const personId of beneficiaries.personIds)
        ensureAssignable(personId);
  };
  const allocations = (
    paymentId: string,
    items: AllocationInput[],
    effectiveDate?: string,
  ) => {
    const payment = s.payments.find((payment) => payment.id === paymentId);
    ensure(payment, 'NOT_FOUND', 'Платёж не найден');
    for (const item of items) {
      const period = s.periods.find(
        (period) => period.id === item.billingPeriodId,
      );
      ensure(period, 'NOT_FOUND', 'Начисление не найдено');
      const allocation = allocateToPeriod(s, payment, period, context, {
        id: item.id,
        baseBudget: item.amount,
        effectiveDate,
      });
      if (allocation) s.allocations.push(allocation);
    }
  };
  for (const [i, c] of commands.entries()) {
    const refs: string[] = [];
    let details: Record<string, unknown> | undefined;
    switch (c.type) {
      case 'AddPerson':
        ensure(
          c.payload.id !== NOBODY_PERSON_ID,
          'RESERVED_PERSON_ID',
          'Этот идентификатор зарезервирован для сущности Никто',
        );
        s.people.push(c.payload);
        refs.push(c.payload.id);
        break;
      case 'UpdatePerson': {
        const person = s.people.find(
          (person) => person.id === c.payload.personId,
        );
        ensure(person, 'NOT_FOUND', 'Член семьи не найден');
        Object.assign(person, c.payload.patch);
        refs.push(person.id);
        break;
      }
      case 'DeletePerson':
        deletePerson(s, c.payload.personId);
        refs.push(c.payload.personId);
        break;
      case 'ArchivePerson': {
        const today = householdToday(s, new Date(context.now));
        ensure(
          !c.payload.expectedDate || c.payload.expectedDate === today,
          'MEMBER_PREVIEW_EXPIRED',
          'Дата предпросмотра изменилась. Откройте подтверждение заново.',
        );
        const preview = archivePerson(
          s,
          c.payload.personId,
          c.payload.soleBeneficiaryPolicy,
          context,
          today,
        );
        details = {
          soleBeneficiaryObligationIds: preview.soleBeneficiaryObligationIds,
          stoppedObligations:
            c.payload.soleBeneficiaryPolicy === 'end_at_last_accrual'
              ? preview.stoppedObligations
              : [],
        };
        refs.push(c.payload.personId, ...preview.soleBeneficiaryObligationIds);
        break;
      }
      case 'RestorePerson': {
        ensure(
          !c.payload.expectedDate ||
            c.payload.expectedDate === householdToday(s, new Date(context.now)),
          'MEMBER_PREVIEW_EXPIRED',
          'Дата предпросмотра изменилась. Откройте подтверждение заново.',
        );
        const preview = restorePerson(
          s,
          c.payload.personId,
          c.payload.restoreBeneficiaries,
          householdToday(s, new Date(context.now)),
        );
        details = {
          restoredBeneficiaryObligationIds: c.payload.restoreBeneficiaries
            ? preview.restorableObligationIds
            : [],
        };
        refs.push(c.payload.personId, ...preview.restorableObligationIds);
        break;
      }
      case 'UpdateObligation': {
        const obligation = s.obligations.find(
          (obligation) => obligation.id === c.payload.obligationId,
        );
        ensure(obligation, 'NOT_FOUND', 'Обязательство не найдено');
        const { ownerPersonId, activeTo, ...rest } = c.payload.patch;
        if (ownerPersonId !== null) ensureAssignable(ownerPersonId);
        ensureAssignableBeneficiaries(rest.beneficiaries);
        ensure(
          activeTo === undefined ||
            (activeTo ?? undefined) === obligation.activeTo,
          'SCHEDULE_CHANGE_REQUIRED',
          'Изменяйте даты через редактор графика с предпросмотром последствий',
        );
        Object.assign(obligation, rest);
        if (rest.beneficiaries !== undefined)
          delete obligation.beneficiaryArchive;
        if (ownerPersonId !== undefined)
          obligation.ownerPersonId = ownerPersonId ?? undefined;
        refs.push(obligation.id);
        break;
      }
      case 'UpdateObligationSchedule': {
        const result = applyObligationSchedule(s, c.payload, context);
        details = result.details;
        refs.push(
          c.payload.obligationId,
          ...result.preview.affectedPeriodIds,
          ...result.preview.affectedPaymentIds,
        );
        break;
      }
      case 'DeleteObligation': {
        const preview = deleteObligation(s, c.payload.obligationId);
        details = {
          deletedPeriods: preview.periodIds.length,
          deletedPayments: preview.paymentIds.length,
          deletedRefunds: preview.refundIds.length,
        };
        refs.push(c.payload.obligationId, ...preview.paymentIds);
        break;
      }
      case 'AddAutomaticPayment':
        ensureAssignable(c.payload.schedule.payerPersonId);
        ensure(
          !s.automaticPayments!.some(
            (schedule) =>
              schedule.obligationId === c.payload.schedule.obligationId &&
              schedule.enabled,
          ),
          'AUTOMATIC_PAYMENT_EXISTS',
          'У обязательства уже есть автоплатёж',
        );
        s.automaticPayments!.push({
          ...c.payload.schedule,
          createdByUserId: context.actorUserId,
        });
        refs.push(c.payload.schedule.id);
        break;
      case 'DeleteAutomaticPayment': {
        const schedule = s.automaticPayments!.find(
          (schedule) => schedule.id === c.payload.scheduleId,
        );
        ensure(schedule, 'NOT_FOUND', 'Автоплатёж не найден');
        s.automaticPayments = s.automaticPayments!.filter(
          (item) => item.id !== schedule.id,
        );
        refs.push(schedule.id);
        break;
      }
      case 'ExecuteAutomaticPayments':
        ensure(
          context.allowAutomaticPayments === true,
          'AUTOMATIC_PAYMENT_SERVER_ONLY',
          'Автоплатежи запускает только сервер',
        );
        executeAutomaticPayments(s, c.payload.through, context);
        break;
      case 'AddObligation': {
        const p = c.payload;
        ensureAssignable(p.obligation.ownerPersonId);
        ensureAssignableBeneficiaries(p.obligation.beneficiaries);
        for (const entitlement of p.entitlements ?? [])
          ensureAssignable(entitlement.personId);
        const old = s.providers.find((x) => x.id === p.provider.id);
        ensure(
          !old || JSON.stringify(old) === JSON.stringify(p.provider),
          'PROVIDER_CONFLICT',
          'Поставщик с этим ID уже существует с другими данными',
        );
        if (!old) s.providers.push(p.provider);
        ensure(
          p.rule.obligationId === p.obligation.id &&
            p.provider.id === p.obligation.providerId,
          'BROKEN_REFERENCE',
          'Неверные ссылки нового обязательства',
        );
        s.obligations.push({
          ...p.obligation,
          createdByUserId: context.actorUserId,
        });
        s.rules.push(p.rule);
        s.accounts.push(...(p.accounts ?? []));
        s.entitlements.push(...(p.entitlements ?? []));
        refs.push(p.obligation.id);
        break;
      }
      case 'GeneratePeriods': {
        const ps = generatePeriods(s, c.payload.from, c.payload.to),
          existing = new Set(s.periods.map((p) => p.id));
        for (const p of ps)
          if (!existing.has(p.id)) {
            valuePeriod(p, s, context);
            s.periods.push(p);
            existing.add(p.id);
          }
        settleObligationCredits(s, context);
        break;
      }
      case 'RecordPaymentAndAllocate':
        ensureAssignable(c.payload.payment.payerPersonId);
        ensure(
          c.payload.payment.source === 'manual',
          'INVALID_SOURCE',
          'Ручной платёж должен иметь источник manual',
        );
        s.payments.push(
          valuePayment(
            { ...c.payload.payment, createdByUserId: context.actorUserId },
            s,
            context,
          ),
        );
        allocations(c.payload.payment.id, c.payload.allocations);
        settleObligationCredits(s, context, c.payload.payment.obligationId);
        refs.push(c.payload.payment.id);
        break;
      case 'AllocatePayment':
        allocations(c.payload.paymentId, c.payload.allocations);
        refs.push(c.payload.paymentId);
        break;
      case 'ImportPayments': {
        for (const payment of c.payload.payments)
          ensureAssignable(payment.payerPersonId);
        const ids = new Set(s.payments.map((p) => p.id)),
          externalRefs = new Set(
            s.payments
              .filter((p) => p.externalRef)
              .map((p) =>
                JSON.stringify([
                  p.source,
                  p.sourceAccountId ?? '',
                  p.externalRef,
                ]),
              ),
          );
        for (const input of c.payload.payments) {
          ensure(
            input.source === 'csv',
            'INVALID_SOURCE',
            'Импортируемый платёж должен иметь источник CSV',
          );
          const p = valuePayment(
              {
                ...input,
                importFingerprint: paymentFingerprint(input),
                createdByUserId: context.actorUserId,
              },
              s,
              context,
            ),
            ref = JSON.stringify([
              p.source,
              p.sourceAccountId ?? '',
              p.externalRef,
            ]);
          ensure(
            !ids.has(p.id) && (!p.externalRef || !externalRefs.has(ref)),
            'DUPLICATE_PAYMENT',
            'Этот платёж уже импортирован',
          );
          s.payments.push(p);
          ids.add(p.id);
          if (p.externalRef) externalRefs.add(ref);
          refs.push(p.id);
        }
        settleObligationCredits(s, context);
        break;
      }
      case 'RefundPayment': {
        const {
            refund,
            reverseAllocationIds,
            replacementAllocations = [],
          } = c.payload,
          payment = s.payments.find(
            (payment) => payment.id === refund.originalPaymentId,
          );
        ensure(payment, 'NOT_FOUND', 'Платёж не найден');
        ensure(
          refund.paidAt <= householdToday(s, new Date(context.now)),
          'PAYMENT_IN_FUTURE',
          'Возврат не может быть датирован будущим',
        );
        const prior = s.refunds.filter(
            (item) => item.originalPaymentId === payment.id,
          ),
          originalRefunded = safeSum(prior.map((item) => item.amount)),
          baseRefunded = safeSum(
            prior.map((item) => item.baseAmount ?? item.amount),
          );
        for (const id of reverseAllocationIds) {
          const allocation = s.allocations.find((item) => item.id === id);
          ensure(
            allocation &&
              allocation.paymentId === refund.originalPaymentId &&
              !allocation.reversedBy,
            'INVALID_REVERSAL',
            'Распределение не найдено или уже отменено',
          );
          allocation.reversedBy = refund.id;
        }
        const availableBase =
          paymentBaseAmount(payment) -
          baseRefunded -
          safeSum(
            s.allocations
              .filter(
                (allocation) =>
                  allocation.paymentId === payment.id && !allocation.reversedBy,
              )
              .map((allocation) => allocation.amount),
          );
        refund.baseAmount = Math.min(
          Math.max(0, availableBase),
          Math.max(
            0,
            convertMinorAmount(
              originalRefunded + refund.amount,
              payment.currency,
              s.household.currency,
              payment.exchangeRate!,
            ) - baseRefunded,
          ),
        );
        s.refunds.push(refund);
        allocations(
          refund.originalPaymentId,
          replacementAllocations,
          refund.paidAt,
        );
        refs.push(refund.id, refund.originalPaymentId);
        break;
      }
      case 'WaivePeriod': {
        const p = s.periods.find((x) => x.id === c.payload.periodId);
        ensure(p, 'NOT_FOUND', 'Начисление не найдено');
        ensure(!p.waiver, 'ALREADY_WAIVED', 'Начисление уже освобождено');
        p.waiver = {
          reason: c.payload.reason,
          actorUserId: context.actorUserId,
          createdAt: context.now,
        };
        refs.push(p.id);
        break;
      }
      case 'ConfirmPeriodAmount': {
        const p = s.periods.find((x) => x.id === c.payload.periodId);
        ensure(p, 'NOT_FOUND', 'Начисление не найдено');
        ensure(
          !p.amountConfirmed,
          'ALREADY_CONFIRMED',
          'Для изменения подтверждённого начисления нужна отдельная корректировка',
        );
        p.expectedAmount = c.payload.amount;
        p.amountConfirmed = true;
        valuePeriod(p, s, context);
        settleObligationCredits(s, context, p.obligationId);
        refs.push(p.id);
        break;
      }
      case 'ArchiveObligation': {
        const payload = archiveSchedulePayload(
            s,
            c.payload.obligationId,
            c.payload.activeTo,
            c.payload.outOfRangePaymentPolicy,
          ),
          result = applyObligationSchedule(s, payload, context);
        details = result.details;
        refs.push(
          c.payload.obligationId,
          ...result.preview.affectedPeriodIds,
          ...result.preview.affectedPaymentIds,
        );
        break;
      }
      case 'ChangeBillingRule': {
        const preview = previewBillingRuleChange(
          s,
          c.payload.rule,
          c.payload.fromPeriodId,
        );
        const changed = installBillingRuleChange(s, preview);
        for (const period of changed) valuePeriod(period, s, context);
        settleObligationCredits(s, context, c.payload.rule.obligationId);
        refs.push(preview.rule.id, ...preview.changedPeriodIds);
        break;
      }
      case 'UpdateHousehold': {
        const { currency, ...rest } = c.payload;
        Object.assign(s.household, rest);
        if (currency && currency !== s.household.currency)
          changeBaseCurrency(s, currency, context);
        settleObligationCredits(s, context);
        break;
      }
    }
    s.audit.push({
      id: stableId(`${context.operationId}:audit:${i}`),
      actorUserId: context.actorUserId,
      operationId: context.operationId,
      action: c.type,
      entityRefs: refs,
      serverTimestamp: context.now,
      ...('reason' in c.payload ? { reason: c.payload.reason } : {}),
      ...(details ? { details } : {}),
    });
  }
  s.revision++;
  return validateState(s);
}

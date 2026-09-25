import { z } from 'zod';
import type { Command, State } from './types';

export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
export function ensure(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new DomainError(code, message);
}
export function isISODate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number(value.slice(0, 4)) >= 1900 &&
    Number(value.slice(0, 4)) <= 2200 &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}
const id = z.string().uuid();
const date = z.string().refine((v) => {
  try {
    return isISODate(v);
  } catch {
    return false;
  }
}, 'Ожидается календарная дата YYYY-MM-DD');
const instant = z.string().datetime();
const text = z.string().trim().min(1).max(250);
const money = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveMoney = money.refine(
  (n) => n > 0,
  'Сумма должна быть положительной',
);
const currency = z.string().regex(/^[A-Z]{3}$/);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const timeZone = z.string().refine((v) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: v });
    return true;
  } catch {
    return false;
  }
}, 'Неизвестный часовой пояс');
const dailyReportTime = z
  .object({ hour: z.number().int().min(0).max(23), timeZone })
  .strict();
const reminder = z
  .object({
    enabled: z.boolean(),
    daysBefore: z.number().int().min(0).max(365),
    repeat: z.enum(['once', 'daily']),
  })
  .strict();
const beneficiaries = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('household') }).strict(),
  z
    .object({
      kind: z.literal('people'),
      personIds: z
        .array(id)
        .min(1)
        .max(1000)
        .refine((ids) => new Set(ids).size === ids.length),
    })
    .strict(),
]);
const attribution = z
  .object({
    through: date,
    ownerPersonId: id.optional(),
    beneficiaries,
  })
  .strict();
const beneficiaryArchive = z
  .object({
    personIds: z
      .array(id)
      .min(1)
      .max(1000)
      .refine((ids) => new Set(ids).size === ids.length),
    hadNobody: z.boolean(),
  })
  .strict();
const person = z
  .object({
    id,
    displayName: text,
    color: color.optional(),
    archivedAt: instant.optional(),
  })
  .strict();
const provider = z
  .object({
    id,
    name: text,
    category: text,
    website: z.string().url().optional(),
  })
  .strict();
const obligation = z
  .object({
    id,
    providerId: id,
    title: text,
    category: text.optional(),
    coverageMode: z.enum(['single_account', 'multi_account', 'household']),
    ownerPersonId: id.optional(),
    beneficiaries: beneficiaries.optional(),
    attributionHistory: z.array(attribution).max(1000).optional(),
    beneficiaryArchive: beneficiaryArchive.optional(),
    iconId: z.string().max(80).optional(),
    iconColor: color.optional(),
    createdByUserId: text.optional(),
    activeFrom: date,
    activeTo: date.optional(),
    lifecycleState: z.enum(['active', 'archived']),
    seatCapacity: z.number().int().min(1).max(1000).optional(),
    trialEnd: date.optional(),
    reminder: reminder.optional(),
  })
  .strict();
const rule = z
  .object({
    id,
    obligationId: id,
    effectiveFrom: date,
    effectiveTo: date.optional(),
    superseded: z.boolean().optional(),
    cadence: z.enum(['weekly', 'monthly', 'quarterly', 'yearly']),
    anchor: date,
    dueOffsetDays: z.number().int().min(-366).max(366),
    amountMode: z.enum(['fixed', 'variable-confirmed', 'estimate']),
    amount: money.optional(),
    currency,
    reminderDays: z.number().int().min(0).max(365),
    graceDays: z.number().int().min(0).max(365),
  })
  .strict();
const valuation = {
  baseCurrency: currency.optional(),
  exchangeRate: z
    .string()
    .regex(/^\d{1,20}(\.\d{1,18})?$/)
    .optional(),
  exchangeRateDate: date.optional(),
  exchangeRateSource: z.string().min(1).max(250).optional(),
};
const period = z
  .object({
    id,
    obligationId: id,
    ruleVersionId: id,
    periodStart: date,
    periodEnd: date,
    dueDate: date,
    expectedAmount: money.optional(),
    baseExpectedAmount: money.optional(),
    ...valuation,
    amountConfirmed: z.boolean(),
    waiver: z
      .object({ reason: text, actorUserId: text, createdAt: instant })
      .strict()
      .optional(),
  })
  .strict();
const account = z
  .object({
    id,
    providerId: id,
    label: text,
    usernameHint: z.string().max(250).optional(),
    externalUrl: z.string().url().optional(),
  })
  .strict();
const entitlement = z
  .object({
    id,
    obligationId: id,
    personId: id.optional(),
    serviceAccountId: id.optional(),
    seatNo: z.number().int().min(1).optional(),
    validFrom: date,
    validTo: date.optional(),
  })
  .strict();
const payment = z
  .object({
    id,
    paidAt: date,
    amount: positiveMoney,
    currency,
    payerPersonId: id,
    obligationId: id.optional(),
    automaticScheduleId: id.optional(),
    createdByUserId: text.optional(),
    baseAmount: money.optional(),
    ...valuation,
    source: z.enum(['manual', 'csv', 'automatic']),
    sourceAccountId: text.optional(),
    externalRef: text.optional(),
    descriptor: z.string().max(500).optional(),
    importFingerprint: z.string().max(1000).optional(),
  })
  .strict();
const paymentInput = payment.omit({
  baseAmount: true,
  baseCurrency: true,
  exchangeRate: true,
  exchangeRateDate: true,
  exchangeRateSource: true,
  automaticScheduleId: true,
  createdByUserId: true,
});
const allocationInput = z
  .object({ id, billingPeriodId: id, amount: positiveMoney })
  .strict();
const allocation = allocationInput
  .extend({
    amount: money,
    paymentAmount: money.optional(),
    periodAmount: money.optional(),
    paymentId: id,
    reversedBy: id.optional(),
    createdAt: instant,
    effectiveDate: date.optional(),
  })
  .strict();
const refund = z
  .object({
    id,
    originalPaymentId: id,
    paidAt: date,
    amount: positiveMoney,
    baseAmount: money.optional(),
    reason: text,
  })
  .strict();
const schedule = z
  .object({
    id,
    obligationId: id,
    payerPersonId: id,
    amount: positiveMoney.optional(),
    currency: currency.optional(),
    startDate: date,
    endDate: date.optional(),
    enabled: z.boolean(),
    createdByUserId: text.optional(),
  })
  .strict();
const automaticRun = z
  .object({
    id,
    scheduleId: id,
    periodId: id,
    paidAt: date,
    paymentId: id.optional(),
    status: z.enum(['paid', 'covered']),
  })
  .strict();
const householdFields = {
  name: text,
  color: color.optional(),
  nobodyColor: color.optional(),
  currency,
  currencies: z
    .array(currency)
    .min(1)
    .max(50)
    .refine((items) => new Set(items).size === items.length)
    .optional(),
  timezone: timeZone,
  locale: z.enum(['ru', 'en']),
  telegramReportTime: dailyReportTime.optional(),
};
const audit = z
  .object({
    id,
    actorUserId: text,
    action: text,
    entityRefs: z.array(id),
    operationId: text,
    serverTimestamp: instant,
    reason: text.optional(),
    details: z.record(z.unknown()).optional(),
  })
  .strict();
const paymentPolicy = z.enum(['delete', 'move_inside', 'keep_credit']);
const c = <T extends string, S extends z.ZodTypeAny>(type: T, payload: S) =>
  z.object({ type: z.literal(type), payload }).strict();
export const commandSchema = z.discriminatedUnion('type', [
  c('AddPerson', person.omit({ archivedAt: true })),
  c(
    'UpdatePerson',
    z
      .object({
        personId: id,
        patch: z
          .object({ displayName: text.optional(), color: color.optional() })
          .strict(),
      })
      .strict(),
  ),
  c('DeletePerson', z.object({ personId: id }).strict()),
  c(
    'ArchivePerson',
    z
      .object({
        personId: id,
        soleBeneficiaryPolicy: z.enum(['keep_nobody', 'end_at_last_accrual']),
        expectedDate: date.optional(),
      })
      .strict(),
  ),
  c(
    'RestorePerson',
    z
      .object({
        personId: id,
        restoreBeneficiaries: z.boolean(),
        expectedDate: date.optional(),
      })
      .strict(),
  ),
  c(
    'UpdateObligation',
    z
      .object({
        obligationId: id,
        patch: z
          .object({
            title: text.optional(),
            category: text.optional(),
            ownerPersonId: id.nullable().optional(),
            beneficiaries: beneficiaries.optional(),
            iconId: z.string().max(80).optional(),
            iconColor: color.optional(),
            reminder: reminder.optional(),
            activeTo: date.nullable().optional(),
          })
          .strict(),
      })
      .strict(),
  ),
  c(
    'UpdateObligationSchedule',
    z
      .object({
        obligationId: id,
        activeFrom: date,
        activeTo: date.nullable().optional(),
        anchor: date,
        cadence: z.enum(['weekly', 'monthly', 'quarterly', 'yearly']),
        dueOffsetDays: z.number().int().min(-366).max(366),
        outOfRangePaymentPolicy: paymentPolicy.optional(),
        archive: z.boolean().optional(),
      })
      .strict(),
  ),
  c('DeleteObligation', z.object({ obligationId: id }).strict()),
  c(
    'AddAutomaticPayment',
    z.object({ schedule: schedule.omit({ createdByUserId: true }) }).strict(),
  ),
  c('DeleteAutomaticPayment', z.object({ scheduleId: id }).strict()),
  c('ExecuteAutomaticPayments', z.object({ through: date }).strict()),
  c(
    'AddObligation',
    z
      .object({
        obligation: obligation.omit({
          createdByUserId: true,
          attributionHistory: true,
          beneficiaryArchive: true,
        }),
        provider,
        rule,
        accounts: z.array(account).optional(),
        entitlements: z.array(entitlement).optional(),
      })
      .strict(),
  ),
  c('GeneratePeriods', z.object({ from: date, to: date }).strict()),
  c(
    'RecordPaymentAndAllocate',
    z
      .object({
        payment: paymentInput,
        allocations: z.array(allocationInput).max(1000),
      })
      .strict(),
  ),
  c(
    'AllocatePayment',
    z
      .object({
        paymentId: id,
        allocations: z.array(allocationInput).max(1000),
      })
      .strict(),
  ),
  c(
    'RefundPayment',
    z
      .object({
        refund: refund.omit({ baseAmount: true }),
        reverseAllocationIds: z.array(id),
        replacementAllocations: z.array(allocationInput).optional(),
      })
      .strict(),
  ),
  c('WaivePeriod', z.object({ periodId: id, reason: text }).strict()),
  c('ConfirmPeriodAmount', z.object({ periodId: id, amount: money }).strict()),
  c(
    'ArchiveObligation',
    z
      .object({
        obligationId: id,
        activeTo: date,
        outOfRangePaymentPolicy: paymentPolicy.optional(),
      })
      .strict(),
  ),
  c(
    'ChangeBillingRule',
    z.object({ rule, fromPeriodId: id.optional() }).strict(),
  ),
  c('UpdateHousehold', z.object(householdFields).partial().strict()),
  c(
    'ImportPayments',
    z.object({ payments: z.array(paymentInput).min(1).max(1000) }).strict(),
  ),
]);
export const stateSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: money,
    household: z.object({ id, ...householdFields }).strict(),
    people: z.array(person),
    providers: z.array(provider),
    obligations: z.array(obligation),
    rules: z.array(rule),
    periods: z.array(period),
    accounts: z.array(account),
    entitlements: z.array(entitlement),
    payments: z.array(payment),
    allocations: z.array(allocation),
    refunds: z.array(refund),
    audit: z.array(audit),
    automaticPayments: z.array(schedule).default([]),
    automaticPaymentRuns: z.array(automaticRun).default([]),
  })
  .strict();
export function validateCommands(input: unknown): Command[] {
  const result = z.array(commandSchema).min(1).max(1000).safeParse(input);
  ensure(
    result.success,
    'INVALID_COMMAND',
    result.success
      ? ''
      : result.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; '),
  );
  return result.data as Command[];
}
export function parseState(input: unknown): State {
  const result = stateSchema.safeParse(input);
  ensure(
    result.success,
    'INVALID_STATE',
    result.success
      ? ''
      : result.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; '),
  );
  return result.data as State;
}

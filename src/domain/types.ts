export type ISODate = string;
export type Cadence = 'weekly' | 'monthly' | 'quarterly' | 'yearly';
export interface DailyReportTime {
  hour: number;
  timeZone: string;
}
export interface ReminderSettings {
  enabled: boolean;
  daysBefore: number;
  repeat: 'once' | 'daily';
}
export interface Household {
  id: string;
  name: string;
  color?: string;
  nobodyColor?: string;
  currency: string;
  currencies?: string[];
  timezone: string;
  locale: 'ru' | 'en';
  telegramReportTime?: DailyReportTime;
}
export interface Person {
  id: string;
  displayName: string;
  color?: string;
  archivedAt?: string;
}
export type Beneficiaries =
  { kind: 'household' } | { kind: 'people'; personIds: string[] };
export interface ObligationAttribution {
  through: ISODate;
  ownerPersonId?: string;
  beneficiaries: Beneficiaries;
}
export interface BeneficiaryArchive {
  personIds: string[];
  hadNobody: boolean;
}
export interface Provider {
  id: string;
  name: string;
  category: string;
  website?: string;
}
export interface Obligation {
  id: string;
  providerId: string;
  title: string;
  category?: string;
  coverageMode: 'single_account' | 'multi_account' | 'household';
  ownerPersonId?: string;
  beneficiaries?: Beneficiaries;
  attributionHistory?: ObligationAttribution[];
  beneficiaryArchive?: BeneficiaryArchive;
  iconId?: string;
  iconColor?: string;
  createdByUserId?: string;
  activeFrom: ISODate;
  activeTo?: ISODate;
  lifecycleState: 'active' | 'archived';
  seatCapacity?: number;
  trialEnd?: ISODate;
  reminder?: ReminderSettings;
}
export interface BillingRule {
  id: string;
  obligationId: string;
  effectiveFrom: ISODate;
  effectiveTo?: ISODate;
  superseded?: boolean;
  cadence: Cadence;
  anchor: ISODate;
  dueOffsetDays: number;
  amountMode: 'fixed' | 'variable-confirmed' | 'estimate';
  amount?: number;
  currency: string;
  reminderDays: number;
  graceDays: number;
}
export interface BaseValuation {
  baseAmount?: number;
  baseCurrency?: string;
  exchangeRate?: string;
  exchangeRateDate?: ISODate;
  exchangeRateSource?: string;
}
export interface BillingPeriod extends Omit<BaseValuation, 'baseAmount'> {
  id: string;
  obligationId: string;
  ruleVersionId: string;
  periodStart: ISODate;
  periodEnd: ISODate;
  dueDate: ISODate;
  expectedAmount?: number;
  baseExpectedAmount?: number;
  amountConfirmed: boolean;
  waiver?: { reason: string; actorUserId: string; createdAt: string };
}
export interface ServiceAccount {
  id: string;
  providerId: string;
  label: string;
  usernameHint?: string;
  externalUrl?: string;
}
export interface Entitlement {
  id: string;
  obligationId: string;
  personId?: string;
  serviceAccountId?: string;
  seatNo?: number;
  validFrom: ISODate;
  validTo?: ISODate;
}
export interface Payment extends BaseValuation {
  id: string;
  paidAt: ISODate;
  amount: number;
  currency: string;
  payerPersonId: string;
  obligationId?: string;
  automaticScheduleId?: string;
  createdByUserId?: string;
  source: 'manual' | 'csv' | 'automatic';
  sourceAccountId?: string;
  externalRef?: string;
  descriptor?: string;
  importFingerprint?: string;
}
export interface Allocation {
  id: string;
  paymentId: string;
  billingPeriodId: string;
  amount: number;
  paymentAmount?: number;
  periodAmount?: number;
  reversedBy?: string;
  createdAt: string;
  effectiveDate?: ISODate;
}
export interface Refund {
  id: string;
  originalPaymentId: string;
  paidAt: ISODate;
  amount: number;
  baseAmount?: number;
  reason: string;
}
export interface AutomaticPaymentSchedule {
  id: string;
  obligationId: string;
  payerPersonId: string;
  amount?: number;
  currency?: string;
  startDate: ISODate;
  endDate?: ISODate;
  enabled: boolean;
  createdByUserId?: string;
}
export interface AutomaticPaymentRun {
  id: string;
  scheduleId: string;
  periodId: string;
  paidAt: ISODate;
  paymentId?: string;
  status: 'paid' | 'covered';
}
export interface AuditEvent {
  id: string;
  actorUserId: string;
  action: string;
  entityRefs: string[];
  operationId: string;
  serverTimestamp: string;
  reason?: string;
  details?: Record<string, unknown>;
}
export type OutOfRangePaymentPolicy = 'delete' | 'move_inside' | 'keep_credit';
export interface ObligationScheduleChange {
  obligationId: string;
  activeFrom: ISODate;
  activeTo?: ISODate | null;
  anchor: ISODate;
  cadence: Cadence;
  dueOffsetDays: number;
  outOfRangePaymentPolicy?: OutOfRangePaymentPolicy;
  archive?: boolean;
}
export interface State {
  schemaVersion: 1;
  revision: number;
  household: Household;
  people: Person[];
  providers: Provider[];
  obligations: Obligation[];
  rules: BillingRule[];
  periods: BillingPeriod[];
  accounts: ServiceAccount[];
  entitlements: Entitlement[];
  payments: Payment[];
  allocations: Allocation[];
  refunds: Refund[];
  audit: AuditEvent[];
  automaticPayments?: AutomaticPaymentSchedule[];
  automaticPaymentRuns?: AutomaticPaymentRun[];
}
export type AllocationInput = Pick<
  Allocation,
  'id' | 'billingPeriodId' | 'amount'
>;
export type Command =
  | { type: 'AddPerson'; payload: Person }
  | {
      type: 'UpdatePerson';
      payload: {
        personId: string;
        patch: Partial<Pick<Person, 'displayName' | 'color'>>;
      };
    }
  | { type: 'DeletePerson'; payload: { personId: string } }
  | {
      type: 'ArchivePerson';
      payload: {
        personId: string;
        soleBeneficiaryPolicy: 'keep_nobody' | 'end_at_last_accrual';
        expectedDate?: ISODate;
      };
    }
  | {
      type: 'RestorePerson';
      payload: {
        personId: string;
        restoreBeneficiaries: boolean;
        expectedDate?: ISODate;
      };
    }
  | {
      type: 'UpdateObligation';
      payload: {
        obligationId: string;
        patch: Partial<
          Pick<
            Obligation,
            | 'title'
            | 'category'
            | 'beneficiaries'
            | 'iconId'
            | 'iconColor'
            | 'reminder'
          >
        > & { ownerPersonId?: string | null; activeTo?: ISODate | null };
      };
    }
  | { type: 'UpdateObligationSchedule'; payload: ObligationScheduleChange }
  | { type: 'DeleteObligation'; payload: { obligationId: string } }
  | {
      type: 'AddAutomaticPayment';
      payload: { schedule: AutomaticPaymentSchedule };
    }
  | { type: 'DeleteAutomaticPayment'; payload: { scheduleId: string } }
  | { type: 'ExecuteAutomaticPayments'; payload: { through: ISODate } }
  | {
      type: 'AddObligation';
      payload: {
        obligation: Obligation;
        provider: Provider;
        rule: BillingRule;
        accounts?: ServiceAccount[];
        entitlements?: Entitlement[];
      };
    }
  | { type: 'GeneratePeriods'; payload: { from: ISODate; to: ISODate } }
  | {
      type: 'RecordPaymentAndAllocate';
      payload: { payment: Payment; allocations: AllocationInput[] };
    }
  | {
      type: 'AllocatePayment';
      payload: { paymentId: string; allocations: AllocationInput[] };
    }
  | {
      type: 'RefundPayment';
      payload: {
        refund: Refund;
        reverseAllocationIds: string[];
        replacementAllocations?: AllocationInput[];
      };
    }
  | { type: 'WaivePeriod'; payload: { periodId: string; reason: string } }
  | {
      type: 'ConfirmPeriodAmount';
      payload: { periodId: string; amount: number };
    }
  | {
      type: 'ArchiveObligation';
      payload: {
        obligationId: string;
        activeTo: ISODate;
        outOfRangePaymentPolicy?: OutOfRangePaymentPolicy;
      };
    }
  | {
      type: 'ChangeBillingRule';
      payload: { rule: BillingRule; fromPeriodId?: string };
    }
  | {
      type: 'UpdateHousehold';
      payload: Partial<
        Pick<
          Household,
          | 'name'
          | 'color'
          | 'nobodyColor'
          | 'currency'
          | 'currencies'
          | 'timezone'
          | 'locale'
          | 'telegramReportTime'
        >
      >;
    }
  | { type: 'ImportPayments'; payload: { payments: Payment[] } };
export interface ExchangeRate {
  from: string;
  to: string;
  date: ISODate;
  rate: string;
  source: string;
}
export interface CommandContext {
  actorUserId: string;
  operationId: string;
  now: string;
  exchangeRates?: ExchangeRate[];
  allowAutomaticPayments?: boolean;
}
export interface PeriodStatus {
  settlementState: 'unpaid' | 'partial' | 'paid' | 'waived' | 'undetermined';
  timingState: 'upcoming' | 'due' | 'overdue';
  dataState: 'confirmed' | 'estimated' | 'unknown';
  allocated: number;
  remaining: number | null;
  needsAction: boolean;
}

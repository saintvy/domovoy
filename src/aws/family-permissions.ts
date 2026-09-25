import type { State } from '../domain';
import { check } from './identity';

type Actor = { id: string; role: string };
type Owned = { id: string; createdByUserId?: string };
const creates = new Set([
  'AddObligation',
  'RecordPaymentAndAllocate',
  'AddAutomaticPayment',
  'GeneratePeriods',
]);
const adminOnly = new Set([
  'UpdateHousehold',
  'AddPerson',
  'UpdatePerson',
  'DeletePerson',
  'ArchivePerson',
  'RestorePerson',
  'DeleteObligation',
]);
const allowedChanges = new Set([
  'UpdateObligation',
  'ArchiveObligation',
  'UpdateObligationSchedule',
  'ChangeBillingRule',
  'WaivePeriod',
  'ConfirmPeriodAmount',
  'AllocatePayment',
  'RefundPayment',
  'DeleteAutomaticPayment',
]);

/** Authorization uses persisted, server-assigned creators, never command creator fields. */
export function authorizeFamilyCommands(
  state: State,
  commands: any[],
  actor: Actor,
): void {
  const obligations = new Map<string, Owned>(
    state.obligations.map((value) => [value.id, value]),
  );
  const payments = new Map<string, Owned>(
    state.payments.map((value) => [value.id, value]),
  );
  const schedules = new Map<string, Owned>(
    (state.automaticPayments ?? []).map((value) => [value.id, value]),
  );
  const owns = (entity: Owned | undefined) =>
    Boolean(entity?.createdByUserId && entity.createdByUserId === actor.id);
  for (const command of commands) {
    const type = command.type,
      payload = command.payload ?? {};
    check(
      type !== 'ExecuteAutomaticPayments' && type !== 'ImportPayments',
      'FORBIDDEN',
      403,
    );
    if (adminOnly.has(type)) {
      check(actor.role === 'admin', 'FORBIDDEN', 403);
      continue;
    }
    if (creates.has(type)) {
      // Later commands in an atomic batch may refer to an entity just created by its actor.
      const addition =
        type === 'AddObligation'
          ? ([obligations, payload.obligation?.id] as const)
          : type === 'RecordPaymentAndAllocate'
            ? ([payments, payload.payment?.id] as const)
            : type === 'AddAutomaticPayment'
              ? ([schedules, payload.schedule?.id] as const)
              : undefined;
      if (
        addition &&
        typeof addition[1] === 'string' &&
        !addition[0].has(addition[1])
      )
        addition[0].set(addition[1], {
          id: addition[1],
          createdByUserId: actor.id,
        });
      continue;
    }
    if (actor.role === 'admin') continue; // Unknown commands still fail domain validation.
    check(
      allowedChanges.has(type) &&
        ['own_editor', 'deleter'].includes(actor.role),
      'FORBIDDEN',
      403,
    );
    if (actor.role === 'deleter') continue;
    let target: Owned | undefined;
    if (type === 'AllocatePayment') target = payments.get(payload.paymentId);
    else if (type === 'RefundPayment')
      target = payments.get(payload.refund?.originalPaymentId);
    else if (type === 'DeleteAutomaticPayment')
      target = schedules.get(payload.scheduleId);
    else {
      const obligationId =
        type === 'ChangeBillingRule'
          ? payload.rule?.obligationId
          : ['WaivePeriod', 'ConfirmPeriodAmount'].includes(type)
            ? state.periods.find((period) => period.id === payload.periodId)
                ?.obligationId
            : payload.obligationId;
      target = obligations.get(obligationId);
    }
    check(owns(target), 'FORBIDDEN', 403);
    const lifecycleEdit =
      ['UpdateObligationSchedule', 'ArchiveObligation'].includes(type) ||
      (type === 'UpdateObligation' &&
        (payload.patch?.activeFrom !== undefined ||
          payload.patch?.activeTo !== undefined));
    if (lifecycleEdit) {
      // Every lifecycle policy can change allocations, even keep_credit. An obligation's
      // creator must not indirectly edit another person's payments through this route.
      // Conservatively require ownership of every payment linked to this obligation.
      const periodIds = new Set(
        state.periods
          .filter((period) => period.obligationId === payload.obligationId)
          .map((period) => period.id),
      );
      const allocatedIds = new Set(
        state.allocations
          .filter((allocation) => periodIds.has(allocation.billingPeriodId))
          .map((allocation) => allocation.paymentId),
      );
      const affected = state.payments.filter(
        (payment) =>
          payment.obligationId === payload.obligationId ||
          allocatedIds.has(payment.id),
      );
      check(
        affected.every((payment) => owns(payments.get(payment.id))),
        'FORBIDDEN',
        403,
      );
      // Lifecycle edits also clamp or disable automatic schedules, including disabled
      // schedules. Their ownership is independent of the obligation's creator.
      const affectedSchedules = (state.automaticPayments ?? []).filter(
        (schedule) => schedule.obligationId === payload.obligationId,
      );
      check(
        affectedSchedules.every((schedule) => owns(schedules.get(schedule.id))),
        'FORBIDDEN',
        403,
      );
    }
  }
}

import { describe, it, expect } from 'vitest';
import {
  applyCommands,
  createEmptyState,
  householdToday,
  stableId,
  type Cadence,
  type State,
} from '../src/domain';
import { availableFamilyObligations } from '../src/client/family-availability';

const id = stableId;
const context = (operationId: string) => ({
  operationId,
  actorUserId: 'admin',
  now: '2026-09-30T12:00:00Z',
});
function setup(anchor = '2026-08-01', cadence: Cadence = 'monthly'): State {
  const state = createEmptyState();
  state.household.currency = 'EUR';
  return applyCommands(
    state,
    [
      { type: 'AddPerson', payload: { id: id('person'), displayName: 'Alex' } },
      {
        type: 'AddObligation',
        payload: {
          provider: { id: id('provider'), name: 'Provider', category: 'Music' },
          obligation: {
            id: id('service'),
            providerId: id('provider'),
            title: 'Music',
            coverageMode: 'household',
            ownerPersonId: id('person'),
            activeFrom: anchor,
            lifecycleState: 'active',
          },
          rule: {
            id: id('rule'),
            obligationId: id('service'),
            effectiveFrom: anchor,
            anchor,
            cadence,
            dueOffsetDays: 0,
            amountMode: 'fixed',
            amount: 1000,
            currency: 'EUR',
            reminderDays: 0,
            graceDays: 0,
          },
        },
      },
      { type: 'GeneratePeriods', payload: { from: anchor, to: '2028-03-01' } },
    ],
    context('setup'),
  );
}
function pay(state: State, paidAt: string) {
  return applyCommands(
    state,
    [
      {
        type: 'RecordPaymentAndAllocate',
        payload: {
          payment: {
            id: id('payment'),
            obligationId: id('service'),
            payerPersonId: id('person'),
            paidAt,
            amount: 1000,
            currency: 'EUR',
            source: 'manual',
          },
          allocations: [],
        },
      },
    ],
    context('pay'),
  );
}
function archive(
  state: State,
  activeTo: string,
  policy: 'keep_credit' | 'delete' = 'keep_credit',
) {
  return applyCommands(
    state,
    [
      {
        type: 'ArchiveObligation',
        payload: {
          obligationId: id('service'),
          activeTo,
          outOfRangePaymentPolicy: policy,
        },
      },
    ],
    context('archive'),
  );
}
const visible = (state: State, today: string) =>
  availableFamilyObligations(state, today).map((service) => service.id);

describe('family service availability on the household date', () => {
  it('includes an active unpaid service only inside its [start,end) dates', () => {
    const state = setup();
    state.obligations[0].activeTo = '2026-09-20';
    expect(visible(state, '2026-07-31')).toEqual([]);
    expect(visible(state, '2026-08-01')).toEqual([id('service')]);
    expect(visible(state, '2026-09-19')).toEqual([id('service')]);
    expect(visible(state, '2026-09-20')).toEqual([]);
  });
  it('retains an archived monthly service until payment date + one month, exclusively', () => {
    const state = archive(pay(setup(), '2026-09-12'), '2026-09-19');
    expect(visible(state, '2026-10-11')).toEqual([id('service')]);
    expect(visible(state, '2026-10-12')).toEqual([]);
    expect(state.obligations[0].lifecycleState).toBe('archived');
  });
  it('retains paid service after its active end date even without the archive flag', () => {
    const state = pay(setup(), '2026-09-12');
    state.obligations[0].activeTo = '2026-09-19';
    expect(visible(state, '2026-09-20')).toEqual([id('service')]);
  });
  it.each<[Cadence, string, string]>([
    ['monthly', '2026-01-31', '2026-02-28'],
    ['weekly', '2026-09-12', '2026-09-19'],
    ['quarterly', '2026-08-31', '2026-11-30'],
    ['yearly', '2024-02-29', '2025-02-28'],
  ])(
    'uses calendar %s boundaries, including month-end and leap years',
    (cadence, paidAt, end) => {
      const state = pay(setup(paidAt, cadence), paidAt);
      state.obligations[0].lifecycleState = 'archived';
      expect(visible(state, paidAt)).toEqual([id('service')]);
      expect(visible(state, end)).toEqual([]);
    },
  );
  it('shows electricity paid September 18 before its first September 24 billing date', () => {
    const state = pay(setup('2026-09-24'), '2026-09-18');
    expect(state.allocations.length).toBeGreaterThan(0);
    expect(visible(state, '2026-09-17')).toEqual([]);
    expect(visible(state, '2026-09-18')).toEqual([id('service')]);
    expect(visible(state, '2026-09-19')).toEqual([id('service')]);
    expect(
      availableFamilyObligations(state, '2026-09-19', 'responsible').map(
        (o) => o.id,
      ),
    ).toEqual([id('service')]);
  });
  it('uses the first scheduled cadence for unallocated advance credit and still respects refunds and expiry', () => {
    const state = pay(setup('2026-09-24'), '2026-09-18');
    state.allocations = [];
    expect(visible(state, '2026-09-19')).toEqual([id('service')]);
    state.obligations[0].lifecycleState = 'archived';
    expect(visible(state, '2026-10-17')).toEqual([id('service')]);
    expect(visible(state, '2026-10-18')).toEqual([]);
    state.refunds.push({
      id: id('advance-refund'),
      originalPaymentId: id('payment'),
      paidAt: '2026-09-19',
      amount: 1000,
      reason: 'Cancelled',
    });
    expect(visible(state, '2026-09-19')).toEqual([]);
  });
  it('shows responsibility for unpaid upcoming rent without claiming current use', () => {
    const state = setup('2026-09-25');
    expect(visible(state, '2026-09-19')).toEqual([]);
    expect(
      availableFamilyObligations(state, '2026-09-19', 'responsible').map(
        (o) => o.id,
      ),
    ).toEqual([id('service')]);
    expect(visible(state, '2026-09-25')).toEqual([id('service')]);
    state.obligations[0].lifecycleState = 'archived';
    expect(
      availableFamilyObligations(state, '2026-09-19', 'responsible'),
    ).toEqual([]);
    state.obligations[0].lifecycleState = 'active';
    state.obligations[0].activeTo = '2026-09-26';
    expect(
      availableFamilyObligations(state, '2026-09-26', 'responsible'),
    ).toEqual([]);
  });
  it('ignores future payment dates and archived unpaid obligations', () => {
    const state = pay(setup(), '2026-09-20');
    state.obligations[0].lifecycleState = 'archived';
    expect(visible(state, '2026-09-19')).toEqual([]);
    state.payments = [];
    state.allocations = [];
    expect(visible(state, '2026-09-21')).toEqual([]);
  });
  it('a full refund ends paid visibility; a partial refund retains it without inventing prorated days', () => {
    let state = archive(pay(setup(), '2026-09-12'), '2026-09-19');
    state = applyCommands(
      state,
      [
        {
          type: 'RefundPayment',
          payload: {
            refund: {
              id: id('refund-part'),
              originalPaymentId: id('payment'),
              paidAt: '2026-09-19',
              amount: 200,
              reason: 'Partial',
            },
            reverseAllocationIds: state.allocations
              .filter((a) => !a.reversedBy)
              .map((a) => a.id),
          },
        },
      ],
      context('partial'),
    );
    expect(visible(state, '2026-09-20')).toEqual([id('service')]);
    state = applyCommands(
      state,
      [
        {
          type: 'RefundPayment',
          payload: {
            refund: {
              id: id('refund-full'),
              originalPaymentId: id('payment'),
              paidAt: '2026-09-21',
              amount: 800,
              reason: 'Remaining',
            },
            reverseAllocationIds: state.allocations
              .filter((a) => !a.reversedBy)
              .map((a) => a.id),
          },
        },
      ],
      context('full'),
    );
    expect(visible(state, '2026-09-20')).toEqual([id('service')]);
    expect(visible(state, '2026-09-21')).toEqual([]);
  });
  it('kept credit outside an archived range still covers its payment cadence; deleted payment does not', () => {
    const state = pay(setup(), '2026-09-12');
    const kept = archive(state, '2026-08-01'),
      deleted = archive(state, '2026-08-01', 'delete');
    expect(kept.allocations).toHaveLength(0);
    expect(visible(kept, '2026-09-19')).toEqual([id('service')]);
    expect(visible(deleted, '2026-09-19')).toEqual([]);
  });
  it('legacy allocated payments provide coverage only through live allocations, not reversed or missing periods', () => {
    const state = pay(setup(), '2026-09-12');
    state.obligations[0].lifecycleState = 'archived';
    delete state.payments[0].obligationId;
    expect(visible(state, '2026-09-19')).toEqual([id('service')]);
    const saved = structuredClone(state.allocations);
    state.allocations.forEach((a) => {
      a.reversedBy = id('refund');
    });
    expect(visible(state, '2026-09-19')).toEqual([]);
    state.allocations = saved;
    state.periods = [];
    expect(visible(state, '2026-09-19')).toEqual([]);
  });
  it('uses the paid period historical cadence instead of a subsequently changed schedule', () => {
    const state = pay(setup(), '2026-09-12');
    state.obligations[0].lifecycleState = 'archived';
    state.rules[0].superseded = true;
    state.rules.push({
      ...state.rules[0],
      id: id('yearly-new'),
      cadence: 'yearly',
      superseded: false,
    });
    expect(visible(state, '2026-10-12')).toEqual([]);
  });
  it('uses the household date across UTC midnight without mutating financial history', () => {
    const state = archive(pay(setup(), '2026-08-19'), '2026-09-01');
    state.household.timezone = 'Europe/Prague';
    const original = structuredClone(state);
    expect(
      visible(state, householdToday(state, new Date('2026-09-18T21:59:59Z'))),
    ).toEqual([id('service')]);
    expect(
      visible(state, householdToday(state, new Date('2026-09-18T22:00:00Z'))),
    ).toEqual([]);
    expect(state).toEqual(original);
  });
});

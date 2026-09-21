import { describe, expect, it } from 'vitest';
import {
  applyCommands,
  createEmptyState,
  stableId,
  type State,
} from '../src/domain';
import { groupMonthlyObligations } from '../src/client/monthly-obligations';

const id = stableId;

function weekly(): State {
  const state = createEmptyState();
  state.people.push({ id: id('person'), displayName: 'Alex' });
  return applyCommands(
    state,
    [
      {
        type: 'AddObligation',
        payload: {
          provider: {
            id: id('provider'),
            name: 'School',
            category: 'Education',
          },
          obligation: {
            id: id('school'),
            providerId: id('provider'),
            title: 'School is fun',
            coverageMode: 'single_account',
            ownerPersonId: id('person'),
            activeFrom: '2026-09-07',
            lifecycleState: 'active',
          },
          rule: {
            id: id('rule'),
            obligationId: id('school'),
            effectiveFrom: '2026-09-07',
            anchor: '2026-09-07',
            cadence: 'weekly',
            dueOffsetDays: 0,
            amountMode: 'fixed',
            amount: 18000,
            currency: 'CZK',
            reminderDays: 1,
            graceDays: 0,
          },
        },
      },
      {
        type: 'GeneratePeriods',
        payload: { from: '2026-09-01', to: '2026-10-01' },
      },
    ],
    {
      actorUserId: 'admin',
      operationId: 'weekly-setup',
      now: '2026-09-01T10:00:00Z',
    },
  );
}

function cover(state: State, indexes: number[], amount = 18000) {
  const periods = state.periods.filter(
    (period) => period.obligationId === id('school'),
  );
  for (const index of indexes) {
    const paymentId = id(`payment-${index}`);
    state.payments.push({
      id: paymentId,
      obligationId: id('school'),
      paidAt: periods[index].dueDate,
      amount,
      currency: 'CZK',
      payerPersonId: id('person'),
      source: 'manual',
    });
    state.allocations.push({
      id: id(`allocation-${index}`),
      paymentId,
      billingPeriodId: periods[index].id,
      amount,
      createdAt: periods[index].dueDate + 'T10:00:00Z',
    });
  }
}

describe('monthly obligation rows', () => {
  it('groups weekly charges and reports the paid share against the monthly total', () => {
    const state = weekly();
    cover(state, [0, 1]);
    const rows = groupMonthlyObligations(state, state.periods, '2026-09-15');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      expected: 72000,
      allocated: 36000,
      remaining: 36000,
      status: 'due',
      needsAction: true,
    });
    expect(rows[0].periods.map((period) => period.dueDate)).toEqual([
      '2026-09-07',
      '2026-09-14',
      '2026-09-21',
      '2026-09-28',
    ]);
    expect(rows[0].representative.dueDate).toBe('2026-09-21');
  });

  it('marks the whole row overdue when any unpaid occurrence is overdue', () => {
    const state = weekly();
    cover(state, [0], 9000);
    const row = groupMonthlyObligations(state, state.periods, '2026-09-15')[0];
    expect(row.status).toBe('overdue');
    expect(row.allocated).toBe(9000);
    expect(row.representative.dueDate).toBe('2026-09-07');
  });

  it('marks the group paid only when every occurrence is settled', () => {
    const state = weekly();
    cover(state, [0, 1, 2, 3]);
    const row = groupMonthlyObligations(state, state.periods, '2026-09-30')[0];
    expect(row).toMatchObject({
      expected: 72000,
      allocated: 72000,
      remaining: 0,
      status: 'paid',
      needsAction: false,
    });
  });
});

import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
import {
  applyCommands,
  createEmptyState,
  createFinancialIndex,
  exportState,
  generatePeriods,
  getPeriodStatus,
  paymentRemaining,
  stableId,
  validateExport,
  validateState,
  type State,
} from '../src/domain';

function twentyYears(): State {
  const state = createEmptyState();
  const personId = stableId('scale-person'),
    providerId = stableId('scale-provider');
  state.people.push({ id: personId, displayName: 'Scale test person' });
  state.providers.push({
    id: providerId,
    name: 'Scale provider',
    category: 'Household',
  });
  for (let n = 0; n < 500; n++) {
    const obligationId = stableId(`scale-obligation-${n}`);
    state.obligations.push({
      id: obligationId,
      providerId,
      title: `Obligation ${n}`,
      ownerPersonId: personId,
      coverageMode: 'household',
      activeFrom: '2006-01-01',
      lifecycleState: 'active',
    });
    state.rules.push({
      id: stableId(`scale-rule-${n}`),
      obligationId,
      effectiveFrom: '2006-01-01',
      anchor: '2006-01-01',
      cadence: 'monthly',
      dueOffsetDays: 0,
      amountMode: 'fixed',
      amount: 10000 + n,
      currency: 'CZK',
      reminderDays: 3,
      graceDays: 0,
    });
  }
  state.periods = generatePeriods(state, '2006-01-01', '2026-01-01');
  for (const [n, period] of state.periods.entries()) {
    const paymentId = stableId(`scale-payment-${n}`);
    state.payments.push({
      id: paymentId,
      paidAt: period.dueDate,
      amount: period.expectedAmount!,
      currency: 'CZK',
      payerPersonId: personId,
      source: 'manual',
    });
    state.allocations.push({
      id: stableId(`scale-allocation-${n}`),
      paymentId,
      billingPeriodId: period.id,
      amount: period.expectedAmount!,
      createdAt: `${period.dueDate}T12:00:00Z`,
    });
  }
  return state;
}

describe('Domain scale (local Node; not an RDS/Lambda capacity claim)', () => {
  it('validates, queries, commits and restores 500 monthly obligations over 20 years', async () => {
    const started = performance.now(),
      timings: Record<string, number> = {};
    let tick = started;
    const mark = async (name: string) => {
      const now = performance.now();
      timings[name] = Math.round(now - tick);
      // Let the worker acknowledge reporter messages between CPU-heavy stages.
      await setImmediate();
      tick = performance.now();
    };
    let state = twentyYears();
    await mark('fixtureAndGenerationMs');
    expect(state.periods).toHaveLength(120_000);
    expect(state.payments).toHaveLength(120_000);
    expect(state.allocations).toHaveLength(120_000);
    state = validateState(state);
    await mark('validationMs');
    const financial = createFinancialIndex(state);
    for (const period of state.periods)
      expect(
        getPeriodStatus(state, period, '2026-01-01', financial).settlementState,
      ).toBe('paid');
    for (const payment of state.payments)
      expect(paymentRemaining(state, payment.id, financial)).toBe(0);
    await mark('indexAndAllFinancialQueriesMs');
    const month = generatePeriods(state, '2025-12-01', '2026-01-01');
    expect(month).toHaveLength(500);
    await mark('monthQueryMs');
    const committed = applyCommands(
      state,
      [
        { type: 'UpdateHousehold', payload: { name: 'After scale commit' } },
        {
          type: 'GeneratePeriods',
          payload: { from: '2025-12-01', to: '2026-01-01' },
        },
      ],
      {
        actorUserId: 'scale-admin',
        operationId: 'scale-commit',
        now: '2026-01-01T00:00:00Z',
      },
    );
    expect(committed.revision).toBe(1);
    expect(committed.periods).toHaveLength(120_000);
    expect(state.household.name).toBe('Наш дом');
    await mark('domainCommitMs');
    const exported = await exportState(committed, '2026-01-01T00:00:00Z');
    await mark('validatedExportAndChecksumMs');
    const encoded = JSON.stringify(exported),
      exportBytes = Buffer.byteLength(encoded, 'utf8');
    await mark('serializeMs');
    const restored = await validateExport(encoded);
    await mark('coldJsonRestoreAndChecksumMs');
    expect(restored).not.toBe(committed);
    expect(restored.revision).toBe(committed.revision);
    expect(restored.household.name).toBe('After scale commit');
    expect(restored.periods.map((p) => p.id)).toEqual(
      committed.periods.map((p) => p.id),
    );
    expect(
      restored.allocations.map((a) => [
        a.paymentId,
        a.billingPeriodId,
        a.amount,
      ]),
    ).toEqual(
      committed.allocations.map((a) => [
        a.paymentId,
        a.billingPeriodId,
        a.amount,
      ]),
    );
    expect(restored.payments.reduce((sum, p) => sum + p.amount, 0)).toBe(
      1_229_940_000,
    );
    expect(exportBytes).toBeGreaterThan(50_000_000);
    // Broad guard catches accidental O(n²) scans, without asserting a workstation speed target.
    for (const milliseconds of Object.values(timings))
      expect(milliseconds).toBeLessThan(120_000);
    console.info(
      'AC35_DOMAIN_MEASUREMENTS',
      JSON.stringify({
        records: {
          obligations: 500,
          periods: 120_000,
          payments: 120_000,
          allocations: 120_000,
        },
        exportBytes,
        ...timings,
        totalMs: Math.round(performance.now() - started),
      }),
    );
  }, 180_000);
});

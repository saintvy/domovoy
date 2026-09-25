import { describe, expect, it } from 'vitest';
import {
  applyCommands,
  createEmptyState,
  DEFAULT_NOBODY_COLOR,
  exportPeriodCsv,
  monthlyFinancialSeries,
  NOBODY_PERSON_ID,
  personAttributionForDate,
  previewPersonLifecycle,
  stableId,
  type Command,
  type CommandContext,
  type State,
} from '../src/domain';

const id = stableId;
let sequence = 0;
function apply(
  state: State,
  commands: Command[],
  now = '2026-03-15T12:00:00Z',
): State {
  return applyCommands(state, commands, {
    actorUserId: 'admin-account',
    operationId: `member-lifecycle-${++sequence}`,
    now,
  });
}

function setup(): State {
  return apply(createEmptyState(), [
    {
      type: 'AddPerson',
      payload: { id: id('alice'), displayName: 'Alice', color: '#E879A7' },
    },
    {
      type: 'AddPerson',
      payload: { id: id('bob'), displayName: 'Bob', color: '#3B82F6' },
    },
    {
      type: 'AddObligation',
      payload: {
        provider: { id: id('provider'), name: 'School', category: 'Family' },
        obligation: {
          id: id('obligation'),
          providerId: id('provider'),
          title: 'Tuition',
          coverageMode: 'household',
          ownerPersonId: id('alice'),
          beneficiaries: { kind: 'people', personIds: [id('alice')] },
          activeFrom: '2026-01-01',
          lifecycleState: 'active',
        },
        rule: {
          id: id('rule'),
          obligationId: id('obligation'),
          effectiveFrom: '2026-01-01',
          anchor: '2026-01-01',
          cadence: 'monthly',
          dueOffsetDays: 0,
          amountMode: 'fixed',
          amount: 10_000,
          currency: 'CZK',
          graceDays: 0,
          reminderDays: 0,
        },
        entitlements: [
          {
            id: id('entitlement'),
            obligationId: id('obligation'),
            personId: id('alice'),
            validFrom: '2026-01-01',
          },
        ],
      },
    },
    {
      type: 'AddAutomaticPayment',
      payload: {
        schedule: {
          id: id('schedule'),
          obligationId: id('obligation'),
          payerPersonId: id('alice'),
          startDate: '2026-01-01',
          enabled: true,
        },
      },
    },
    {
      type: 'GeneratePeriods',
      payload: { from: '2026-01-01', to: '2026-07-01' },
    },
  ]);
}

describe('family member lifecycle', () => {
  it('does not accept client-supplied lifecycle metadata or archived person creation', () => {
    const state = setup();
    expect(() =>
      apply(state, [
        {
          type: 'AddPerson',
          payload: {
            id: id('forged'),
            displayName: 'Forged',
            archivedAt: '2026-01-01T00:00:00Z',
          },
        },
      ]),
    ).toThrow();
    expect(() =>
      apply(state, [
        {
          type: 'UpdateObligation',
          payload: {
            obligationId: id('obligation'),
            patch: {
              beneficiaryArchive: {
                personIds: [id('alice')],
                hadNobody: false,
              },
            },
          },
        } as unknown as Command,
      ]),
    ).toThrow();
  });

  it('retains prepaid automatic runs and payments beyond a stopped term without duplicate execution', () => {
    const context: CommandContext = {
      actorUserId: 'system',
      operationId: 'autopay-fixture',
      now: '2026-05-15T12:00:00Z',
      allowAutomaticPayments: true,
    };
    const paid = applyCommands(
      setup(),
      [
        {
          type: 'ExecuteAutomaticPayments',
          payload: { through: '2026-05-15' },
        },
      ],
      context,
    );
    const stopped = apply(paid, [
      {
        type: 'ArchivePerson',
        payload: {
          personId: id('alice'),
          soleBeneficiaryPolicy: 'end_at_last_accrual',
        },
      },
    ]);
    expect(stopped.payments).toEqual(paid.payments);
    expect(stopped.allocations).toEqual(paid.allocations);
    expect(stopped.automaticPaymentRuns).toEqual(paid.automaticPaymentRuns);
    for (const run of paid.automaticPaymentRuns ?? [])
      expect(stopped.periods.some((p) => p.id === run.periodId)).toBe(true);
    const again = applyCommands(
      stopped,
      [
        {
          type: 'ExecuteAutomaticPayments',
          payload: { through: '2026-06-15' },
        },
      ],
      {
        ...context,
        operationId: 'autopay-after-stop',
        now: '2026-06-15T12:00:00Z',
      },
    );
    expect(again.payments).toEqual(paid.payments);
  });

  it('previews distant future and old ended obligations without losing their term', () => {
    const future = setup();
    future.periods = [];
    future.obligations[0].activeFrom = '2030-01-01';
    future.rules[0].anchor = future.rules[0].effectiveFrom = '2030-01-01';
    expect(
      previewPersonLifecycle(future, id('alice'), '2026-03-15')
        .stoppedObligations[0].activeTo,
    ).toBe('2030-01-01');
    expect(() =>
      apply(future, [
        {
          type: 'ArchivePerson',
          payload: {
            personId: id('alice'),
            soleBeneficiaryPolicy: 'keep_nobody',
          },
        },
      ]),
    ).not.toThrow();
    const ended = setup();
    ended.periods = [];
    ended.obligations[0].activeFrom = '2010-01-01';
    ended.obligations[0].activeTo = '2011-01-01';
    ended.rules[0].anchor = ended.rules[0].effectiveFrom = '2010-01-01';
    expect(
      previewPersonLifecycle(ended, id('alice'), '2026-03-15')
        .stoppedObligations[0].activeTo,
    ).toBe('2011-01-01');
  });

  it('finds the latest interval across changed offsets and keeps confirmed zero charges', () => {
    const state = setup();
    state.rules[0].dueOffsetDays = 60;
    state.rules[0].effectiveTo = '2026-02-01';
    state.rules.push({
      ...state.rules[0],
      id: id('second-rule'),
      effectiveFrom: '2026-02-01',
      effectiveTo: undefined,
      dueOffsetDays: -10,
      amountMode: 'estimate',
    });
    state.periods = [];
    let generated = apply(state, [
      {
        type: 'GeneratePeriods',
        payload: { from: '2026-01-01', to: '2026-06-01' },
      },
    ]);
    const zero = generated.periods.find((p) => p.periodStart === '2026-05-01')!;
    generated = apply(generated, [
      {
        type: 'ConfirmPeriodAmount',
        payload: { periodId: zero.id, amount: 0 },
      },
    ]);
    const plan = previewPersonLifecycle(generated, id('alice'), '2026-03-15')
      .stoppedObligations[0];
    expect(plan.activeTo).toBe('2026-04-01');
    expect(plan.preservedFuturePeriodIds).toContain(zero.id);
    expect(plan.removedFuturePeriodIds).not.toContain(
      generated.periods.find((p) => p.periodStart === '2026-03-01')!.id,
    );
    // An open latest rule must not make the search anchor at an old closed version.
    generated.periods = [];
    expect(
      previewPersonLifecycle(generated, id('alice'), '2030-03-15')
        .stoppedObligations[0].activeTo,
    ).toBe('2030-04-01');
  });

  it('preserves a permanently deleted group member as Nobody when another member returns', () => {
    let state = setup();
    state.obligations[0].beneficiaries = {
      kind: 'people',
      personIds: [id('alice'), id('bob')],
    };
    state = apply(state, [
      {
        type: 'ArchivePerson',
        payload: {
          personId: id('alice'),
          soleBeneficiaryPolicy: 'keep_nobody',
        },
      },
    ]);
    state = apply(state, [
      { type: 'DeletePerson', payload: { personId: id('bob') } },
    ]);
    state = apply(state, [
      {
        type: 'RestorePerson',
        payload: { personId: id('alice'), restoreBeneficiaries: true },
      },
    ]);
    expect(state.obligations[0].beneficiaries).toEqual({
      kind: 'people',
      personIds: [NOBODY_PERSON_ID, id('alice')],
    });
  });

  it('uses household timezone and negative due offsets without restarting automatic payments', () => {
    const state = setup();
    state.household.timezone = 'Pacific/Kiritimati';
    state.periods = [];
    state.rules[0].dueOffsetDays = -31;
    const stopped = apply(
      state,
      [
        {
          type: 'ArchivePerson',
          payload: {
            personId: id('alice'),
            soleBeneficiaryPolicy: 'end_at_last_accrual',
          },
        },
      ],
      '2026-03-31T12:00:00Z',
    );
    expect(stopped.obligations[0].attributionHistory?.[0].through).toBe(
      '2026-04-01',
    );
    expect(stopped.obligations[0].activeTo).toBe('2026-06-01');
    const executed = applyCommands(
      stopped,
      [
        {
          type: 'ExecuteAutomaticPayments',
          payload: { through: '2026-07-01' },
        },
      ],
      {
        actorUserId: 'system',
        operationId: 'post-archive-maintenance',
        now: '2026-07-01T12:00:00Z',
        allowAutomaticPayments: true,
      },
    );
    expect(executed.payments).toEqual(stopped.payments);
    expect(executed.automaticPaymentRuns).toEqual(stopped.automaticPaymentRuns);
  });

  it('uses a virtual Nobody identity with a configurable default color', () => {
    const state = setup();
    expect(state.household.nobodyColor).toBe(DEFAULT_NOBODY_COLOR);
    expect(state.people.some((person) => person.id === NOBODY_PERSON_ID)).toBe(
      false,
    );
    expect(() =>
      apply(state, [
        {
          type: 'AddPerson',
          payload: { id: NOBODY_PERSON_ID, displayName: 'Impostor' },
        },
      ]),
    ).toThrow(/зарезервирован/i);
    const configured = apply(state, [
      { type: 'UpdateHousehold', payload: { nobodyColor: '#112233' } },
    ]);
    expect(configured.household.nobodyColor).toBe('#112233');
  });

  it('archives attribution by household date and restores only tracked benefits', () => {
    const archived = apply(setup(), [
      {
        type: 'ArchivePerson',
        payload: {
          personId: id('alice'),
          soleBeneficiaryPolicy: 'keep_nobody',
        },
      },
    ]);
    const obligation = archived.obligations[0];
    expect(archived.people[0].archivedAt).toBe('2026-03-15T12:00:00Z');
    expect(obligation.ownerPersonId).toBe(NOBODY_PERSON_ID);
    expect(obligation.beneficiaries).toEqual({
      kind: 'people',
      personIds: [NOBODY_PERSON_ID],
    });
    expect(obligation.attributionHistory).toEqual([
      {
        through: '2026-03-15',
        ownerPersonId: id('alice'),
        beneficiaries: { kind: 'people', personIds: [id('alice')] },
      },
    ]);
    expect(archived.payments).toEqual([]);
    expect(archived.automaticPayments?.[0]).toMatchObject({
      payerPersonId: NOBODY_PERSON_ID,
      enabled: true,
    });

    const restored = apply(
      archived,
      [
        {
          type: 'RestorePerson',
          payload: { personId: id('alice'), restoreBeneficiaries: true },
        },
      ],
      '2026-04-15T12:00:00Z',
    );
    expect(restored.people[0].archivedAt).toBeUndefined();
    expect(restored.obligations[0].beneficiaries).toEqual({
      kind: 'people',
      personIds: [id('alice')],
    });
    expect(
      personAttributionForDate(restored.obligations[0], '2026-03-01')
        .beneficiaries,
    ).toEqual({ kind: 'people', personIds: [id('alice')] });
    expect(
      personAttributionForDate(restored.obligations[0], '2026-04-01')
        .beneficiaries,
    ).toEqual({ kind: 'people', personIds: [NOBODY_PERSON_ID] });
    expect(
      personAttributionForDate(restored.obligations[0], '2026-05-01')
        .beneficiaries,
    ).toEqual({ kind: 'people', personIds: [id('alice')] });

    const chart = monthlyFinancialSeries(restored, '2026-03', '2026-05');
    expect(
      chart[0].byBeneficiary.find((row) => row.key === id('alice'))?.amount,
    ).toBe(10_000);
    expect(
      chart[1].byBeneficiary.find((row) => row.key === NOBODY_PERSON_ID)
        ?.amount,
    ).toBe(10_000);
    expect(
      exportPeriodCsv(restored, {
        from: '2026-04-01',
        toInclusive: '2026-04-30',
      }).obligationsCsv,
    ).toContain('Никто');
  });

  it('does not restore benefits after an explicit beneficiary edit', () => {
    let state = apply(setup(), [
      {
        type: 'ArchivePerson',
        payload: {
          personId: id('alice'),
          soleBeneficiaryPolicy: 'keep_nobody',
        },
      },
    ]);
    state = apply(state, [
      {
        type: 'UpdateObligation',
        payload: {
          obligationId: id('obligation'),
          patch: { beneficiaries: { kind: 'people', personIds: [id('bob')] } },
        },
      },
    ]);
    state = apply(state, [
      {
        type: 'RestorePerson',
        payload: { personId: id('alice'), restoreBeneficiaries: true },
      },
    ]);
    expect(state.obligations[0].beneficiaries).toEqual({
      kind: 'people',
      personIds: [id('bob')],
    });
  });

  it('stops after the last accrued period and keeps protected future records', () => {
    let state = setup();
    const april = state.periods.find(
      (period) => period.dueDate === '2026-04-01',
    )!;
    state = apply(state, [
      {
        type: 'WaivePeriod',
        payload: { periodId: april.id, reason: 'credit' },
      },
    ]);
    const preview = previewPersonLifecycle(state, id('alice'), '2026-03-15');
    expect(preview.stoppedObligations[0]).toMatchObject({
      activeTo: '2026-04-01',
      preservedFuturePeriodIds: [april.id],
      automaticPaymentIds: [id('schedule')],
    });
    const stopped = apply(state, [
      {
        type: 'ArchivePerson',
        payload: {
          personId: id('alice'),
          soleBeneficiaryPolicy: 'end_at_last_accrual',
        },
      },
    ]);
    expect(stopped.obligations[0]).toMatchObject({
      activeTo: '2026-04-01',
      lifecycleState: 'archived',
    });
    expect(stopped.periods.some((period) => period.id === april.id)).toBe(true);
    expect(
      stopped.periods.some((period) => period.dueDate === '2026-05-01'),
    ).toBe(false);
    expect(stopped.automaticPayments?.[0].enabled).toBe(false);
    const restored = apply(stopped, [
      {
        type: 'RestorePerson',
        payload: { personId: id('alice'), restoreBeneficiaries: true },
      },
    ]);
    expect(restored.obligations[0].lifecycleState).toBe('archived');
    expect(restored.automaticPayments?.[0].enabled).toBe(false);
  });

  it('hard deletion rewrites financial references but preserves authorship and audit', () => {
    let state = apply(setup(), [
      {
        type: 'RecordPaymentAndAllocate',
        payload: {
          payment: {
            id: id('payment'),
            obligationId: id('obligation'),
            payerPersonId: id('alice'),
            paidAt: '2026-02-01',
            amount: 10_000,
            currency: 'CZK',
            source: 'manual',
          },
          allocations: [],
        },
      },
      {
        type: 'ArchivePerson',
        payload: {
          personId: id('alice'),
          soleBeneficiaryPolicy: 'keep_nobody',
        },
      },
    ]);
    const creator = state.payments[0].createdByUserId;
    state = apply(state, [
      { type: 'DeletePerson', payload: { personId: id('alice') } },
    ]);
    expect(state.people.map((person) => person.id)).not.toContain(id('alice'));
    expect(state.obligations[0].attributionHistory?.[0]).toMatchObject({
      ownerPersonId: NOBODY_PERSON_ID,
      beneficiaries: { kind: 'people', personIds: [NOBODY_PERSON_ID] },
    });
    expect(state.payments[0]).toMatchObject({
      payerPersonId: NOBODY_PERSON_ID,
      createdByUserId: creator,
    });
    expect(state.entitlements[0].personId).toBe(NOBODY_PERSON_ID);
    expect(
      state.audit.some((event) => event.actorUserId === 'admin-account'),
    ).toBe(true);
  });

  it('rejects new assignments to archived people', () => {
    const archived = apply(setup(), [
      {
        type: 'ArchivePerson',
        payload: {
          personId: id('alice'),
          soleBeneficiaryPolicy: 'keep_nobody',
        },
      },
    ]);
    expect(() =>
      apply(archived, [
        {
          type: 'UpdateObligation',
          payload: {
            obligationId: id('obligation'),
            patch: {
              beneficiaries: { kind: 'people', personIds: [id('alice')] },
            },
          },
        },
      ]),
    ).toThrow(/активного члена/i);
  });
});

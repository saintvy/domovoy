import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  FamilyApplication,
  type FamilyServices,
  type InvitationMessage,
} from '../src/aws/families';
import { createLocalDatabase } from '../src/aws/local-database';
import type { Database } from '../src/aws/database';
import type { Identity } from '../src/aws/identity';
import { runFamilyMaintenance } from '../src/aws/family-maintenance';
import { createEmptyState, type Command, type State } from '../src/domain';
import { migrateFamilies } from '../src/aws/migrate-families';
import {
  parseEcbHistory,
  quoteFromDays,
  crossRate,
} from '../src/aws/exchange-rates';
import { familySchema } from '../src/aws/family-schema';

describe('Family ownership, isolation and atomic PostgreSQL writes', () => {
  let local: Awaited<ReturnType<typeof createLocalDatabase>>,
    app: FamilyApplication,
    login: any,
    now: number,
    messages: InvitationMessage[],
    services: FamilyServices;
  const alice: Identity = {
    subject: 'google-alice',
    email: 'alice@example.test',
    name: 'Alice',
    authenticatedAt: 1_800_000_000,
  };
  const bob: Identity = {
    subject: 'google-bob',
    email: 'bob@example.test',
    name: 'Bob',
    authenticatedAt: 1_800_000_000,
  };
  const eve: Identity = {
    subject: 'google-eve',
    email: 'eve@example.test',
    name: 'Eve',
    authenticatedAt: 1_800_000_000,
  };
  const request = (
    path: string,
    method = 'GET',
    body?: any,
    identity = alice,
    token = login.sessionToken,
  ) => app.handle({ path, method, body, identity, token });
  const state = async () => (await request('/state')).state as State;
  const envelope = async (commands: Command[], operationId = randomUUID()) => ({
    protocolVersion: 1,
    operationId,
    instanceGeneration: login.instanceGeneration,
    expectedRevision: (await state()).revision,
    commands,
  });
  const addPerson = async (name = 'Bob') => {
    const id = randomUUID();
    await request(
      '/commands',
      'POST',
      await envelope([
        { type: 'AddPerson', payload: { id, displayName: name } },
      ]),
    );
    return id;
  };
  const invite = async (identity = bob, role = 'editor') => {
    const personId = await addPerson(identity.name);
    await request('/family/invitations', 'POST', {
      personId,
      email: identity.email,
      role,
    });
    return {
      personId,
      token: new URLSearchParams(
        new URL(messages.at(-1)!.url).hash.slice(1),
      ).get('invite')!,
    };
  };
  const join = async (identity = bob, role = 'editor') => {
    const invitation = await invite(identity, role);
    return request(
      '/invitations/accept',
      'POST',
      { token: invitation.token },
      identity,
      '',
    );
  };
  const obligationCommand = (
    activeFrom = '2026-01-01',
  ): Extract<Command, { type: 'AddObligation' }> => {
    const id = randomUUID(),
      providerId = randomUUID();
    return {
      type: 'AddObligation',
      payload: {
        obligation: {
          id,
          providerId,
          title: 'Subscription',
          coverageMode: 'household',
          activeFrom,
          lifecycleState: 'active',
        },
        provider: { id: providerId, name: 'Provider', category: 'other' },
        rule: {
          id: randomUUID(),
          obligationId: id,
          effectiveFrom: activeFrom,
          cadence: 'monthly',
          anchor: activeFrom,
          dueOffsetDays: 0,
          amountMode: 'fixed',
          amount: 1000,
          currency: 'EUR',
          reminderDays: 0,
          graceDays: 0,
        },
      },
    };
  };
  const commit = async (
    commands: Command[],
    identity = alice,
    token = login.sessionToken,
  ) => request('/commands', 'POST', await envelope(commands), identity, token);
  beforeAll(async () => {
    local = await createLocalDatabase();
  }, 30000);
  beforeEach(async () => {
    await local.postgres.exec(
      'TRUNCATE brownie_accounts,brownie_families CASCADE',
    );
    now = Date.UTC(2026, 8, 15, 12);
    messages = [];
    services = {
      appOrigin: 'https://brownie.example',
      clock: () => now,
      sendInvitation: async (m) => {
        messages.push(m);
      },
    };
    app = new FamilyApplication(local.database, services);
    login = await app.handle({
      path: '/families',
      method: 'POST',
      identity: alice,
      body: { name: 'Alice home', currency: 'EUR' },
    });
  });
  afterAll(async () => {
    await local?.postgres.close();
  });
  it('offers onboarding to any verified Google account; creator is sole head', async () => {
    expect(login.user.role).toBe('admin');
    expect((await state()).people[0].displayName).toBe('Alice');
    expect(await request('/auth/session', 'POST', {}, bob, '')).toMatchObject({
      onboarding: true,
      user: null,
      identity: { email: bob.email },
    });
    await expect(
      request('/families', 'POST', { name: 'Second home' }),
    ).rejects.toMatchObject({ code: 'ALREADY_IN_FAMILY' });
  });
  it('isolates independent families, sessions, operations and guessed identifiers', async () => {
    const second = await request(
      '/families',
      'POST',
      { name: 'Bob home' },
      bob,
      '',
    );
    expect(second.user.familyId).not.toBe(login.user.familyId);
    const result = await request(
      '/state',
      'GET',
      { familyId: login.user.familyId },
      bob,
      second.sessionToken,
    );
    expect(result.state.household.name).toBe('Bob home');
    await expect(
      request('/state', 'GET', undefined, bob, login.sessionToken),
    ).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
    const command = await envelope([
      {
        type: 'AddPerson',
        payload: { id: randomUUID(), displayName: 'Private' },
      },
    ]);
    await request('/commands', 'POST', command);
    await expect(
      request(
        '/operations/' + command.operationId,
        'GET',
        undefined,
        bob,
        second.sessionToken,
      ),
    ).rejects.toMatchObject({ code: 'OPERATION_NOT_FOUND' });
  });
  it('commits only one concurrent revision and releases locks on rollback', async () => {
    const commands = await Promise.all(
      ['One', 'Two'].map(async (displayName) =>
        envelope([
          { type: 'AddPerson', payload: { id: randomUUID(), displayName } },
        ]),
      ),
    );
    const results = await Promise.allSettled(
      commands.map((c) => request('/commands', 'POST', c)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'REVISION_CONFLICT' },
    });
    expect((await state()).people).toHaveLength(2);
    await expect(
      request(
        '/commands',
        'POST',
        await envelope([{ type: 'MissingCommand', payload: {} }] as any),
      ),
    ).rejects.toBeDefined();
    await addPerson('After rollback');
    expect((await state()).people).toHaveLength(3);
  });
  it('persists idempotent receipts and rejects changed payloads with the same operation id', async () => {
    const command = await envelope([
      { type: 'AddPerson', payload: { id: randomUUID(), displayName: 'Bob' } },
    ]);
    const first = await request('/commands', 'POST', command);
    expect(await request('/commands', 'POST', command)).toEqual(first);
    await expect(
      request('/commands', 'POST', {
        ...command,
        commands: [
          {
            type: 'AddPerson',
            payload: { id: randomUUID(), displayName: 'Changed' },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
    expect(await request('/operations/' + command.operationId)).toEqual(first);
    expect((await state()).people).toHaveLength(2);
  });
  it('rolls state back if saving the commit receipt fails', async () => {
    const broken: Database = {
      transaction: (work) =>
        local.database.transaction((c) =>
          work({
            query: (sql, values) => {
              if (sql.startsWith('INSERT INTO brownie_family_operations'))
                throw new Error('connection dropped');
              return c.query(sql, values);
            },
          }),
        ),
    };
    const command = await envelope([
      {
        type: 'AddPerson',
        payload: { id: randomUUID(), displayName: 'Rollback' },
      },
    ]);
    await expect(
      new FamilyApplication(broken, services).handle({
        path: '/commands',
        method: 'POST',
        body: command,
        identity: alice,
        token: login.sessionToken,
      }),
    ).rejects.toThrow('connection dropped');
    expect((await state()).people).toHaveLength(1);
    await request('/commands', 'POST', command);
  });
  it('requires the strong email-bound invitation link, not just matching Google login', async () => {
    const invited = await invite();
    expect(invited.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await request('/auth/session', 'POST', {}, bob, '')).toMatchObject({
      onboarding: true,
    });
    await expect(
      request('/invitations/accept', 'POST', { token: invited.token }, eve, ''),
    ).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
    const accepted = await request(
      '/invitations/accept',
      'POST',
      { token: invited.token },
      bob,
      '',
    );
    expect(accepted.user.personId).toBe(invited.personId);
    expect(accepted.user.role).toBe('editor');
    const stored = await local.postgres.query(
      'SELECT token_hash FROM brownie_invitations',
    );
    expect(JSON.stringify(stored.rows)).not.toContain(invited.token);
  });
  it('does not allow creating a membership when delivery queueing fails', async () => {
    const personId = await addPerson();
    app = new FamilyApplication(local.database, {
      ...services,
      sendInvitation: async () => {
        throw new Error('unavailable');
      },
    });
    await expect(
      request('/family/invitations', 'POST', {
        personId,
        email: bob.email,
        role: 'observer',
      }),
    ).rejects.toThrow('unavailable');
    expect(
      (await local.postgres.query('SELECT * FROM brownie_invitations')).rows,
    ).toHaveLength(0);
  });
  it('rejects expired, revoked and reused invitations', async () => {
    const first = await invite();
    now += 8 * 86400000;
    await expect(
      request('/invitations/accept', 'POST', { token: first.token }, bob, ''),
    ).rejects.toMatchObject({ code: 'INVITATION_EXPIRED' });
    // Alice's session expired too, so get another normal application session.
    login = await request('/auth/session', 'POST');
    const second = await invite(eve);
    const id = messages.at(-1)!.id;
    await request('/family/invitations/' + id, 'DELETE');
    await expect(
      request('/invitations/accept', 'POST', { token: second.token }, eve, ''),
    ).rejects.toMatchObject({ code: 'INVITATION_EXPIRED' });
    const third = await invite(eve);
    const accepted = await request(
      '/invitations/accept',
      'POST',
      { token: third.token },
      eve,
      '',
    );
    await request(
      '/family/leave',
      'POST',
      { confirm: true },
      eve,
      accepted.sessionToken,
    );
    await expect(
      request('/invitations/accept', 'POST', { token: third.token }, eve, ''),
    ).rejects.toMatchObject({ code: 'INVITATION_EXPIRED' });
  });
  it('requires leaving another household before accepting an invitation', async () => {
    const invited = await invite();
    const other = await request(
      '/families',
      'POST',
      { name: 'Another home' },
      bob,
      '',
    );
    await expect(
      request(
        '/invitations/accept',
        'POST',
        { token: invited.token },
        bob,
        other.sessionToken,
      ),
    ).rejects.toMatchObject({ code: 'ALREADY_IN_FAMILY' });
    await request(
      '/family/leave',
      'POST',
      { confirm: true },
      bob,
      other.sessionToken,
    );
    expect(
      (
        await request(
          '/invitations/accept',
          'POST',
          { token: invited.token },
          bob,
          '',
        )
      ).user.familyId,
    ).toBe(login.user.familyId);
  });
  it.each(['observer', 'editor', 'own_editor', 'deleter'])(
    'allows %s to read financial data but protects settings and membership',
    async (role) => {
      const member = await join(bob, role);
      expect(
        (await request('/state', 'GET', undefined, bob, member.sessionToken))
          .state.household.currency,
      ).toBe('EUR');
      await expect(
        request(
          '/commands',
          'POST',
          await envelope([
            { type: 'UpdateHousehold', payload: { name: 'Attack' } },
          ]),
          bob,
          member.sessionToken,
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        request(
          '/family/invitations',
          'POST',
          { email: eve.email, role: 'editor' },
          bob,
          member.sessionToken,
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        request(
          '/family/transfer',
          'POST',
          { subject: bob.subject },
          bob,
          member.sessionToken,
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    },
  );
  it('rechecks revoked roles and sessions without trusting the browser', async () => {
    const member = await join();
    await request('/family/members/' + bob.subject, 'PATCH', {
      role: 'observer',
    });
    await expect(
      request('/state', 'GET', undefined, bob, member.sessionToken),
    ).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
    const current = await request('/auth/session', 'POST', {}, bob, '');
    expect(current.user.role).toBe('observer');
    await expect(
      request(
        '/commands',
        'POST',
        await envelope([
          {
            type: 'GeneratePeriods',
            payload: { from: '2026-01-01', to: '2027-01-01' },
          },
        ]),
        bob,
        current.sessionToken,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('makes editor create-only even for entities they created', async () => {
    const member = await join(bob, 'editor'),
      command = obligationCommand();
    await commit([command], bob, member.sessionToken);
    const obligation = (await state()).obligations[0];
    expect(obligation.createdByUserId).toBe(bob.subject);
    for (const change of [
      {
        type: 'UpdateObligation',
        payload: { obligationId: obligation.id, patch: { title: 'Forbidden' } },
      },
      {
        type: 'ArchiveObligation',
        payload: { obligationId: obligation.id, activeTo: '2026-10-01' },
      },
      { type: 'DeleteObligation', payload: { obligationId: obligation.id } },
    ])
      await expect(
        commit([change] as Command[], bob, member.sessionToken),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await state()).obligations[0].title).toBe('Subscription');
  });
  it('uses immutable server-assigned ownership and denies own_editor access to foreign and legacy records', async () => {
    const member = await join(bob, 'own_editor');
    const foreign = obligationCommand();
    await commit([foreign]);
    const own = obligationCommand();
    (own as any).payload.obligation.createdByUserId = alice.subject;
    await expect(commit([own], bob, member.sessionToken)).rejects.toBeDefined();
    delete (own as any).payload.obligation.createdByUserId;
    await commit([own], bob, member.sessionToken);
    const all = (await state()).obligations,
      ownId = (own as any).payload.obligation.id,
      foreignId = (foreign as any).payload.obligation.id;
    expect(all.find((o) => o.id === ownId)?.createdByUserId).toBe(bob.subject);
    await expect(
      commit(
        [
          {
            type: 'UpdateObligation',
            payload: {
              obligationId: ownId,
              patch: {
                title: 'My record',
                createdByUserId: alice.subject,
              } as any,
            },
          },
        ],
        bob,
        member.sessionToken,
      ),
    ).rejects.toBeDefined();
    await commit(
      [
        {
          type: 'UpdateObligation',
          payload: { obligationId: ownId, patch: { title: 'My record' } },
        },
      ],
      bob,
      member.sessionToken,
    );
    expect(
      (await state()).obligations.find((o) => o.id === ownId)?.createdByUserId,
    ).toBe(bob.subject);
    await expect(
      commit(
        [
          {
            type: 'UpdateObligation',
            payload: { obligationId: foreignId, patch: { title: 'Attack' } },
          },
        ],
        bob,
        member.sessionToken,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const legacy = await state();
    delete legacy.obligations.find((o) => o.id === ownId)!.createdByUserId;
    await local.postgres.query(
      'UPDATE brownie_families SET state=$1::jsonb WHERE id=$2',
      [JSON.stringify(legacy), login.user.familyId],
    );
    await expect(
      commit(
        [
          {
            type: 'UpdateObligation',
            payload: { obligationId: ownId, patch: { title: 'Legacy claim' } },
          },
        ],
        bob,
        member.sessionToken,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await commit([
      {
        type: 'UpdateObligation',
        payload: { obligationId: ownId, patch: { title: 'Admin correction' } },
      },
    ]);
  });
  it('enforces ownership for payments and schedules independently of their obligation owner', async () => {
    const member = await join(bob, 'own_editor');
    await commit([obligationCommand()]);
    const obligationId = (await state()).obligations[0].id,
      personId = member.user.personId;
    const ownPayment = randomUUID(),
      foreignPayment = randomUUID();
    const payment = (id: string, payerPersonId: string): Command => ({
      type: 'RecordPaymentAndAllocate',
      payload: {
        payment: {
          id,
          paidAt: '2026-09-15',
          amount: 100,
          currency: 'EUR',
          payerPersonId,
          obligationId,
          source: 'manual',
        },
        allocations: [],
      },
    });
    const forged = payment(ownPayment, personId);
    (forged as any).payload.payment.createdByUserId = alice.subject;
    await expect(
      commit([forged], bob, member.sessionToken),
    ).rejects.toBeDefined();
    await commit([payment(ownPayment, personId)], bob, member.sessionToken);
    await commit([payment(foreignPayment, login.user.personId)]);
    expect(
      (await state()).payments.find((p) => p.id === ownPayment)
        ?.createdByUserId,
    ).toBe(bob.subject);
    const refund = (id: string): Command => ({
      type: 'RefundPayment',
      payload: {
        refund: {
          id: randomUUID(),
          originalPaymentId: id,
          paidAt: '2026-09-15',
          amount: 20,
          reason: 'Correction',
        },
        reverseAllocationIds: [],
      },
    });
    await expect(
      commit([refund(foreignPayment)], bob, member.sessionToken),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await commit([refund(ownPayment)], bob, member.sessionToken);
    const scheduleId = randomUUID();
    await commit(
      [
        {
          type: 'AddAutomaticPayment',
          payload: {
            schedule: {
              id: scheduleId,
              obligationId,
              payerPersonId: personId,
              startDate: '2026-10-01',
              enabled: true,
            },
          },
        },
      ],
      bob,
      member.sessionToken,
    );
    expect(
      (await state()).automaticPayments?.find((s) => s.id === scheduleId)
        ?.createdByUserId,
    ).toBe(bob.subject);
    await commit(
      [{ type: 'DeleteAutomaticPayment', payload: { scheduleId } }],
      bob,
      member.sessionToken,
    );
  });
  it('backfills due automatic payments immediately and leaves future periods unpaid', async () => {
    const automatic = (obligationId: string, startDate: string): Command => ({
      type: 'AddAutomaticPayment',
      payload: {
        schedule: {
          id: randomUUID(),
          obligationId,
          payerPersonId: login.user.personId,
          startDate,
          enabled: true,
        },
      },
    });
    const periods = (from: string, to: string): Command => ({
      type: 'GeneratePeriods',
      payload: { from, to },
    });

    const combined = obligationCommand('2026-09-01'),
      combinedId = combined.payload.obligation.id;
    await commit([
      combined,
      automatic(combinedId, '2026-09-01'),
      periods('2026-09-01', '2026-10-01'),
    ]);
    let current = await state();
    expect(
      current.payments.filter((payment) => payment.obligationId === combinedId),
    ).toMatchObject([
      { paidAt: '2026-09-01', amount: 1000, source: 'automatic' },
    ]);
    expect(
      current.automaticPaymentRuns?.filter(
        (run) =>
          current.periods.find((period) => period.id === run.periodId)
            ?.obligationId === combinedId,
      ),
    ).toHaveLength(1);

    const existing = obligationCommand('2026-08-01'),
      existingId = existing.payload.obligation.id;
    await commit([existing, periods('2026-08-01', '2026-10-01')]);
    expect(
      (await state()).payments.some(
        (payment) => payment.obligationId === existingId,
      ),
    ).toBe(false);
    await commit([automatic(existingId, '2026-08-01')]);
    current = await state();
    expect(
      current.payments
        .filter((payment) => payment.obligationId === existingId)
        .map((payment) => payment.paidAt),
    ).toEqual(['2026-08-01', '2026-09-01']);

    const future = obligationCommand('2026-09-26'),
      futureId = future.payload.obligation.id;
    await commit([
      future,
      automatic(futureId, '2026-09-26'),
      periods('2026-09-26', '2026-10-01'),
    ]);
    current = await state();
    expect(
      current.periods.some(
        (period) =>
          period.obligationId === futureId && period.dueDate === '2026-09-26',
      ),
    ).toBe(true);
    expect(
      current.payments.some((payment) => payment.obligationId === futureId),
    ).toBe(false);
  });
  it('lets deleter edit foreign records but reserves full cascade deletion for admin', async () => {
    const member = await join(bob, 'deleter');
    await commit([obligationCommand()]);
    const obligationId = (await state()).obligations[0].id;
    await commit(
      [
        {
          type: 'UpdateObligation',
          payload: { obligationId, patch: { title: 'Shared correction' } },
        },
      ],
      bob,
      member.sessionToken,
    );
    await expect(
      commit(
        [{ type: 'DeleteObligation', payload: { obligationId } }] as Command[],
        bob,
        member.sessionToken,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('blocks every lifecycle path from indirectly altering another creator’s payment, including keep_credit', async () => {
    const member = await join(bob, 'own_editor');
    await commit([obligationCommand()], bob, member.sessionToken);
    const obligationId = (await state()).obligations[0].id;
    await commit([
      {
        type: 'RecordPaymentAndAllocate',
        payload: {
          payment: {
            id: randomUUID(),
            paidAt: '2026-09-15',
            amount: 100,
            currency: 'EUR',
            payerPersonId: login.user.personId,
            obligationId,
            source: 'manual',
          },
          allocations: [],
        },
      },
    ]);
    const before = await state();
    for (const outOfRangePaymentPolicy of [
      'delete',
      'move_inside',
      'keep_credit',
    ])
      for (const type of ['ArchiveObligation', 'UpdateObligationSchedule']) {
        const payload =
          type === 'ArchiveObligation'
            ? { obligationId, activeTo: '2026-09-01', outOfRangePaymentPolicy }
            : {
                obligationId,
                activeFrom: '2026-01-01',
                activeTo: '2026-09-01',
                anchor: '2026-01-01',
                cadence: 'monthly',
                dueOffsetDays: 0,
                outOfRangePaymentPolicy,
              };
        await expect(
          commit([{ type, payload }] as Command[], bob, member.sessionToken),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
    await expect(
      commit(
        [
          {
            type: 'UpdateObligation',
            payload: { obligationId, patch: { activeTo: '2026-09-01' } },
          },
        ],
        bob,
        member.sessionToken,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await state()).toEqual(before);
  });
  it.each([true, false])(
    "blocks every lifecycle path from changing another creator's automatic schedule (enabled=%s)",
    async (enabled) => {
      const member = await join(bob, 'own_editor');
      await commit([obligationCommand()], bob, member.sessionToken);
      const obligationId = (await state()).obligations[0].id,
        scheduleId = randomUUID();
      await commit([
        {
          type: 'AddAutomaticPayment',
          payload: {
            schedule: {
              id: scheduleId,
              obligationId,
              payerPersonId: login.user.personId,
              startDate: '2026-10-01',
              enabled,
            },
          },
        },
      ]);
      const before = await state();
      expect(before.automaticPayments?.[0].createdByUserId).toBe(alice.subject);
      expect(before.payments).toHaveLength(0);
      const changes: Command[] = [
        {
          type: 'ArchiveObligation',
          payload: {
            obligationId,
            activeTo: '2026-09-01',
            outOfRangePaymentPolicy: 'keep_credit',
          },
        },
        {
          type: 'UpdateObligationSchedule',
          payload: {
            obligationId,
            activeFrom: '2026-02-01',
            activeTo: '2026-09-01',
            anchor: '2026-02-01',
            cadence: 'monthly',
            dueOffsetDays: 0,
            outOfRangePaymentPolicy: 'keep_credit',
          },
        },
        {
          type: 'UpdateObligation',
          payload: { obligationId, patch: { activeTo: '2026-09-01' } },
        },
        {
          type: 'UpdateObligation',
          payload: { obligationId, patch: { activeFrom: '2026-02-01' } as any },
        },
      ];
      for (const change of changes) {
        await expect(
          commit([change], bob, member.sessionToken),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(await state()).toEqual(before);
      }
      // The same edit remains available to the administrator, proving this is the
      // schedule ownership gate rather than a domain validation rejection.
      await commit([changes[0]]);
      expect((await state()).automaticPayments?.[0].enabled).toBe(false);
    },
  );
  it('updates pending roles without granting membership or permitting pending admin transfer', async () => {
    const pending = await invite(bob, 'observer'),
      id = messages.at(-1)!.id;
    await request('/family/invitations/' + id, 'PATCH', { role: 'own_editor' });
    const access = await request('/family/members');
    expect(access.members).toHaveLength(1);
    expect(access.invitations[0]).toMatchObject({
      role: 'own_editor',
      email: bob.email,
    });
    await expect(
      request('/family/invitations/' + id, 'PATCH', { role: 'admin' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      request('/family/transfer', 'POST', { subject: bob.subject }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const accepted = await request(
      '/invitations/accept',
      'POST',
      { token: pending.token },
      bob,
      '',
    );
    expect(accepted.user.role).toBe('own_editor');
    await expect(
      request('/family/invitations/' + id, 'PATCH', { role: 'editor' }),
    ).rejects.toMatchObject({ code: 'INVITATION_EXPIRED' });
  });
  it('migrates existing membership and invitation role constraints idempotently', async () => {
    await local.postgres.exec(
      "ALTER TABLE brownie_memberships DROP CONSTRAINT brownie_memberships_role_check; ALTER TABLE brownie_memberships ADD CONSTRAINT brownie_memberships_role_check CHECK(role IN ('editor','deleter','observer')); ALTER TABLE brownie_invitations DROP CONSTRAINT brownie_invitations_role_check; ALTER TABLE brownie_invitations ADD CONSTRAINT brownie_invitations_role_check CHECK(role IN ('editor','deleter','observer'));",
    );
    await local.postgres.exec(familySchema);
    await local.postgres.exec(familySchema);
    expect((await join(bob, 'own_editor')).user.role).toBe('own_editor');
  });
  it('renews an active session only below six remaining hours and never revives revoked or expired sessions', async () => {
    const initial = (
      await local.postgres.query<{ id: string; expires_at: number }>(
        'SELECT id,expires_at FROM brownie_family_sessions',
      )
    ).rows[0];
    now += 5 * 3600000;
    await request('/state');
    expect(
      Number(
        (
          await local.postgres.query<{ expires_at: number }>(
            'SELECT expires_at FROM brownie_family_sessions WHERE id=$1',
            [initial.id],
          )
        ).rows[0].expires_at,
      ),
    ).toBe(Number(initial.expires_at));
    now += 2 * 3600000;
    await request('/state');
    const renewed = Number(
      (
        await local.postgres.query<{ expires_at: number }>(
          'SELECT expires_at FROM brownie_family_sessions WHERE id=$1',
          [initial.id],
        )
      ).rows[0].expires_at,
    );
    expect(renewed).toBe(now + 12 * 3600000);
    await request('/sessions/' + initial.id + '/revoke', 'POST');
    now += 7 * 3600000;
    await expect(request('/state')).rejects.toMatchObject({
      code: 'SESSION_REVOKED',
    });
    expect(
      Number(
        (
          await local.postgres.query<{ expires_at: number }>(
            'SELECT expires_at FROM brownie_family_sessions WHERE id=$1',
            [initial.id],
          )
        ).rows[0].expires_at,
      ),
    ).toBe(renewed);
    login = await request('/auth/session', 'POST', {}, alice, '');
    now += 13 * 3600000;
    await expect(request('/state')).rejects.toMatchObject({
      code: 'SESSION_REVOKED',
    });
  });
  it('has exactly one head after explicit transfer and rejects inviting another head', async () => {
    const member = await join();
    await request('/family/transfer', 'POST', { subject: bob.subject });
    expect((await request('/session')).user.role).toBe('deleter');
    expect(
      (await request('/session', 'GET', undefined, bob, member.sessionToken))
        .user.role,
    ).toBe('admin');
    await expect(
      request('/family/transfer', 'POST', { subject: alice.subject }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const personId = (await state()).people[0].id;
    await expect(
      request(
        '/family/invitations',
        'POST',
        { personId, email: eve.email, role: 'admin' },
        bob,
        member.sessionToken,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
  it('preserves a departed person and transfers head to another login member', async () => {
    const member = await join();
    const oldPeople = (await state()).people;
    await request('/family/leave', 'POST', { confirm: true });
    expect(await request('/session')).toMatchObject({
      onboarding: true,
      user: null,
    });
    const remaining = await request(
      '/state',
      'GET',
      undefined,
      bob,
      member.sessionToken,
    );
    expect(remaining.user.role).toBe('admin');
    expect(remaining.state.people).toEqual(oldPeople);
  });
  it('deletes an abandoned family and cancels its invitations; preserves other families', async () => {
    const pending = await invite(bob);
    const other = await request(
      '/families',
      'POST',
      { name: 'Eve home' },
      eve,
      '',
    );
    await request('/family/leave', 'POST', { confirm: true });
    await expect(
      request('/invitations/accept', 'POST', { token: pending.token }, bob, ''),
    ).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
    await runFamilyMaintenance(local.database, services);
    expect(
      (await request('/state', 'GET', undefined, eve, other.sessionToken)).state
        .household.name,
    ).toBe('Eve home');
    expect(
      (await local.postgres.query('SELECT * FROM brownie_families')).rows,
    ).toHaveLength(1);
  });
  it('takeover revokes old devices and blocks recreating sessions with pre-takeover JWTs', async () => {
    const old = { ...alice, authenticatedAt: Math.floor(now / 1000) - 10 };
    const second = await request('/auth/session', 'POST', {}, old, '');
    await request('/admin/takeover', 'POST', { editorInstanceId: 'first' });
    await expect(
      request('/state', 'GET', undefined, alice, second.sessionToken),
    ).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
    await expect(
      request('/auth/session', 'POST', {}, old, ''),
    ).rejects.toMatchObject({ code: 'FRESH_GOOGLE_LOGIN_REQUIRED' });
    expect((await request('/state')).user.id).toBe(alice.subject);
  });
  it('does not expose technical archives and rejects user-triggered scheduler commands', async () => {
    for (const path of ['/exports', '/backups', '/admin/restore/preview'])
      await expect(request(path, 'POST')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    await expect(
      request(
        '/commands',
        'POST',
        await envelope([
          {
            type: 'ExecuteAutomaticPayments',
            payload: { through: '2026-09-15' },
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('stores explicitly entered rates only with head permission and per family', async () => {
    await request('/family/rates', 'POST', {
      from: 'UAH',
      to: 'EUR',
      date: '2026-09-15',
      rate: '0.02',
    });
    expect(await request('/family/rates')).toMatchObject({
      rates: [{ from: 'UAH', to: 'EUR', rate: '0.02', source: 'manual' }],
    });
    const other = await request('/families', 'POST', { name: 'Bob' }, bob, '');
    expect(
      await request('/family/rates', 'GET', undefined, bob, other.sessionToken),
    ).toEqual({ rates: [] });
  });
  it('runs bounded automatic backups and isolates family deletion prefixes', async () => {
    const saved: string[] = [],
      purged: string[] = [];
    const withBackups = {
      ...services,
      backups: (family: string) => ({
        save: async () => {
          const fileId = `family/${family}/${randomUUID()}`;
          saved.push(fileId);
          return { fileId, verified: true };
        },
        purgeBatch: async () => {
          purged.push(family);
          return { complete: true };
        },
      }),
    };
    expect(
      (await runFamilyMaintenance(local.database, withBackups)).results[0]
        .status,
    ).toBe('created');
    expect(
      (await runFamilyMaintenance(local.database, withBackups)).results[0]
        .status,
    ).toBe('unchanged');
    expect(saved).toHaveLength(1);
    await request('/family/leave', 'POST', { confirm: true });
    await runFamilyMaintenance(local.database, withBackups);
    expect(purged).toEqual([login.user.familyId]);
  });
  it('migration never creates a spurious family in an uninitialized installation', async () => {
    await local.postgres.exec(
      'TRUNCATE brownie_accounts,brownie_families CASCADE',
    );
    await local.database.transaction(migrateFamilies);
    await local.database.transaction(migrateFamilies);
    expect(
      (await local.postgres.query('SELECT * FROM brownie_families')).rows,
    ).toHaveLength(0);
  });
});

describe('ECB historical conversion boundary', () => {
  it('uses exact decimal cross rates and prior business days without reviving obsolete currencies', () => {
    const years = parseEcbHistory(
      `<Cube><Cube time='2026-09-11'><Cube currency='USD' rate='1.2'/><Cube currency='CZK' rate='24'/></Cube></Cube>`,
    );
    expect(crossRate('1.2', '24')).toBe('20.000000000000');
    expect(
      quoteFromDays(
        years.get('2026')!,
        { from: 'USD', to: 'CZK', date: '2026-09-13' },
        '2026-09-15',
      ),
    ).toMatchObject({
      date: '2026-09-13',
      rate: '20.000000000000',
      source: 'ECB (2026-09-11)',
    });
    expect(() =>
      quoteFromDays(
        years.get('2026')!,
        { from: 'RUB', to: 'EUR', date: '2026-09-13' },
        '2026-09-15',
      ),
    ).toThrowError(expect.objectContaining({ code: 'EXCHANGE_RATE_REQUIRED' }));
    expect(() =>
      quoteFromDays(
        years.get('2026')!,
        { from: 'USD', to: 'EUR', date: '2026-10-11' },
        '2026-10-11',
      ),
    ).toThrowError(expect.objectContaining({ code: 'EXCHANGE_RATE_REQUIRED' }));
  });
});

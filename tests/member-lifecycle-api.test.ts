import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  FamilyApplication,
  type FamilyServices,
  type InvitationMessage,
} from '../src/aws/families';
import { createLocalDatabase } from '../src/aws/local-database';
import type { Database } from '../src/aws/database';
import type { Identity } from '../src/aws/identity';
import { householdToday, type Command, type State } from '../src/domain';

describe('Family member lifecycle API security', () => {
  let local: Awaited<ReturnType<typeof createLocalDatabase>>,
    app: FamilyApplication,
    login: any,
    now: number,
    messages: InvitationMessage[],
    services: FamilyServices;
  const alice: Identity = {
    subject: 'google-alice-lifecycle',
    email: 'alice-lifecycle@example.test',
    name: 'Alice',
    authenticatedAt: 1_800_000_000,
  };
  const bob: Identity = {
    subject: 'google-bob-lifecycle',
    email: 'bob-lifecycle@example.test',
    name: 'Bob',
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
  const envelope = async (commands: Command[], operationId = randomUUID()) => {
    const current = await state();
    return {
      protocolVersion: 1,
      operationId,
      instanceGeneration: login.instanceGeneration,
      expectedRevision: current.revision,
      commands: commands.map((command) =>
        ['ArchivePerson', 'RestorePerson'].includes(command.type)
          ? {
              ...command,
              payload: {
                ...command.payload,
                expectedDate: householdToday(current, new Date(now)),
              },
            }
          : command,
      ),
    };
  };
  const addPerson = async (displayName: string) => {
    const personId = randomUUID();
    await request(
      '/commands',
      'POST',
      await envelope([
        { type: 'AddPerson', payload: { id: personId, displayName } },
      ]),
    );
    return personId;
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
      invitationId: messages.at(-1)!.id,
      token: new URLSearchParams(
        new URL(messages.at(-1)!.url).hash.slice(1),
      ).get('invite')!,
    };
  };
  const join = async (role = 'editor') => {
    const invitation = await invite(bob, role);
    const member = await request(
      '/invitations/accept',
      'POST',
      { token: invitation.token },
      bob,
      '',
    );
    return { ...invitation, member };
  };

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
      sendInvitation: async (message) => {
        messages.push(message);
      },
    };
    app = new FamilyApplication(local.database, services);
    login = await app.handle({
      path: '/families',
      method: 'POST',
      identity: alice,
      body: { name: 'Lifecycle home', currency: 'EUR' },
    });
  });
  afterAll(async () => {
    await local?.postgres.close();
  });

  it.each(['observer', 'editor', 'own_editor', 'deleter'])(
    'denies %s member lifecycle commands',
    async (role) => {
      const { member } = await join(role);
      const unlinked = await addPerson('Unlinked');
      await expect(
        request(
          '/commands',
          'POST',
          await envelope([
            {
              type: 'ArchivePerson',
              payload: {
                personId: unlinked,
                soleBeneficiaryPolicy: 'keep_nobody',
              },
            },
          ]),
          bob,
          member.sessionToken,
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    },
  );

  it('blocks head, foreign and mixed lifecycle targets', async () => {
    const unlinked = await addPerson('Unlinked');
    await expect(
      request(
        '/commands',
        'POST',
        await envelope([
          {
            type: 'ArchivePerson',
            payload: {
              personId: login.user.personId,
              soleBeneficiaryPolicy: 'keep_nobody',
            },
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'HEAD_TRANSFER_REQUIRED' });
    await expect(
      request(
        '/commands',
        'POST',
        await envelope([
          { type: 'DeletePerson', payload: { personId: randomUUID() } },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      request(
        '/commands',
        'POST',
        await envelope([
          { type: 'DeletePerson', payload: { personId: unlinked } },
          {
            type: 'RestorePerson',
            payload: { personId: unlinked, restoreBeneficiaries: true },
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('archives a linked member and atomically revokes every access and Telegram artifact', async () => {
    const { personId, member } = await join('editor');
    const secondSession = await request('/auth/session', 'POST', {}, bob, '');
    await request('/telegram/link', 'POST', {}, bob, member.sessionToken);
    const linkedAt = now - 1000;
    await local.postgres.query(
      'INSERT INTO brownie_telegram_links(subject,family_id,telegram_user_id,chat_id,username,linked_at) VALUES($1,$2,$3,$4,$5,$6)',
      [bob.subject, login.user.familyId, '10001', '10001', 'bob', linkedAt],
    );
    const jobId = randomUUID();
    await local.postgres.query(
      "INSERT INTO brownie_telegram_report_jobs(id,family_id,subject,family_generation,telegram_linked_at,report_date,scheduled_for,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'queued',$8)",
      [
        jobId,
        login.user.familyId,
        bob.subject,
        login.instanceGeneration,
        linkedAt,
        '2026-09-15',
        now,
        now,
      ],
    );
    await local.postgres.query(
      "INSERT INTO brownie_telegram_once_receipts(family_id,subject,obligation_id,period_id,job_id,delivered_at,outcome) VALUES($1,$2,$3,$4,$5,$6,'reserved')",
      [
        login.user.familyId,
        bob.subject,
        randomUUID(),
        randomUUID(),
        jobId,
        now,
      ],
    );

    await request(
      '/commands',
      'POST',
      await envelope([
        {
          type: 'ArchivePerson',
          payload: {
            personId,
            soleBeneficiaryPolicy: 'keep_nobody',
          },
        },
      ]),
    );
    expect(
      (await state()).people.find((person) => person.id === personId),
    ).toMatchObject({ id: personId, archivedAt: expect.any(String) });
    expect(
      (
        await local.postgres.query(
          'SELECT * FROM brownie_memberships WHERE subject=$1',
          [bob.subject],
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      (
        await local.postgres.query(
          'SELECT * FROM brownie_family_sessions WHERE subject=$1 AND revoked_at IS NULL',
          [bob.subject],
        )
      ).rows,
    ).toHaveLength(0);
    for (const table of [
      'brownie_telegram_links',
      'brownie_telegram_link_tokens',
      'brownie_telegram_report_jobs',
      'brownie_telegram_once_receipts',
    ])
      expect(
        (
          await local.postgres.query(
            `SELECT * FROM ${table} WHERE subject=$1`,
            [bob.subject],
          )
        ).rows,
      ).toHaveLength(0);
    await expect(
      request('/state', 'GET', undefined, bob, secondSession.sessionToken),
    ).rejects.toMatchObject({ code: 'FAMILY_REQUIRED' });

    await request(
      '/commands',
      'POST',
      await envelope([
        {
          type: 'RestorePerson',
          payload: { personId, restoreBeneficiaries: true },
        },
      ]),
    );
    expect(
      (await state()).people.find((person) => person.id === personId),
    ).not.toHaveProperty('archivedAt');
    expect(
      (
        await local.postgres.query(
          'SELECT * FROM brownie_memberships WHERE subject=$1',
          [bob.subject],
        )
      ).rows,
    ).toHaveLength(0);
    await expect(
      request('/state', 'GET', undefined, bob, member.sessionToken),
    ).rejects.toMatchObject({ code: 'FAMILY_REQUIRED' });
  });

  it('deletes an unlinked person, revokes pending invitations and supports receipt retries', async () => {
    const pending = await invite();
    const operationId = randomUUID();
    const command = await envelope(
      [{ type: 'DeletePerson', payload: { personId: pending.personId } }],
      operationId,
    );
    const first = await request('/commands', 'POST', command);
    expect(await request('/commands', 'POST', command)).toEqual(first);
    expect(
      (await state()).people.some((person) => person.id === pending.personId),
    ).toBe(false);
    await expect(
      request('/invitations/accept', 'POST', { token: pending.token }, bob, ''),
    ).rejects.toMatchObject({ code: 'INVITATION_EXPIRED' });
    await expect(
      request('/commands', 'POST', {
        ...command,
        commands: [
          {
            type: 'ArchivePerson',
            payload: {
              personId: pending.personId,
              soleBeneficiaryPolicy: 'keep_nobody',
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });

    const staleTarget = await addPerson('Stale target');
    const stale = await envelope([
      { type: 'DeletePerson', payload: { personId: staleTarget } },
    ]);
    await addPerson('Concurrent change');
    await expect(request('/commands', 'POST', stale)).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
  });

  it('rejects stale or missing preview dates while allowing committed receipt replay after midnight', async () => {
    await request(
      '/commands',
      'POST',
      await envelope([
        { type: 'UpdateHousehold', payload: { timezone: 'UTC' } },
      ]),
    );
    const firstPerson = await addPerson('First person');
    const pending = await invite();
    now = Date.UTC(2026, 8, 15, 23, 50);
    const committed = await envelope([
      {
        type: 'ArchivePerson',
        payload: {
          personId: firstPerson,
          soleBeneficiaryPolicy: 'keep_nobody',
        },
      },
    ]);
    const receipt = await request('/commands', 'POST', committed);
    const stale = await envelope([
      {
        type: 'ArchivePerson',
        payload: {
          personId: pending.personId,
          soleBeneficiaryPolicy: 'end_at_last_accrual',
        },
      },
    ]);
    const before = await state();
    now += 20 * 60_000;
    expect(await request('/commands', 'POST', committed)).toEqual(receipt);
    await expect(request('/commands', 'POST', stale)).rejects.toMatchObject({
      code: 'MEMBER_PREVIEW_EXPIRED',
    });
    expect(await state()).toEqual(before);
    const invitation = (
      await local.postgres.query<{ revoked_at: number | null }>(
        'SELECT revoked_at FROM brownie_invitations WHERE id=$1',
        [pending.invitationId],
      )
    ).rows[0];
    expect(invitation.revoked_at).toBeNull();
    const missing = await envelope([
      {
        type: 'ArchivePerson',
        payload: {
          personId: pending.personId,
          soleBeneficiaryPolicy: 'keep_nobody',
        },
      },
    ]);
    delete (missing.commands[0].payload as { expectedDate?: string })
      .expectedDate;
    await expect(request('/commands', 'POST', missing)).rejects.toMatchObject({
      code: 'MEMBER_PREVIEW_EXPIRED',
    });
    const restore = await envelope([
      {
        type: 'RestorePerson',
        payload: { personId: firstPerson, restoreBeneficiaries: true },
      },
    ]);
    (restore.commands[0].payload as { expectedDate?: string }).expectedDate =
      '2026-09-15';
    await expect(request('/commands', 'POST', restore)).rejects.toMatchObject({
      code: 'MEMBER_PREVIEW_EXPIRED',
    });
  });

  it('rechecks archived invitation targets after the family lock', async () => {
    const pending = await invite();
    await request(
      '/commands',
      'POST',
      await envelope([
        {
          type: 'ArchivePerson',
          payload: {
            personId: pending.personId,
            soleBeneficiaryPolicy: 'keep_nobody',
          },
        },
      ]),
    );
    // Simulate a legacy/unreliable invitation row that was not revoked. The
    // authoritative person state must still prevent acceptance.
    await local.postgres.query(
      'UPDATE brownie_invitations SET revoked_at=NULL WHERE id=$1',
      [pending.invitationId],
    );
    await expect(
      request('/invitations/accept', 'POST', { token: pending.token }, bob, ''),
    ).rejects.toMatchObject({ code: 'INVITATION_EXPIRED' });
  });

  it('rolls back the financial snapshot and access removal when receipt persistence fails', async () => {
    const { personId, member } = await join('editor');
    const command = await envelope([
      { type: 'DeletePerson', payload: { personId } },
    ]);
    const broken: Database = {
      transaction: (work) =>
        local.database.transaction((client) =>
          work({
            query: (sql, values) => {
              if (sql.startsWith('INSERT INTO brownie_family_operations'))
                throw new Error('receipt unavailable');
              return client.query(sql, values);
            },
          }),
        ),
    };
    await expect(
      new FamilyApplication(broken, services).handle({
        path: '/commands',
        method: 'POST',
        body: command,
        identity: alice,
        token: login.sessionToken,
      }),
    ).rejects.toThrow('receipt unavailable');
    expect(
      (await state()).people.some((person) => person.id === personId),
    ).toBe(true);
    expect(
      (
        await local.postgres.query(
          'SELECT * FROM brownie_memberships WHERE subject=$1',
          [bob.subject],
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (await request('/state', 'GET', undefined, bob, member.sessionToken)).user
        .personId,
    ).toBe(personId);
    await request('/commands', 'POST', command);
  });
});

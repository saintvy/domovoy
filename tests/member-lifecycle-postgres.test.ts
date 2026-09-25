import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { openLocalPostgres } from '../scripts/local-postgres';
import type { Database } from '../src/aws/database';
import { FamilyApplication, type InvitationMessage } from '../src/aws/families';
import type { Command, State } from '../src/domain';

function pauseBeforeFamilyLock(database: Database) {
  let release!: () => void;
  let reached!: () => void;
  let paused = false;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const familyLockReached = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const wrapped: Database = {
    transaction: (work) =>
      database.transaction((client) =>
        work({
          query: async (sql, values) => {
            if (
              !paused &&
              sql.startsWith(
                'SELECT * FROM brownie_families WHERE id=$1 FOR UPDATE',
              )
            ) {
              paused = true;
              reached();
              await released;
            }
            return client.query(sql, values);
          },
        }),
      ),
  };
  return { database: wrapped, familyLockReached, release };
}

it.skipIf(process.env.BROWNIE_TEST_DOCKER !== '1')(
  'real PostgreSQL serializes member removal with target requests and invitation acceptance',
  async () => {
    const local = await openLocalPostgres();
    const now = Date.now();
    const suffix = randomUUID();
    const alice = {
      subject: `member-lifecycle-admin-${suffix}`,
      email: `member-lifecycle-admin-${suffix}@example.test`,
      name: 'Lifecycle administrator',
      authenticatedAt: Math.floor(now / 1000),
    };
    const bob = {
      subject: `member-lifecycle-target-${suffix}`,
      email: `member-lifecycle-target-${suffix}@example.test`,
      name: 'Lifecycle target',
      authenticatedAt: Math.floor(now / 1000),
    };
    const charlie = {
      subject: `member-lifecycle-invitee-${suffix}`,
      email: `member-lifecycle-invitee-${suffix}@example.test`,
      name: 'Lifecycle invitee',
      authenticatedAt: Math.floor(now / 1000),
    };
    const messages: InvitationMessage[] = [];
    const services = {
      appOrigin: 'http://127.0.0.1:5173',
      clock: () => now,
      sendInvitation: async (message: InvitationMessage) => {
        messages.push(message);
      },
    };
    const app = new FamilyApplication(local.database, services);
    let familyId: string | undefined;
    try {
      const created = await app.handle({
        path: '/families',
        method: 'POST',
        identity: alice,
        body: {
          name: `Lifecycle PostgreSQL ${suffix}`,
          currency: 'EUR',
          timezone: 'UTC',
          locale: 'en',
        },
      });
      familyId = created.user.familyId;
      const aliceRequest = (path: string, method = 'GET', body?: any) =>
        app.handle({
          path,
          method,
          body,
          identity: alice,
          token: created.sessionToken,
        });
      const state = async () => (await aliceRequest('/state')).state as State;
      const envelope = async (
        commands: Command[],
        operationId = randomUUID(),
      ) => ({
        protocolVersion: 1,
        operationId,
        instanceGeneration: created.instanceGeneration,
        expectedRevision: (await state()).revision,
        commands: commands.map((command) =>
          command.type === 'ArchivePerson' || command.type === 'RestorePerson'
            ? {
                ...command,
                payload: {
                  ...command.payload,
                  expectedDate: new Date(now).toISOString().slice(0, 10),
                },
              }
            : command,
        ),
      });
      const addPerson = async (displayName: string) => {
        const personId = randomUUID();
        await aliceRequest(
          '/commands',
          'POST',
          await envelope([
            { type: 'AddPerson', payload: { id: personId, displayName } },
          ]),
        );
        return personId;
      };
      const invite = async (
        personId: string,
        identity: typeof bob | typeof charlie,
      ) => {
        await aliceRequest('/family/invitations', 'POST', {
          personId,
          email: identity.email,
          role: 'editor',
        });
        return new URLSearchParams(
          new URL(messages.at(-1)!.url).hash.slice(1),
        ).get('invite')!;
      };

      const bobPersonId = await addPerson(bob.name);
      const bobToken = await invite(bobPersonId, bob);
      const bobSession = await app.handle({
        path: '/invitations/accept',
        method: 'POST',
        body: { token: bobToken },
        identity: bob,
      });
      expect(bobSession.user.role).toBe('editor');

      // The target transaction holds only its own account lock while paused.
      // Removal must not acquire that account lock after taking the family lock.
      const targetPause = pauseBeforeFamilyLock(local.database);
      const targetApp = new FamilyApplication(targetPause.database, services);
      const targetRequest = targetApp.handle({
        path: '/state',
        method: 'GET',
        identity: bob,
        token: bobSession.sessionToken,
      });
      await targetPause.familyLockReached;
      const archiveOperation = await envelope([
        {
          type: 'ArchivePerson',
          payload: {
            personId: bobPersonId,
            soleBeneficiaryPolicy: 'keep_nobody',
          },
        },
      ]);
      let archiveResult: any;
      try {
        archiveResult = await aliceRequest(
          '/commands',
          'POST',
          archiveOperation,
        );
      } finally {
        targetPause.release();
      }
      await expect(targetRequest).rejects.toMatchObject({
        code: 'SESSION_REVOKED',
      });
      expect(await aliceRequest('/commands', 'POST', archiveOperation)).toEqual(
        archiveResult,
      );
      const bobMemberships = await local.database.transaction(
        async (client) =>
          (
            await client.query(
              'SELECT subject FROM brownie_memberships WHERE family_id=$1 AND person_id=$2',
              [familyId, bobPersonId],
            )
          ).rows,
      );
      expect(bobMemberships).toHaveLength(0);

      const charliePersonId = await addPerson(charlie.name);
      const charlieToken = await invite(charliePersonId, charlie);
      const acceptPause = pauseBeforeFamilyLock(local.database);
      const acceptingApp = new FamilyApplication(
        acceptPause.database,
        services,
      );
      const acceptance = acceptingApp.handle({
        path: '/invitations/accept',
        method: 'POST',
        body: { token: charlieToken },
        identity: charlie,
      });
      await acceptPause.familyLockReached;
      try {
        await aliceRequest(
          '/commands',
          'POST',
          await envelope([
            {
              type: 'ArchivePerson',
              payload: {
                personId: charliePersonId,
                soleBeneficiaryPolicy: 'keep_nobody',
              },
            },
          ]),
        );
      } finally {
        acceptPause.release();
      }
      await expect(acceptance).rejects.toMatchObject({
        code: 'INVITATION_EXPIRED',
      });
      const accessRows = await local.database.transaction(async (client) => ({
        memberships: (
          await client.query(
            'SELECT subject FROM brownie_memberships WHERE family_id=$1 AND person_id=$2',
            [familyId, charliePersonId],
          )
        ).rows,
        invitations: (
          await client.query(
            'SELECT revoked_at,accepted_at FROM brownie_invitations WHERE family_id=$1 AND person_id=$2',
            [familyId, charliePersonId],
          )
        ).rows,
      }));
      expect(accessRows.memberships).toHaveLength(0);
      expect(accessRows.invitations).toEqual([
        { revoked_at: String(now), accepted_at: null },
      ]);
    } finally {
      await local.database.transaction(async (client) => {
        if (familyId)
          await client.query('DELETE FROM brownie_families WHERE id=$1', [
            familyId,
          ]);
        await client.query(
          'DELETE FROM brownie_accounts WHERE subject=ANY($1::text[])',
          [[alice.subject, bob.subject, charlie.subject]],
        );
      });
      await local.close();
    }
  },
  30000,
);

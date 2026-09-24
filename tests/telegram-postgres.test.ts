import { expect, it, vi } from 'vitest';
import { randomInt, randomUUID } from 'node:crypto';
import { openLocalPostgres } from '../scripts/local-postgres';
import { FamilyApplication } from '../src/aws/families';
import { handleTelegramBridge } from '../src/aws/telegram-bridge';
import { createTelegramWorker } from '../src/aws/telegram-worker';

it.skipIf(process.env.BROWNIE_TEST_DOCKER !== '1')(
  'real PostgreSQL serializes token consumption and competing once-report worker claims',
  async () => {
    const local = await openLocalPostgres();
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const identity = {
      subject: `telegram-pg-${randomUUID()}`,
      email: `${randomUUID()}@example.test`,
      name: 'Telegram SQL test',
      authenticatedAt: Math.floor(now / 1000),
    };
    const services = {
      appOrigin: 'http://127.0.0.1:5173',
      clock: () => now,
      queueTelegramReport: async () => {},
    };
    const app = new FamilyApplication(local.database, services);
    const updateIds = [now, now + 1];
    let familyId: string | undefined;
    try {
      const created = await app.handle({
        path: '/families',
        method: 'POST',
        identity,
        body: {
          name: 'Telegram SQL test',
          currency: 'EUR',
          timezone: 'UTC',
          locale: 'en',
        },
      });
      const request = (path: string, method = 'GET', body?: any) =>
        app.handle({
          path,
          method,
          body,
          identity,
          token: created.sessionToken,
        });
      const snapshot = await request('/state');
      familyId = snapshot.state.household.id;
      const link = await request('/telegram/link', 'POST');
      const token = new URL(link.url).searchParams.get('start')!;
      const telegramId = String(randomInt(1_000_000_000, 2_000_000_000));
      const consumed = await Promise.all(
        updateIds.map((updateId) =>
          handleTelegramBridge(local.database, services, {
            action: 'telegram.consume-link',
            updateId,
            token,
            telegramUserId: telegramId,
            chatId: telegramId,
          }),
        ),
      );
      expect(
        consumed.filter((result) => 'ok' in result && result.ok),
      ).toHaveLength(1);
      const obligationId = randomUUID(),
        providerId = randomUUID();
      await request('/commands', 'POST', {
        protocolVersion: 1,
        operationId: randomUUID(),
        instanceGeneration: snapshot.instanceGeneration,
        expectedRevision: snapshot.revision,
        commands: [
          {
            type: 'AddObligation',
            payload: {
              obligation: {
                id: obligationId,
                providerId,
                title: 'One-time SQL reminder',
                coverageMode: 'household',
                ownerPersonId: created.user.personId,
                activeFrom: today,
                lifecycleState: 'active',
                reminder: { enabled: true, daysBefore: 1, repeat: 'once' },
              },
              provider: {
                id: providerId,
                name: 'Test provider',
                category: 'other',
              },
              rule: {
                id: randomUUID(),
                obligationId,
                effectiveFrom: today,
                anchor: today,
                cadence: 'monthly',
                dueOffsetDays: 0,
                amountMode: 'fixed',
                amount: 2500,
                currency: 'EUR',
                reminderDays: 0,
                graceDays: 0,
              },
            },
          },
        ],
      });
      const jobs = [randomUUID(), randomUUID()];
      await local.database.transaction(async (client) => {
        for (const [part, id] of jobs.entries())
          await client.query(
            "INSERT INTO brownie_telegram_report_jobs(id,family_id,subject,family_generation,telegram_linked_at,report_date,part,scheduled_for,status,created_at) SELECT $1,f.id,$2,f.generation,l.linked_at,$3,$4,$5,'queued',$5 FROM brownie_families f JOIN brownie_telegram_links l ON l.family_id=f.id AND l.subject=$2 WHERE f.id=$6",
            [id, identity.subject, today, part, now, familyId],
          );
      });
      const provider = vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({ ok: true, result: { message_id: 42 } }),
          ),
      );
      const worker = createTelegramWorker({
        bucket: 'test-services',
        fetch: provider,
        secrets: async () => ({
          token: 'fictional-token',
          webhookSecret: 'fictional-secret',
        }),
        remove: async () => {},
        bridge: (event) =>
          handleTelegramBridge(local.database, services, event as any),
      });
      await Promise.all(
        jobs.map((jobId) =>
          worker({
            Records: [
              {
                s3: {
                  bucket: { name: 'test-services' },
                  object: { key: `telegram-outbox/${jobId}.json` },
                },
              },
            ],
          }),
        ),
      );
      expect(provider).toHaveBeenCalledTimes(1);
      const outcomes = await local.database.transaction(
        async (client) =>
          (
            await client.query(
              'SELECT status,message_id FROM brownie_telegram_report_jobs WHERE family_id=$1',
              [familyId],
            )
          ).rows,
      );
      expect(outcomes.filter((row) => row.status === 'accepted')).toEqual([
        { status: 'accepted', message_id: '42' },
      ]);
      expect(outcomes.filter((row) => row.status === 'skipped')).toHaveLength(
        1,
      );
    } finally {
      await local.database.transaction(async (client) => {
        if (familyId)
          await client.query('DELETE FROM brownie_families WHERE id=$1', [
            familyId,
          ]);
        await client.query('DELETE FROM brownie_accounts WHERE subject=$1', [
          identity.subject,
        ]);
        await client.query(
          'DELETE FROM brownie_telegram_updates WHERE update_id=ANY($1::text[])',
          [updateIds.map(String)],
        );
      });
      await local.close();
    }
  },
  30000,
);

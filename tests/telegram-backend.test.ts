import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { FamilyApplication, type FamilyServices } from '../src/aws/families';
import { createLocalDatabase } from '../src/aws/local-database';
import { handleTelegramBridge } from '../src/aws/telegram-bridge';
import {
  nextTelegramReportAt,
  scheduleTelegramReports,
} from '../src/aws/telegram-reminders';
import type { Command, State } from '../src/domain';
import type { Identity } from '../src/aws/identity';

describe('Telegram reminder backend', () => {
  let local: Awaited<ReturnType<typeof createLocalDatabase>>;
  let app: FamilyApplication;
  let services: FamilyServices;
  let login: any;
  let now: number;
  let queued: string[];
  let invitationUrl: string | undefined;
  const alice: Identity = {
    subject: 'telegram-alice',
    email: 'telegram-alice@example.test',
    name: 'Alice',
    authenticatedAt: 1_900_000_000,
  };
  const bob: Identity = {
    subject: 'telegram-bob',
    email: 'telegram-bob@example.test',
    name: 'Bob',
    authenticatedAt: 1_900_000_000,
  };
  const request = (
    path: string,
    method = 'GET',
    body?: any,
    identity: Identity | undefined = alice,
    token = login?.sessionToken,
  ) => app.handle({ path, method, body, identity, token });
  const state = async () => (await request('/state')).state as State;
  const commit = async (commands: Command[]) =>
    request('/commands', 'POST', {
      protocolVersion: 1,
      operationId: randomUUID(),
      instanceGeneration: login.instanceGeneration,
      expectedRevision: (await state()).revision,
      commands,
    });
  const linkToken = async () => {
    const linked = await request('/telegram/link', 'POST');
    return new URL(linked.url).searchParams.get('start')!;
  };
  const consume = (token: string, updateId: number, telegramUserId = '101') =>
    handleTelegramBridge(local.database, services, {
      action: 'telegram.consume-link',
      token,
      updateId,
      telegramUserId,
      chatId: telegramUserId,
      username: 'alice_tg',
    });

  beforeAll(async () => {
    local = await createLocalDatabase();
  }, 30_000);

  beforeEach(async () => {
    await local.postgres.exec(
      'TRUNCATE brownie_telegram_updates,brownie_accounts,brownie_families CASCADE',
    );
    now = Date.UTC(2026, 8, 23, 7);
    queued = [];
    invitationUrl = undefined;
    services = {
      appOrigin: 'https://domovoy.test',
      clock: () => now,
      queueTelegramReport: async (jobId) => {
        queued.push(jobId);
      },
      sendInvitation: async (message) => {
        invitationUrl = message.url;
      },
    };
    app = new FamilyApplication(local.database, services);
    login = await app.handle({
      path: '/families',
      method: 'POST',
      identity: alice,
      body: {
        name: 'Home',
        currency: 'EUR',
        timezone: 'Europe/Prague',
      },
    });
  });

  afterAll(async () => {
    await local?.postgres.close();
  });

  it('keeps a local wall-clock hour across DST and does not run twice in a repeated hour', () => {
    const summer = nextTelegramReportAt(
      { hour: 9, timeZone: 'Europe/Prague' },
      Date.UTC(2026, 6, 1, 6),
    );
    const winter = nextTelegramReportAt(
      { hour: 9, timeZone: 'Europe/Prague' },
      Date.UTC(2026, 11, 1, 7),
    );
    expect(new Date(summer).toISOString()).toBe('2026-07-01T07:00:00.000Z');
    expect(new Date(winter).toISOString()).toBe('2026-12-01T08:00:00.000Z');
    const firstRepeatedHour = nextTelegramReportAt(
      { hour: 2, timeZone: 'Europe/Prague' },
      Date.UTC(2026, 9, 24, 23),
    );
    expect(new Date(firstRepeatedHour).toISOString()).toBe(
      '2026-10-25T00:00:00.000Z',
    );
    expect(
      new Date(
        nextTelegramReportAt(
          { hour: 2, timeZone: 'Europe/Prague' },
          firstRepeatedHour,
        ),
      ).toISOString(),
    ).toBe('2026-10-26T01:00:00.000Z');
  });

  it('authorizes member schedules and exposes only safe Telegram link metadata', async () => {
    await expect(
      app.handle({ path: '/telegram/link', method: 'POST' }),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(
      request('/family/members/missing/reminders', 'PATCH', {
        telegramReportTime: { hour: 12, timeZone: 'Europe/Prague' },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const changed = await request(
      `/family/members/${encodeURIComponent(alice.subject)}/reminders`,
      'PATCH',
      { telegramReportTime: { hour: 12, timeZone: 'Europe/Prague' } },
    );
    expect(changed).toMatchObject({
      telegramReportTime: { hour: 12, timeZone: 'Europe/Prague' },
    });
    expect(changed.nextReportAt).toMatch(/^2026-09-23T10:00:00\.000Z$/);
    const token = await linkToken();
    expect(JSON.stringify(await request('/family/members'))).not.toContain(
      token,
    );
    expect((await request('/family/members')).members[0].telegram).toEqual({
      linked: false,
    });
  });

  it('initializes only a joining member and preserves overrides when the family default changes', async () => {
    const bobPersonId = randomUUID();
    await commit([
      {
        type: 'AddPerson',
        payload: { id: bobPersonId, displayName: 'Bob' },
      },
    ]);
    await request('/family/invitations', 'POST', {
      personId: bobPersonId,
      email: bob.email,
      role: 'observer',
    });
    const marker = now - 12345;
    await local.postgres.query(
      'UPDATE brownie_memberships SET next_telegram_report_at=$1 WHERE subject=$2',
      [marker, alice.subject],
    );
    const invitationToken = new URLSearchParams(
      new URL(invitationUrl!).hash.slice(1),
    ).get('invite')!;
    await request(
      '/invitations/accept',
      'POST',
      { token: invitationToken },
      bob,
      '',
    );
    expect(
      Number(
        (
          await local.postgres.query<{ next_telegram_report_at: number }>(
            'SELECT next_telegram_report_at FROM brownie_memberships WHERE subject=$1',
            [alice.subject],
          )
        ).rows[0].next_telegram_report_at,
      ),
    ).toBe(marker);

    await request(
      `/family/members/${encodeURIComponent(alice.subject)}/reminders`,
      'PATCH',
      { telegramReportTime: { hour: 12, timeZone: 'Europe/Prague' } },
    );
    const aliceOverrideNext = Number(
      (
        await local.postgres.query<{ next_telegram_report_at: number }>(
          'SELECT next_telegram_report_at FROM brownie_memberships WHERE subject=$1',
          [alice.subject],
        )
      ).rows[0].next_telegram_report_at,
    );
    const bobBefore = Number(
      (
        await local.postgres.query<{ next_telegram_report_at: number }>(
          'SELECT next_telegram_report_at FROM brownie_memberships WHERE subject=$1',
          [bob.subject],
        )
      ).rows[0].next_telegram_report_at,
    );
    await commit([
      {
        type: 'UpdateHousehold',
        payload: {
          telegramReportTime: { hour: 13, timeZone: 'Europe/Prague' },
        },
      },
    ]);
    const schedules = await local.postgres.query<{
      subject: string;
      next_telegram_report_at: number;
    }>(
      'SELECT subject,next_telegram_report_at FROM brownie_memberships WHERE family_id=$1',
      [login.user.familyId],
    );
    const nextBySubject = new Map(
      schedules.rows.map((row) => [
        row.subject,
        Number(row.next_telegram_report_at),
      ]),
    );
    expect(nextBySubject.get(alice.subject)).toBe(aliceOverrideNext);
    expect(nextBySubject.get(bob.subject)).not.toBe(bobBefore);
  });

  it('binds a one-use account token, makes successful update replay idempotent, and supports relink/unlink', async () => {
    const token = await linkToken();
    expect(await consume(token, 1)).toEqual({ ok: true });
    expect(await consume(token, 1)).toEqual({ ok: true });
    expect(await consume(token, 2)).toEqual({ ok: false });
    expect((await request('/family/members')).members[0].telegram).toEqual({
      linked: true,
      username: 'alice_tg',
    });
    const replacement = await linkToken();
    expect(await consume(replacement, 3, '202')).toEqual({ ok: true });
    await request('/telegram/link', 'DELETE');
    expect((await request('/family/members')).members[0].telegram.linked).toBe(
      false,
    );
  });

  it('rejects expired tokens and a private chat that does not match the Telegram user', async () => {
    const expired = await linkToken();
    now += 11 * 60000;
    expect(await consume(expired, 10)).toEqual({ ok: false });
    const fresh = await linkToken();
    expect(
      await handleTelegramBridge(local.database, services, {
        action: 'telegram.consume-link',
        token: fresh,
        updateId: 11,
        telegramUserId: '301',
        chatId: '302',
      }),
    ).toEqual({ ok: false });
  });

  async function createDueOnceReminder() {
    const personId = login.user.personId;
    const obligationId = randomUUID();
    const providerId = randomUUID();
    await commit([
      {
        type: 'AddObligation',
        payload: {
          obligation: {
            id: obligationId,
            providerId,
            title: 'Internet',
            coverageMode: 'household',
            ownerPersonId: personId,
            activeFrom: '2026-09-01',
            lifecycleState: 'active',
            reminder: { enabled: true, daysBefore: 1, repeat: 'once' },
          },
          provider: {
            id: providerId,
            name: 'ISP',
            category: 'internet',
          },
          rule: {
            id: randomUUID(),
            obligationId,
            effectiveFrom: '2026-09-01',
            cadence: 'monthly',
            anchor: '2026-09-23',
            dueOffsetDays: 0,
            amountMode: 'fixed',
            amount: 2599,
            currency: 'EUR',
            reminderDays: 0,
            graceDays: 0,
          },
        },
      },
    ]);
  }

  async function makeDueJob() {
    await local.postgres.query(
      'UPDATE brownie_memberships SET next_telegram_report_at=$1 WHERE subject=$2',
      [now, alice.subject],
    );
    await scheduleTelegramReports(local.database, services);
    const row = (
      await local.postgres.query<{ id: string }>(
        'SELECT id FROM brownie_telegram_report_jobs ORDER BY created_at DESC LIMIT 1',
      )
    ).rows[0];
    return row.id;
  }

  it('durably schedules once, revalidates before delivery, and reserves one-time items across jobs', async () => {
    await createDueOnceReminder();
    expect(await consume(await linkToken(), 20)).toEqual({ ok: true });
    const jobId = await makeDueJob();
    expect(queued).toEqual([jobId]);
    await scheduleTelegramReports(local.database, services);
    expect(
      (
        await local.postgres.query(
          'SELECT id FROM brownie_telegram_report_jobs',
        )
      ).rows,
    ).toHaveLength(1);
    const first = await handleTelegramBridge(local.database, services, {
      action: 'telegram.begin-delivery',
      jobId,
      attemptId: 'attempt-1',
    });
    expect(first).toMatchObject({ send: true, chatId: '101' });
    expect(first).toHaveProperty('text', expect.stringContaining('Internet'));
    expect(
      await handleTelegramBridge(local.database, services, {
        action: 'telegram.begin-delivery',
        jobId,
        attemptId: 'attempt-duplicate',
      }),
    ).toEqual({ send: false });

    const original = (
      await local.postgres.query<any>(
        'SELECT * FROM brownie_telegram_report_jobs WHERE id=$1',
        [jobId],
      )
    ).rows[0];
    const secondJob = randomUUID();
    await local.postgres.query(
      "INSERT INTO brownie_telegram_report_jobs(id,family_id,subject,family_generation,telegram_linked_at,report_date,scheduled_for,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'queued',$8)",
      [
        secondJob,
        original.family_id,
        original.subject,
        original.family_generation,
        original.telegram_linked_at,
        '2026-09-24',
        now + 86400000,
        now,
      ],
    );
    expect(
      await handleTelegramBridge(local.database, services, {
        action: 'telegram.begin-delivery',
        jobId: secondJob,
        attemptId: 'attempt-2',
      }),
    ).toEqual({ send: false });
  });

  it('releases one-time reservations after 429 and records missing completion as unknown', async () => {
    await createDueOnceReminder();
    await consume(await linkToken(), 30);
    const jobId = await makeDueJob();
    expect(
      await handleTelegramBridge(local.database, services, {
        action: 'telegram.begin-delivery',
        jobId,
        attemptId: 'rate-limited',
      }),
    ).toMatchObject({ send: true });
    expect(
      await handleTelegramBridge(local.database, services, {
        action: 'telegram.finish-delivery',
        jobId,
        attemptId: 'rate-limited',
        outcome: 'retryable',
        retryAfterSeconds: 7200,
      }),
    ).toEqual({ ok: true });
    expect(
      (
        await local.postgres.query(
          'SELECT * FROM brownie_telegram_once_receipts',
        )
      ).rows,
    ).toHaveLength(0);
    now += 7200 * 1000;
    await scheduleTelegramReports(local.database, services);
    expect(queued.filter((id) => id === jobId).length).toBeGreaterThan(1);
    expect(
      await handleTelegramBridge(local.database, services, {
        action: 'telegram.begin-delivery',
        jobId,
        attemptId: 'lost-completion',
      }),
    ).toMatchObject({ send: true });
    now += 16 * 60000;
    await scheduleTelegramReports(local.database, services);
    expect(
      (
        await local.postgres.query<{ status: string }>(
          'SELECT status FROM brownie_telegram_report_jobs WHERE id=$1',
          [jobId],
        )
      ).rows[0].status,
    ).toBe('unknown');
    expect(
      (
        await local.postgres.query<{ outcome: string }>(
          'SELECT outcome FROM brownie_telegram_once_receipts',
        )
      ).rows[0].outcome,
    ).toBe('unknown');
  });

  it('keeps a queued SQL job when S3 publication fails and invalidates it after same-clock relinking', async () => {
    await createDueOnceReminder();
    await consume(await linkToken(), 40);
    services.queueTelegramReport = async () => {
      throw new Error('S3 unavailable');
    };
    const jobId = await makeDueJob();
    expect(
      (
        await local.postgres.query<{ status: string }>(
          'SELECT status FROM brownie_telegram_report_jobs WHERE id=$1',
          [jobId],
        )
      ).rows[0].status,
    ).toBe('queued');
    expect(await consume(await linkToken(), 41, '404')).toEqual({ ok: true });
    expect(
      await handleTelegramBridge(local.database, services, {
        action: 'telegram.begin-delivery',
        jobId,
        attemptId: 'stale-relinked-chat',
      }),
    ).toEqual({ send: false });
  });

  it('materializes oversized reports as durable parts without missing items or early once receipts', async () => {
    const commands: Command[] = [];
    for (let index = 0; index < 35; index++) {
      const obligationId = randomUUID();
      const providerId = randomUUID();
      commands.push({
        type: 'AddObligation',
        payload: {
          obligation: {
            id: obligationId,
            providerId,
            title: `Very long obligation ${String(index).padStart(2, '0')} ${'x'.repeat(150)}`,
            coverageMode: 'household',
            ownerPersonId: login.user.personId,
            activeFrom: '2026-09-01',
            lifecycleState: 'active',
            reminder: { enabled: true, daysBefore: 1, repeat: 'once' },
          },
          provider: {
            id: providerId,
            name: `Provider ${index}`,
            category: 'other',
          },
          rule: {
            id: randomUUID(),
            obligationId,
            effectiveFrom: '2026-09-01',
            cadence: 'monthly',
            anchor: '2026-09-23',
            dueOffsetDays: 0,
            amountMode: 'fixed',
            amount: 1000 + index,
            currency: 'EUR',
            reminderDays: 0,
            graceDays: 0,
          },
        },
      });
    }
    await commit(commands);
    await consume(await linkToken(), 50);
    const firstJob = await makeDueJob();
    const delivered: Array<{ id: string; attempt: string; keys: string[] }> =
      [];
    const claim = async (id: string, attempt: string) => {
      const result = await handleTelegramBridge(local.database, services, {
        action: 'telegram.begin-delivery',
        jobId: id,
        attemptId: attempt,
      });
      expect(result).toMatchObject({ send: true });
      if ('send' in result && result.send)
        expect(result.text.length).toBeLessThanOrEqual(4096);
      const row = (
        await local.postgres.query<{ item_keys: string[] }>(
          'SELECT item_keys FROM brownie_telegram_report_jobs WHERE id=$1',
          [id],
        )
      ).rows[0];
      delivered.push({ id, attempt, keys: row.item_keys });
    };
    await claim(firstJob, 'multipart-0');
    const continuations = (
      await local.postgres.query<{ id: string; part: number }>(
        'SELECT id,part FROM brownie_telegram_report_jobs WHERE id<>$1 ORDER BY part',
        [firstJob],
      )
    ).rows;
    expect(continuations.length).toBeGreaterThan(0);
    for (const job of continuations)
      await claim(job.id, `multipart-${job.part}`);
    const allKeys = delivered.flatMap((part) => part.keys);
    expect(allKeys).toHaveLength(35);
    expect(new Set(allKeys).size).toBe(35);

    await handleTelegramBridge(local.database, services, {
      action: 'telegram.finish-delivery',
      jobId: delivered[0].id,
      attemptId: delivered[0].attempt,
      outcome: 'accepted',
      messageId: 9001,
    });
    const receiptCounts = (
      await local.postgres.query<{ outcome: string; count: number }>(
        'SELECT outcome,count(*)::integer AS count FROM brownie_telegram_once_receipts GROUP BY outcome',
      )
    ).rows;
    expect(receiptCounts.find((row) => row.outcome === 'accepted')?.count).toBe(
      delivered[0].keys.length,
    );
    for (const part of delivered.slice(1))
      await handleTelegramBridge(local.database, services, {
        action: 'telegram.finish-delivery',
        jobId: part.id,
        attemptId: part.attempt,
        outcome: 'accepted',
        messageId: 9002,
      });
    expect(
      Number(
        (
          await local.postgres.query<{ count: number }>(
            "SELECT count(*)::integer AS count FROM brownie_telegram_once_receipts WHERE outcome='accepted'",
          )
        ).rows[0].count,
      ),
    ).toBe(35);
  });

  it('drains more than one scheduler page of legacy and due memberships', async () => {
    const familyId = login.user.familyId;
    await local.postgres.query(
      "INSERT INTO brownie_accounts(subject,email,name) SELECT 'batch-'||n,'batch-'||n||'@example.test','Batch '||n FROM generate_series(1,105) AS n",
    );
    await local.postgres.query(
      "INSERT INTO brownie_memberships(subject,family_id,person_id,role) SELECT 'batch-'||n,$1,'person-'||n,'observer' FROM generate_series(1,105) AS n",
      [familyId],
    );
    await local.postgres.query(
      'UPDATE brownie_memberships SET next_telegram_report_at=NULL WHERE family_id=$1',
      [familyId],
    );
    await scheduleTelegramReports(local.database, services);
    expect(
      Number(
        (
          await local.postgres.query<{ count: number }>(
            'SELECT count(*)::integer AS count FROM brownie_memberships WHERE family_id=$1 AND next_telegram_report_at IS NULL',
            [familyId],
          )
        ).rows[0].count,
      ),
    ).toBe(0);
    expect(
      Number(
        (
          await local.postgres.query<{ count: number }>(
            'SELECT count(*)::integer AS count FROM brownie_memberships WHERE family_id=$1 AND next_telegram_report_at<=$2',
            [familyId, now],
          )
        ).rows[0].count,
      ),
    ).toBe(0);
  });
});

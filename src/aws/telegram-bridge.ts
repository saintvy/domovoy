import { createDatabase, type Database } from './database';
import { randomUUID } from 'node:crypto';
import { digest } from './identity';
import { productionServices } from './services';
import {
  scheduleTelegramReports,
  selectCurrentReport,
  persistOnceReceipts,
  type TelegramReportPublisher,
} from './telegram-reminders';
import { isAppLocale, type AppLocale } from '../shared/locale';

export type TelegramBridgeEvent =
  | { action: 'telegram.schedule' }
  | {
      action: 'telegram.consume-link';
      updateId: number;
      token: string;
      telegramUserId: string;
      chatId: string;
      username?: string;
    }
  | { action: 'telegram.begin-delivery'; jobId: string; attemptId: string }
  | {
      action: 'telegram.finish-delivery';
      jobId: string;
      attemptId: string;
      outcome: 'accepted' | 'retryable' | 'failed' | 'unknown';
      messageId?: number;
      retryAfterSeconds?: number;
      errorCode?: string;
    };

export type TelegramBridgeResult =
  | {
      results: Array<{ familyId: string; subject: string; status: string }>;
      retriesQueued: number;
    }
  | { ok: boolean; locale?: AppLocale }
  | { send: false }
  | { send: true; chatId: string; text: string };

const boundedId = (value: unknown, maximum = 150) =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;

let productionDatabase: Database | undefined;

/** Dedicated Lambda entry point used by the IAM-only scheduler/worker bridge. */
export async function handler(event: TelegramBridgeEvent) {
  productionDatabase ??= createDatabase(process.env, { maxConnections: 1 });
  return handleTelegramBridge(productionDatabase, productionServices(), event);
}

/** IAM-only entry point. It intentionally accepts no browser identity or family id. */
export async function handleTelegramBridge(
  database: Database,
  services: TelegramReportPublisher,
  event: TelegramBridgeEvent,
): Promise<TelegramBridgeResult> {
  if (event.action === 'telegram.schedule')
    return scheduleTelegramReports(database, services);
  if (event.action === 'telegram.consume-link')
    return consumeTelegramLink(
      database,
      services.clock?.() ?? Date.now(),
      event,
    );
  if (event.action === 'telegram.begin-delivery')
    return beginTelegramDelivery(
      database,
      services,
      services.clock?.() ?? Date.now(),
      event,
    );
  if (event.action === 'telegram.finish-delivery')
    return finishTelegramDelivery(
      database,
      services.clock?.() ?? Date.now(),
      event,
    );
  throw new Error('Unsupported Telegram bridge action');
}

async function consumeTelegramLink(
  database: Database,
  now: number,
  event: Extract<TelegramBridgeEvent, { action: 'telegram.consume-link' }>,
): Promise<{ ok: boolean; locale?: AppLocale }> {
  if (
    !Number.isSafeInteger(event.updateId) ||
    event.updateId < 0 ||
    !/^[A-Za-z0-9_-]{43}$/.test(event.token) ||
    !/^\d{1,20}$/.test(event.telegramUserId) ||
    event.telegramUserId !== event.chatId ||
    (event.username !== undefined && !boundedId(event.username, 64))
  )
    return { ok: false };
  return database.transaction(async (client) => {
    const updateId = String(event.updateId);
    const update = await client.query(
      'INSERT INTO brownie_telegram_updates(update_id,handled_at,ok) VALUES($1,$2,false) ON CONFLICT(update_id) DO NOTHING RETURNING update_id',
      [updateId, now],
    );
    if (!update.rows.length) {
      const replay = (
        await client.query(
          'SELECT ok,locale FROM brownie_telegram_updates WHERE update_id=$1',
          [updateId],
        )
      ).rows[0];
      return {
        ok: replay?.ok === true,
        ...(replay?.ok === true && isAppLocale(replay.locale)
          ? { locale: replay.locale }
          : {}),
      };
    }
    const candidate = (
      await client.query(
        'SELECT subject,family_id FROM brownie_telegram_link_tokens WHERE token_hash=$1',
        [digest(event.token)],
      )
    ).rows[0];
    if (!candidate) return { ok: false };
    // Use the same lock order as authenticated family writes. Leaving/unlinking
    // cannot race a token into a different or deleted membership.
    const account = (
      await client.query(
        'SELECT subject,preferred_locale FROM brownie_accounts WHERE subject=$1 FOR UPDATE',
        [candidate.subject],
      )
    ).rows[0];
    const family = (
      await client.query(
        'SELECT id FROM brownie_families WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',
        [candidate.family_id],
      )
    ).rows[0];
    if (!family) return { ok: false };
    const token = (
      await client.query(
        'SELECT subject,family_id,expires_at,consumed_at FROM brownie_telegram_link_tokens WHERE token_hash=$1 FOR UPDATE',
        [digest(event.token)],
      )
    ).rows[0];
    if (
      !token ||
      token.subject !== candidate.subject ||
      token.family_id !== candidate.family_id ||
      token.consumed_at !== null ||
      Number(token.expires_at) <= now
    )
      return { ok: false };
    const conflict = (
      await client.query(
        'SELECT subject FROM brownie_telegram_links WHERE (telegram_user_id=$1 OR chat_id=$2) AND subject<>$3',
        [event.telegramUserId, event.chatId, token.subject],
      )
    ).rows[0];
    if (conflict) {
      await client.query(
        'UPDATE brownie_telegram_link_tokens SET consumed_at=$1 WHERE token_hash=$2',
        [now, digest(event.token)],
      );
      return { ok: false };
    }
    const membership = (
      await client.query(
        'SELECT subject FROM brownie_memberships WHERE subject=$1 AND family_id=$2',
        [token.subject, token.family_id],
      )
    ).rows[0];
    if (!membership) return { ok: false };
    await client.query(
      'UPDATE brownie_telegram_link_tokens SET consumed_at=$1 WHERE token_hash=$2',
      [now, digest(event.token)],
    );
    await client.query(
      'INSERT INTO brownie_telegram_links(subject,family_id,telegram_user_id,chat_id,username,linked_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(subject) DO UPDATE SET family_id=EXCLUDED.family_id,telegram_user_id=EXCLUDED.telegram_user_id,chat_id=EXCLUDED.chat_id,username=EXCLUDED.username,linked_at=GREATEST(brownie_telegram_links.linked_at+1,EXCLUDED.linked_at)',
      [
        token.subject,
        token.family_id,
        event.telegramUserId,
        event.chatId,
        event.username ?? null,
        now,
      ],
    );
    const locale = isAppLocale(account?.preferred_locale)
      ? account.preferred_locale
      : undefined;
    await client.query(
      'UPDATE brownie_telegram_updates SET ok=true,locale=$2 WHERE update_id=$1',
      [updateId, locale ?? null],
    );
    return { ok: true, ...(locale ? { locale } : {}) };
  });
}

async function beginTelegramDelivery(
  database: Database,
  services: TelegramReportPublisher,
  now: number,
  event: Extract<TelegramBridgeEvent, { action: 'telegram.begin-delivery' }>,
): Promise<{ send: false } | { send: true; chatId: string; text: string }> {
  if (!boundedId(event.jobId) || !boundedId(event.attemptId))
    return { send: false };
  const claimed = await database.transaction(async (client) => {
    const candidate = (
      await client.query(
        'SELECT family_id,subject FROM brownie_telegram_report_jobs WHERE id=$1',
        [event.jobId],
      )
    ).rows[0];
    if (!candidate)
      return {
        response: { send: false } as const,
        continuations: [] as string[],
      };
    await client.query(
      'SELECT subject FROM brownie_accounts WHERE subject=$1 FOR UPDATE',
      [candidate.subject],
    );
    await client.query(
      'SELECT id FROM brownie_families WHERE id=$1 FOR UPDATE',
      [candidate.family_id],
    );
    const job = (
      await client.query(
        'SELECT * FROM brownie_telegram_report_jobs WHERE id=$1 FOR UPDATE',
        [event.jobId],
      )
    ).rows[0];
    if (!job)
      return {
        response: { send: false } as const,
        continuations: [] as string[],
      };
    const available =
      job.status === 'queued' ||
      (job.status === 'retryable' && Number(job.retry_after) <= now);
    if (!available)
      return {
        response: { send: false } as const,
        continuations: [] as string[],
      };
    if (Number(job.scheduled_for) < now - 24 * 3600000) {
      await client.query(
        "UPDATE brownie_telegram_report_jobs SET status='skipped',finished_at=$1,error_code='JOB_EXPIRED' WHERE id=$2",
        [now, job.id],
      );
      return {
        response: { send: false } as const,
        continuations: [] as string[],
      };
    }
    const report = await selectCurrentReport(client, job, now);
    if (!report) {
      await client.query(
        "UPDATE brownie_telegram_report_jobs SET status='skipped',finished_at=$1 WHERE id=$2",
        [now, job.id],
      );
      return {
        response: { send: false } as const,
        continuations: [] as string[],
      };
    }
    await persistOnceReceipts(
      client,
      { ...job, once_keys: report.onceKeys },
      now,
      'reserved',
    );
    const continuationIds: string[] = [];
    if (report.continuationItemKeys.length) {
      const maximum = (
        await client.query(
          'SELECT COALESCE(max(part),0) AS part FROM brownie_telegram_report_jobs WHERE family_id=$1 AND subject=$2 AND report_date=$3',
          [job.family_id, job.subject, job.report_date],
        )
      ).rows[0];
      let part = Number(maximum.part);
      for (const itemKeys of report.continuationItemKeys) {
        const id = randomUUID();
        part++;
        await client.query(
          "INSERT INTO brownie_telegram_report_jobs(id,family_id,subject,family_generation,telegram_linked_at,report_date,part,scheduled_for,status,item_keys,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9::jsonb,$10)",
          [
            id,
            job.family_id,
            job.subject,
            job.family_generation,
            job.telegram_linked_at,
            job.report_date,
            part,
            job.scheduled_for,
            JSON.stringify(itemKeys),
            now,
          ],
        );
        continuationIds.push(id);
      }
    }
    // Mark attempted before releasing the provider payload. A lost bridge response
    // sacrifices this report rather than risk an automatic duplicate Telegram send.
    await client.query(
      "UPDATE brownie_telegram_report_jobs SET status='attempted',attempt_id=$1,attempted_at=$2,item_keys=$3::jsonb,once_keys=$4::jsonb,retry_after=NULL WHERE id=$5",
      [
        event.attemptId,
        now,
        JSON.stringify(report.itemKeys),
        JSON.stringify(report.onceKeys),
        job.id,
      ],
    );
    return {
      response: {
        send: true,
        chatId: report.chatId,
        text: report.text,
      } as const,
      continuations: continuationIds,
    };
  });
  // Continuations are already durable. Publication is best effort here and the
  // hourly queued-job reconciliation retries without failing the authorized part.
  for (const id of claimed.continuations)
    try {
      await services.queueTelegramReport?.(id);
    } catch {
      // Retained as queued in PostgreSQL.
    }
  return claimed.response;
}

async function finishTelegramDelivery(
  database: Database,
  now: number,
  event: Extract<TelegramBridgeEvent, { action: 'telegram.finish-delivery' }>,
): Promise<{ ok: boolean }> {
  if (
    !boundedId(event.jobId) ||
    !boundedId(event.attemptId) ||
    (event.messageId !== undefined && !Number.isSafeInteger(event.messageId)) ||
    (event.errorCode !== undefined && !boundedId(event.errorCode, 100))
  )
    return { ok: false };
  return database.transaction(async (client) => {
    const candidate = (
      await client.query(
        'SELECT family_id,subject FROM brownie_telegram_report_jobs WHERE id=$1',
        [event.jobId],
      )
    ).rows[0];
    if (!candidate) return { ok: false };
    await client.query(
      'SELECT subject FROM brownie_accounts WHERE subject=$1 FOR UPDATE',
      [candidate.subject],
    );
    await client.query(
      'SELECT id FROM brownie_families WHERE id=$1 FOR UPDATE',
      [candidate.family_id],
    );
    const job = (
      await client.query(
        'SELECT * FROM brownie_telegram_report_jobs WHERE id=$1 FOR UPDATE',
        [event.jobId],
      )
    ).rows[0];
    if (!job || job.attempt_id !== event.attemptId) return { ok: false };
    if (job.status !== 'attempted') return { ok: true };
    if (event.outcome === 'retryable') {
      const seconds = Number.isFinite(event.retryAfterSeconds)
        ? Math.min(
            86400,
            Math.max(1, Math.ceil(Number(event.retryAfterSeconds))),
          )
        : 60;
      await client.query(
        "UPDATE brownie_telegram_report_jobs SET status='retryable',finished_at=$1,retry_after=$2,error_code=$3 WHERE id=$4",
        [now, now + seconds * 1000, event.errorCode ?? null, job.id],
      );
      await client.query(
        "DELETE FROM brownie_telegram_once_receipts WHERE job_id=$1 AND outcome='reserved'",
        [job.id],
      );
      return { ok: true };
    }
    await client.query(
      'UPDATE brownie_telegram_report_jobs SET status=$1,finished_at=$2,message_id=$3,error_code=$4 WHERE id=$5',
      [
        event.outcome,
        now,
        event.messageId === undefined ? null : String(event.messageId),
        event.errorCode ?? null,
        job.id,
      ],
    );
    if (event.outcome === 'accepted' || event.outcome === 'unknown') {
      await persistOnceReceipts(client, job, now, event.outcome);
    } else {
      await client.query(
        "DELETE FROM brownie_telegram_once_receipts WHERE job_id=$1 AND outcome='reserved'",
        [job.id],
      );
    }
    return { ok: true };
  });
}

import { randomUUID } from 'node:crypto';
import {
  effectiveReminderSettings,
  formatMoney,
  householdToday,
  selectTelegramReportItems,
  type DailyReportTime,
  type State,
  type TelegramReportItem,
} from '../domain';
import type { Database, SqlClient } from './database';
import { check } from './identity';

export interface TelegramReportPublisher {
  queueTelegramReport?: (jobId: string) => Promise<void>;
  clock?: () => number;
}

export function validateDailyReportTime(value: unknown): DailyReportTime {
  check(value && typeof value === 'object', 'VALIDATION_FAILED');
  const input = value as Record<string, unknown>;
  check(
    Number.isInteger(input.hour) &&
      Number(input.hour) >= 0 &&
      Number(input.hour) <= 23,
    'VALIDATION_FAILED',
  );
  check(
    typeof input.timeZone === 'string' && input.timeZone.length <= 100,
    'VALIDATION_FAILED',
  );
  try {
    new Intl.DateTimeFormat('en', { timeZone: input.timeZone }).format();
  } catch {
    check(false, 'VALIDATION_FAILED');
  }
  return { hour: Number(input.hour), timeZone: String(input.timeZone) };
}

export function familyReportTime(state: State): DailyReportTime {
  return (
    state.household.telegramReportTime ?? {
      hour: 9,
      timeZone: state.household.timezone,
    }
  );
}

function localParts(at: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)!.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
  };
}

function dateKey(parts: { year: number; month: number; day: number }) {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/** Returns the next whole UTC hour representing the selected local wall-clock hour. */
export function nextTelegramReportAt(
  spec: DailyReportTime,
  after: number,
): number {
  validateDailyReportTime(spec);
  const local = localParts(after, spec.timeZone);
  const localMidnight = Date.UTC(local.year, local.month - 1, local.day);
  for (let dayOffset = 0; dayOffset < 4; dayOffset++) {
    const targetDate = new Date(localMidnight + dayOffset * 86400000);
    const target = {
      year: targetDate.getUTCFullYear(),
      month: targetDate.getUTCMonth() + 1,
      day: targetDate.getUTCDate(),
    };
    const exact: number[] = [];
    const later: number[] = [];
    const center = Date.UTC(
      target.year,
      target.month - 1,
      target.day,
      spec.hour,
    );
    for (let delta = -15; delta <= 15; delta++) {
      const candidate = center + delta * 3600000;
      const candidateLocal = localParts(candidate, spec.timeZone);
      if (dateKey(candidateLocal) !== dateKey(target)) continue;
      if (candidateLocal.hour === spec.hour) exact.push(candidate);
      else if (candidateLocal.hour > spec.hour) later.push(candidate);
    }
    if (exact.length) {
      const first = Math.min(...exact);
      if (first > after) return first;
      continue;
    }
    // A local hour may not exist on the spring DST transition. Run at the first later hour.
    if (later.length) {
      const first = Math.min(...later);
      if (first > after) return first;
    }
  }
  throw new Error('Unable to calculate the next Telegram report hour');
}

export function telegramReportDate(at: number, timeZone: string): string {
  return dateKey(localParts(at, timeZone));
}

export async function syncMemberTelegramSchedule(
  client: SqlClient,
  familyId: string,
  state: State,
  now: number,
  options: { subject?: string; inheritingOnly?: boolean } = {},
) {
  const rows = (
    await client.query(
      'SELECT subject,telegram_report_time FROM brownie_memberships WHERE family_id=$1 AND ($2::text IS NULL OR subject=$2) AND (NOT $3::boolean OR telegram_report_time IS NULL)',
      [familyId, options.subject ?? null, options.inheritingOnly ?? false],
    )
  ).rows;
  for (const row of rows) {
    const spec = row.telegram_report_time
      ? validateDailyReportTime(row.telegram_report_time)
      : familyReportTime(state);
    await client.query(
      'UPDATE brownie_memberships SET next_telegram_report_at=$1 WHERE family_id=$2 AND subject=$3',
      [nextTelegramReportAt(spec, now), familyId, row.subject],
    );
  }
}

/** Hourly bounded scheduler. Each family/member/local-date job has one durable SQL identity. */
export async function scheduleTelegramReports(
  database: Database,
  services: TelegramReportPublisher,
) {
  check(services.queueTelegramReport, 'TELEGRAM_QUEUE_NOT_CONFIGURED', 503);
  const now = services.clock?.() ?? Date.now();
  const results: Array<{ familyId: string; subject: string; status: string }> =
    [];
  const publish = new Set<string>();
  // Initialize legacy memberships with the same family -> membership lock order
  // used by API writes. A second scheduler rechecks NULL after it acquires locks.
  for (let batch = 0; batch < 10; batch++) {
    const missing = await database.transaction(
      async (client) =>
        (
          await client.query(
            'SELECT m.subject,m.family_id FROM brownie_memberships m JOIN brownie_families f ON f.id=m.family_id WHERE m.next_telegram_report_at IS NULL AND f.deleted_at IS NULL ORDER BY m.subject LIMIT 100',
          )
        ).rows,
    );
    for (const item of missing)
      await database.transaction(async (client) => {
        await client.query(
          'SELECT id FROM brownie_families WHERE id=$1 FOR UPDATE',
          [item.family_id],
        );
        const row = (
          await client.query(
            'SELECT m.telegram_report_time,f.state FROM brownie_memberships m JOIN brownie_families f ON f.id=m.family_id WHERE m.subject=$1 AND m.family_id=$2 AND m.next_telegram_report_at IS NULL FOR UPDATE OF m',
            [item.subject, item.family_id],
          )
        ).rows[0];
        if (!row) return;
        const state = row.state as State;
        const spec = row.telegram_report_time
          ? validateDailyReportTime(row.telegram_report_time)
          : familyReportTime(state);
        await client.query(
          'UPDATE brownie_memberships SET next_telegram_report_at=$1 WHERE subject=$2 AND family_id=$3 AND next_telegram_report_at IS NULL',
          [
            nextTelegramReportAt(spec, now - 3600001),
            item.subject,
            item.family_id,
          ],
        );
      });
    if (missing.length < 100) break;
  }
  // Drain bounded batches so the hourly event does not strand households behind the first page.
  for (let batch = 0; batch < 10; batch++) {
    const work = await database.transaction(async (client) => {
      const due = (
        await client.query(
          'SELECT subject,family_id FROM brownie_memberships WHERE next_telegram_report_at<=$1 ORDER BY next_telegram_report_at,subject LIMIT 100',
          [now],
        )
      ).rows;
      const created: string[] = [];
      for (const item of due) {
        await client.query(
          'SELECT id FROM brownie_families WHERE id=$1 FOR UPDATE',
          [item.family_id],
        );
        const row = (
          await client.query(
            'SELECT m.*,f.state,f.generation,f.deleted_at,l.subject AS linked_subject,l.linked_at AS telegram_linked_at FROM brownie_memberships m JOIN brownie_families f ON f.id=m.family_id LEFT JOIN brownie_telegram_links l ON l.subject=m.subject AND l.family_id=m.family_id WHERE m.subject=$1 AND m.family_id=$2 FOR UPDATE OF m',
            [item.subject, item.family_id],
          )
        ).rows[0];
        if (!row || row.deleted_at !== null) continue;
        const state = row.state as State;
        const spec = row.telegram_report_time
          ? validateDailyReportTime(row.telegram_report_time)
          : familyReportTime(state);
        const scheduledFor = Number(row.next_telegram_report_at);
        if (scheduledFor > now) continue;
        let next = nextTelegramReportAt(spec, scheduledFor);
        while (next <= now) next = nextTelegramReportAt(spec, next);
        await client.query(
          'UPDATE brownie_memberships SET next_telegram_report_at=$1 WHERE subject=$2 AND family_id=$3',
          [next, row.subject, row.family_id],
        );
        let status = scheduledFor < now - 24 * 3600000 ? 'missed' : 'unlinked';
        if (row.linked_subject && scheduledFor >= now - 24 * 3600000) {
          const id = randomUUID();
          const inserted = await client.query(
            "INSERT INTO brownie_telegram_report_jobs(id,family_id,subject,family_generation,telegram_linked_at,report_date,scheduled_for,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'queued',$8) ON CONFLICT(family_id,subject,report_date,part) DO NOTHING RETURNING id",
            [
              id,
              row.family_id,
              row.subject,
              row.generation,
              row.telegram_linked_at,
              telegramReportDate(scheduledFor, spec.timeZone),
              scheduledFor,
              now,
            ],
          );
          status = inserted.rows.length ? 'queued' : 'duplicate';
          if (inserted.rows.length) created.push(id);
        }
        results.push({ familyId: row.family_id, subject: row.subject, status });
      }
      return { more: due.length === 100, created };
    });
    work.created.forEach((id) => publish.add(id));
    if (!work.more) break;
  }

  // A payload has crossed the trust boundary once begin-delivery returns it. If
  // the worker disappears, classify it as ambiguous instead of sending it twice.
  const stale = await database.transaction(
    async (client) =>
      (
        await client.query(
          "SELECT id,family_id FROM brownie_telegram_report_jobs WHERE status='attempted' AND attempted_at<=$1 ORDER BY attempted_at,id LIMIT 100",
          [now - 15 * 60000],
        )
      ).rows,
  );
  for (const candidate of stale)
    await database.transaction(async (client) => {
      await client.query(
        'SELECT id FROM brownie_families WHERE id=$1 FOR UPDATE',
        [candidate.family_id],
      );
      const job = (
        await client.query(
          "SELECT * FROM brownie_telegram_report_jobs WHERE id=$1 AND status='attempted' AND attempted_at<=$2 FOR UPDATE",
          [candidate.id, now - 15 * 60000],
        )
      ).rows[0];
      if (!job) return;
      await client.query(
        "UPDATE brownie_telegram_report_jobs SET status='unknown',finished_at=$1,error_code='WORKER_COMPLETION_MISSING' WHERE id=$2",
        [now, job.id],
      );
      await persistOnceReceipts(client, job, now, 'unknown');
    });

  const retriesQueued = await database.transaction(async (client) => {
    const rows = (
      await client.query(
        "UPDATE brownie_telegram_report_jobs SET status='queued',retry_after=NULL WHERE id IN (SELECT id FROM brownie_telegram_report_jobs WHERE status='retryable' AND retry_after<=$1 ORDER BY retry_after,id LIMIT 100 FOR UPDATE SKIP LOCKED) RETURNING id",
        [now],
      )
    ).rows;
    rows.forEach((row) => publish.add(row.id));
    return rows.length;
  });
  // Reconcile every committed queued job. Duplicate object notifications are safe:
  // begin-delivery atomically grants at most one attempt.
  const queued = await database.transaction(
    async (client) =>
      (
        await client.query(
          "SELECT id FROM brownie_telegram_report_jobs WHERE status='queued' ORDER BY created_at,id LIMIT 1000",
        )
      ).rows,
  );
  queued.forEach((row) => publish.add(row.id));
  let publishFailures = 0;
  for (const id of publish)
    try {
      await services.queueTelegramReport!(id);
    } catch {
      // SQL remains the durable outbox; the next hourly invocation reconciles it.
      publishFailures++;
    }
  return { results, retriesQueued, publishFailures };
}

export async function persistOnceReceipts(
  client: SqlClient,
  job: any,
  at: number,
  outcome: 'reserved' | 'accepted' | 'unknown',
) {
  const onceKeys = Array.isArray(job.once_keys) ? job.once_keys : [];
  for (const value of onceKeys) {
    if (typeof value !== 'string') continue;
    const separator = value.indexOf(':');
    if (separator <= 0 || separator === value.length - 1) continue;
    await client.query(
      'INSERT INTO brownie_telegram_once_receipts(family_id,subject,obligation_id,period_id,job_id,delivered_at,outcome) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(family_id,subject,obligation_id,period_id) DO UPDATE SET delivered_at=EXCLUDED.delivered_at,outcome=EXCLUDED.outcome WHERE brownie_telegram_once_receipts.job_id=EXCLUDED.job_id',
      [
        job.family_id,
        job.subject,
        value.slice(0, separator),
        value.slice(separator + 1),
        job.id,
        at,
        outcome,
      ],
    );
  }
}

function formatDate(date: string) {
  const [year, month, day] = date.split('-');
  return `${day}.${month}.${year}`;
}

function formatItem(item: TelegramReportItem) {
  const amount =
    item.amount === undefined
      ? 'сумма уточняется'
      : `${formatMoney(item.amount, item.currency, 'ru')}${
          item.amountState === 'estimated' ? ' (оценка)' : ''
        }`;
  const credit = item.creditNeedsReview
    ? ' (есть нераспределённый кредит; остаток требует проверки)'
    : '';
  return `• ${item.title} — ${amount}${credit}, ${formatDate(item.dueDate)}`;
}

function renderTelegramReport(items: TelegramReportItem[]): string {
  const headings: Array<[TelegramReportItem['section'], string]> = [
    ['overdue', '⚠️ Просрочено:'],
    ['due', '📅 К оплате:'],
    ['automatic', '🔄 Автоплатеж:'],
  ];
  return headings
    .map(([section, heading]) => {
      const rows = items.filter((item) => item.section === section);
      return rows.length
        ? `${heading}\n${rows.map(formatItem).join('\n')}`
        : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

export function splitTelegramReport(
  items: TelegramReportItem[],
): TelegramReportItem[][] {
  const parts: TelegramReportItem[][] = [];
  let current: TelegramReportItem[] = [];
  for (const item of items) {
    const candidate = [...current, item];
    if (renderTelegramReport(candidate).length <= 4096) {
      current = candidate;
      continue;
    }
    if (current.length) parts.push(current);
    current = [item];
    check(
      renderTelegramReport(current).length <= 4096,
      'TELEGRAM_REPORT_ITEM_TOO_LARGE',
    );
  }
  if (current.length) parts.push(current);
  return parts;
}

export function formatTelegramReport(items: TelegramReportItem[]): string {
  return renderTelegramReport(items);
}

export async function selectCurrentReport(
  client: SqlClient,
  job: any,
  now: number,
): Promise<
  | {
      chatId: string;
      text: string;
      itemKeys: string[];
      onceKeys: string[];
      continuationItemKeys: string[][];
    }
  | undefined
> {
  const current = (
    await client.query(
      'SELECT j.*,f.state,m.person_id,l.chat_id FROM brownie_telegram_report_jobs j JOIN brownie_families f ON f.id=j.family_id AND f.generation=j.family_generation JOIN brownie_memberships m ON m.subject=j.subject AND m.family_id=j.family_id JOIN brownie_telegram_links l ON l.subject=j.subject AND l.family_id=j.family_id AND l.linked_at=j.telegram_linked_at WHERE j.id=$1 AND f.deleted_at IS NULL',
      [job.id],
    )
  ).rows[0];
  if (!current) return undefined;
  const receiptRows = (
    await client.query(
      'SELECT obligation_id,period_id FROM brownie_telegram_once_receipts WHERE family_id=$1 AND subject=$2',
      [current.family_id, current.subject],
    )
  ).rows;
  const received = new Set(
    receiptRows.map((row) => `${row.obligation_id}:${row.period_id}`),
  );
  const state = current.state as State;
  let items = selectTelegramReportItems(state, {
    today: householdToday(state, new Date(now)),
    recipientPersonId: current.person_id,
    onceReminderPeriodIds: received,
  });
  if (Array.isArray(current.item_keys)) {
    const allowed = new Set(current.item_keys);
    items = items.filter((item) =>
      allowed.has(`${item.obligationId}:${item.periodId}`),
    );
  }
  if (!items.length) return undefined;
  const parts = splitTelegramReport(items);
  const included = parts[0];
  const obligations = new Map(
    state.obligations.map((value) => [value.id, value]),
  );
  const onceKeys = included
    .filter((item) => {
      const obligation = obligations.get(item.obligationId);
      return (
        obligation &&
        effectiveReminderSettings(state, obligation).repeat === 'once'
      );
    })
    .map((item) => `${item.obligationId}:${item.periodId}`);
  const keys = (part: TelegramReportItem[]) =>
    part.map((item) => `${item.obligationId}:${item.periodId}`);
  return {
    chatId: current.chat_id,
    text: renderTelegramReport(included),
    itemKeys: keys(included),
    onceKeys,
    continuationItemKeys: parts.slice(1).map(keys),
  };
}

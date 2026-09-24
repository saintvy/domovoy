import { randomUUID, timingSafeEqual } from 'node:crypto';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { normalizeAppLocale } from '../shared/locale';

type DeliveryOutcome = 'accepted' | 'retryable' | 'failed' | 'unknown';
interface WorkerDependencies {
  secrets(): Promise<{ token: string; webhookSecret: string }>;
  bridge(event: Record<string, unknown>): Promise<any>;
  remove(key: string): Promise<void>;
  fetch: typeof fetch;
  bucket: string;
}
const response = (statusCode: number, body: unknown = { ok: true }) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});
const linkReply = {
  ru: {
    connected:
      '✅ Telegram привязан к Домовому. Настройки отчетов доступны в приложении.',
    invalid:
      'Ссылка недействительна или истекла. Создайте новую ссылку в настройках Домового.',
  },
  en: {
    connected:
      '✅ Telegram is connected to Domovoy. Report settings are available in the app.',
    invalid:
      'This link is invalid or has expired. Create a new link in Domovoy settings.',
  },
} as const;

/** Dependency injection keeps failure tests independent of credentials and live chats. */
export function createTelegramWorker(deps: WorkerDependencies) {
  async function deliver(jobId: string, key: string) {
    // Resolve configuration before claiming; a missing parameter must not consume a report.
    const { token } = await deps.secrets();
    const attemptId = randomUUID();
    const delivery = await deps.bridge({
      action: 'telegram.begin-delivery',
      jobId,
      attemptId,
    });
    if (!delivery?.send) return;
    let outcome: DeliveryOutcome = 'unknown';
    let messageId: number | undefined;
    let retryAfterSeconds: number | undefined;
    let errorCode = 'AMBIGUOUS_PROVIDER_RESULT';
    if (
      typeof delivery.chatId !== 'string' ||
      typeof delivery.text !== 'string' ||
      !delivery.text.length ||
      delivery.text.length > 4096
    ) {
      outcome = 'failed';
      errorCode = 'INVALID_DELIVERY';
    } else {
      try {
        const result = await deps.fetch(
          `https://api.telegram.org/bot${token}/sendMessage`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              chat_id: delivery.chatId,
              text: delivery.text,
              link_preview_options: { is_disabled: true },
            }),
            signal: AbortSignal.timeout(10000),
          },
        );
        const body = (await result.json()) as any;
        if (
          result.ok &&
          body.ok === true &&
          Number.isSafeInteger(body.result?.message_id)
        ) {
          outcome = 'accepted';
          messageId = body.result.message_id;
          errorCode = '';
        } else if (body.ok === false && body.error_code === 429) {
          outcome = 'retryable';
          retryAfterSeconds = Math.min(
            86400,
            Math.max(1, Number(body.parameters?.retry_after) || 60),
          );
          errorCode = 'TELEGRAM_THROTTLED';
        } else if (
          body.ok === false &&
          [400, 401, 403, 404].includes(body.error_code)
        ) {
          outcome = 'failed';
          errorCode = `TELEGRAM_${body.error_code}`;
        }
      } catch {
        // Never log fetch errors: their message can contain the bot-token URL.
      }
    }
    // Retrying the acknowledgement is safe; retrying sendMessage after a timeout is not.
    let recorded = false;
    for (let retry = 0; retry < 3 && !recorded; retry++) {
      try {
        const acknowledgement = await deps.bridge({
          action: 'telegram.finish-delivery',
          jobId,
          attemptId,
          outcome,
          messageId,
          retryAfterSeconds,
          errorCode: errorCode || undefined,
        });
        if (acknowledgement?.ok !== true)
          throw new Error('TELEGRAM_ACKNOWLEDGEMENT_REJECTED');
        recorded = true;
      } catch {
        /* A repeated acknowledgement carries the same attempt identity. */
      }
    }
    if (!recorded) throw new Error('TELEGRAM_ACKNOWLEDGEMENT_FAILED');
    if (outcome !== 'retryable') await deps.remove(key);
  }

  return async (event: any) => {
    if (event?.version === '2.0' && event.requestContext?.http) {
      if (
        event.requestContext.http.method !== 'POST' ||
        event.rawPath !== '/api/telegram/webhook'
      )
        return response(404);
      const headers = Object.fromEntries(
        Object.entries(event.headers ?? {}).map(([key, value]) => [
          key.toLowerCase(),
          value,
        ]),
      );
      let secret: string;
      try {
        secret = (await deps.secrets()).webhookSecret;
      } catch {
        return response(503);
      }
      const provided = headers['x-telegram-bot-api-secret-token'];
      if (
        typeof provided !== 'string' ||
        Buffer.byteLength(provided) !== Buffer.byteLength(secret) ||
        !timingSafeEqual(Buffer.from(provided), Buffer.from(secret))
      )
        return response(403);
      if (typeof event.body !== 'string' || event.body.length > 90000)
        return response(413);
      const raw = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : event.body;
      if (Buffer.byteLength(raw) > 65536) return response(413);
      let update: any;
      try {
        update = JSON.parse(raw);
      } catch {
        return response(400);
      }
      const message = update?.message;
      const match =
        typeof message?.text === 'string'
          ? /^\/start(?:@domovoy_reminder_bot)? ([A-Za-z0-9_-]{43})$/.exec(
              message.text.trim(),
            )
          : null;
      if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0)
        return response(400);
      if (
        !match ||
        message?.chat?.type !== 'private' ||
        message?.from?.is_bot ||
        !Number.isSafeInteger(message?.from?.id) ||
        message.from.id <= 0 ||
        message.from.id !== message.chat.id
      )
        return response(200);
      try {
        const result = await deps.bridge({
          action: 'telegram.consume-link',
          updateId: update.update_id,
          token: match[1],
          telegramUserId: String(message.from.id),
          chatId: String(message.chat.id),
          username:
            typeof message.from.username === 'string'
              ? message.from.username
              : undefined,
        });
        const locale = normalizeAppLocale(
          result?.ok ? result.locale : message.from.language_code,
          normalizeAppLocale(message.from.language_code, 'en'),
        );
        return response(200, {
          method: 'sendMessage',
          chat_id: String(message.chat.id),
          text: result?.ok
            ? linkReply[locale].connected
            : linkReply[locale].invalid,
        });
      } catch {
        return response(503);
      }
    }
    for (const record of event?.Records ?? []) {
      if (
        record.s3?.bucket?.name !== deps.bucket ||
        typeof record.s3?.object?.key !== 'string'
      )
        continue;
      let key: string;
      try {
        key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
      } catch {
        continue;
      }
      const match = /^telegram-outbox\/([a-f0-9-]{36})\.json$/.exec(key);
      if (match) await deliver(match[1], key);
    }
    return { ok: true };
  };
}

const ssm = new SSMClient({ maxAttempts: 2 });
const lambda = new LambdaClient({ maxAttempts: 2 });
const s3 = new S3Client({ maxAttempts: 2 });
let cached:
  { token: string; webhookSecret: string; expiresAt: number } | undefined;
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error('TELEGRAM_CONFIGURATION_MISSING');
  return value;
}
const worker = createTelegramWorker({
  bucket: process.env.SERVICES_BUCKET ?? '',
  fetch: (...args) => fetch(...args),
  async secrets() {
    if (cached && cached.expiresAt > Date.now()) return cached;
    const values = await Promise.all(
      ['TELEGRAM_BOT_TOKEN_PARAMETER', 'TELEGRAM_WEBHOOK_SECRET_PARAMETER'].map(
        async (name) =>
          (
            await ssm.send(
              new GetParameterCommand({
                Name: required(name),
                WithDecryption: true,
              }),
            )
          ).Parameter?.Value,
      ),
    );
    if (!values[0] || !values[1])
      throw new Error('TELEGRAM_CONFIGURATION_MISSING');
    cached = {
      token: values[0],
      webhookSecret: values[1],
      expiresAt: Date.now() + 300000,
    };
    return cached;
  },
  async bridge(event) {
    const result = await lambda.send(
      new InvokeCommand({
        FunctionName: required('TELEGRAM_BRIDGE_FUNCTION'),
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify(event)),
      }),
    );
    if (result.FunctionError || !result.Payload)
      throw new Error('TELEGRAM_BRIDGE_UNAVAILABLE');
    return JSON.parse(Buffer.from(result.Payload).toString('utf8'));
  },
  async remove(key) {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: required('SERVICES_BUCKET'),
        Key: key,
      }),
    );
  },
});
export async function handler(event: unknown) {
  try {
    return await worker(event);
  } catch {
    throw new Error('TELEGRAM_WORKER_FAILED');
  }
}

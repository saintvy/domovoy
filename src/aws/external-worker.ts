import { createHash } from 'node:crypto';
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { parseEcbHistory } from './exchange-rates';
import type { InvitationMessage } from './families';
import {
  invitationEmailLocale,
  renderInvitationEmail,
} from './invitation-email';

const s3 = new S3Client({ maxAttempts: 2 }),
  ses = new SESv2Client({ maxAttempts: 2 });
const bucket = () => {
  if (!process.env.SERVICES_BUCKET) throw new Error('SERVICES_BUCKET_REQUIRED');
  return process.env.SERVICES_BUCKET;
};
async function deliver(key: string) {
  if (!/^outbox\/[a-f0-9-]{36}\.json$/.test(key)) return;
  let object;
  try {
    object = await s3.send(
      new GetObjectCommand({ Bucket: bucket(), Key: key }),
    );
  } catch (error) {
    if ((error as { name?: string }).name === 'NoSuchKey') return;
    throw error;
  }
  const message = JSON.parse(
    await object.Body!.transformToString(),
  ) as InvitationMessage;
  if (message.expiresAt < Date.now()) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
    return;
  }
  const url = new URL(message.url);
  if (
    url.origin !== process.env.APP_ORIGIN ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(message.email) ||
    key !== `outbox/${message.id}.json`
  )
    throw new Error('INVALID_INVITATION');
  if (!process.env.INVITATION_SENDER)
    throw new Error('INVITATION_SENDER_REQUIRED');
  // Messages queued before locale preferences existed retain the Russian copy.
  const locale = invitationEmailLocale(message.locale);
  const email = renderInvitationEmail(message, locale);
  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: process.env.INVITATION_SENDER,
      Destination: { ToAddresses: [message.email] },
      Content: {
        Simple: {
          Subject: { Data: email.subject, Charset: 'UTF-8' },
          Body: {
            Text: {
              Data: email.text,
              Charset: 'UTF-8',
            },
            Html: { Data: email.html, Charset: 'UTF-8' },
          },
        },
      },
    }),
  );
  // A duplicate after a crash can resend the same one-use link, never create extra membership.
  await s3.send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}
async function refreshRates() {
  const response = await fetch(
    'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml',
    { signal: AbortSignal.timeout(25000) },
  );
  if (!response.ok) throw new Error('ECB_UNAVAILABLE');
  const xml = await response.text();
  if (xml.length > 30 * 1024 * 1024) throw new Error('ECB_DATA_TOO_LARGE');
  const years = parseEcbHistory(xml);
  let changed = 0;
  for (const [year, days] of years) {
    const body = JSON.stringify(days),
      checksum = createHash('sha256').update(body).digest('hex');
    let old: string | undefined;
    try {
      const prior = await s3.send(
        new HeadObjectCommand({ Bucket: bucket(), Key: `rates/${year}.json` }),
      );
      old = prior.Metadata?.sha256;
    } catch (error) {
      if (
        !['NoSuchKey', 'NotFound'].includes(
          (error as { name?: string }).name ?? '',
        )
      )
        throw error;
    }
    if (old === checksum) continue;
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: `rates/${year}.json`,
        Body: body,
        ContentType: 'application/json',
        ServerSideEncryption: 'AES256',
        Metadata: { sha256: checksum },
      }),
    );
    changed++;
  }
  return { years: years.size, changed };
}
/** Internet-enabled Lambda, outside the RDS VPC. S3 notifications and EventBridge only; no public URL. */
export async function handler(event: {
  action?: string;
  Records?: Array<{
    s3?: { bucket?: { name?: string }; object?: { key?: string } };
  }>;
}) {
  if (event.action === 'refresh-rates') return refreshRates();
  if (event.action === 'retry-invitations') {
    const queued = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket(),
        Prefix: 'outbox/',
        MaxKeys: 20,
      }),
    );
    let sent = 0,
      failed = 0;
    for (const object of queued.Contents ?? []) {
      if (!object.Key) continue;
      try {
        await deliver(object.Key);
        sent++;
      } catch {
        failed++;
      }
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
    return { sent, failed };
  }
  for (const record of event.Records ?? [])
    if (record.s3?.bucket?.name === bucket() && record.s3.object?.key)
      await deliver(
        decodeURIComponent(record.s3.object.key.replace(/\+/g, ' ')),
      );
  return { ok: true };
}

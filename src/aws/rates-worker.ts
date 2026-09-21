import { createHash } from 'node:crypto';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { parseEcbHistory, type RateYear } from './exchange-rates';

const s3 = new S3Client({ maxAttempts: 2 });
/** Separate from mail delivery so the SES sandbox throttle cannot delay a payment's FX lookup. */
export async function refreshEcb(
  bucket: string,
  full = false,
  now = Date.now(),
) {
  const endpoint = full ? 'eurofxref-hist.xml' : 'eurofxref-hist-90d.xml';
  const response = await fetch(
    'https://www.ecb.europa.eu/stats/eurofxref/' + endpoint,
    { signal: AbortSignal.timeout(12000) },
  );
  if (!response.ok) throw new Error('EXCHANGE_SOURCE_UNAVAILABLE');
  const xml = await response.text();
  if (Buffer.byteLength(xml) > 30 * 1024 * 1024)
    throw new Error('ECB_DATA_TOO_LARGE');
  const years = parseEcbHistory(xml);
  let latestDate = '';
  for (const [year, incoming] of years) {
    let existing: RateYear = [];
    if (!full) {
      try {
        const old = await s3.send(
          new GetObjectCommand({ Bucket: bucket, Key: `rates/${year}.json` }),
        );
        existing = JSON.parse(await old.Body!.transformToString());
      } catch (error) {
        if ((error as Error).name !== 'NoSuchKey') throw error;
      }
    }
    const days = [
      ...new Map(
        [...existing, ...incoming].map((day) => [day.date, day]),
      ).values(),
    ].sort((a, b) => b.date.localeCompare(a.date));
    latestDate = [latestDate, days[0]?.date ?? ''].sort().at(-1)!;
    const body = JSON.stringify(days);
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `rates/${year}.json`,
        Body: body,
        ContentType: 'application/json',
        ServerSideEncryption: 'AES256',
        Metadata: { sha256: createHash('sha256').update(body).digest('hex') },
      }),
    );
  }
  const status = { checkedAt: now, full, latestDate, source: 'ECB' };
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: 'rates/status.json',
      Body: JSON.stringify(status),
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256',
    }),
  );
  return status;
}

export async function handler(event: {
  action?: string;
  Records?: Array<{
    s3?: { bucket?: { name?: string }; object?: { key?: string } };
  }>;
}) {
  const bucket = process.env.SERVICES_BUCKET;
  if (!bucket) throw new Error('SERVICES_BUCKET_REQUIRED');
  if (event.action === 'refresh-rates') return refreshEcb(bucket, true);
  for (const record of event.Records ?? []) {
    const key = decodeURIComponent(record.s3?.object?.key ?? '');
    if (
      record.s3?.bucket?.name !== bucket ||
      !/^rates-refresh\/(current|history)\.json$/.test(key)
    )
      continue;
    let request: { requestedAt: number; full: boolean };
    try {
      const object = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      request = JSON.parse(await object.Body!.transformToString());
    } catch (error) {
      if ((error as Error).name === 'NoSuchKey') continue;
      throw error;
    }
    if (
      !Number.isFinite(request.requestedAt) ||
      typeof request.full !== 'boolean'
    )
      throw new Error('INVALID_RATE_REQUEST');
    let current: { checkedAt: number; full: boolean } | undefined;
    try {
      const object = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: 'rates/status.json' }),
      );
      current = JSON.parse(await object.Body!.transformToString());
    } catch (error) {
      if ((error as Error).name !== 'NoSuchKey') throw error;
    }
    // Duplicate S3 events may arrive after a successful refresh.
    if (
      !current ||
      current.checkedAt < request.requestedAt ||
      (request.full && !current.full)
    )
      await refreshEcb(bucket, request.full);
    // Keep the tiny trigger object: deleting a fixed key could erase a newer request.
  }
  return { ok: true };
}

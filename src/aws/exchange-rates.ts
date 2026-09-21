import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  requiredExchangeRates,
  type Command,
  type ExchangeRate,
  type State,
} from '../domain';
import { ApiError } from './identity';

export interface RateDay {
  date: string;
  rates: Record<string, string>;
}
export type RateYear = RateDay[];
/** Parse only ECB's small fixed vocabulary; no XML entities, scripts or network expansion. */
export function parseEcbHistory(xml: string): Map<string, RateYear> {
  const years = new Map<string, RateYear>();
  for (const match of xml.matchAll(
    /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]\s*>([\s\S]*?)<\/Cube>/g,
  )) {
    const day: RateDay = { date: match[1], rates: { EUR: '1' } };
    for (const rate of match[2].matchAll(
      /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"](\d+(?:\.\d+)?)['"]\s*\/>/g,
    ))
      day.rates[rate[1]] = rate[2];
    if (Object.keys(day.rates).length > 1) {
      const year = day.date.slice(0, 4);
      const list = years.get(year) ?? [];
      list.push(day);
      years.set(year, list);
    }
  }
  if (years.size < 1) throw new Error('ECB_DATA_INVALID');
  for (const days of years.values())
    days.sort((a, b) => b.date.localeCompare(a.date));
  return years;
}
function fraction(value: string) {
  const [a, b = ''] = value.split('.');
  return [BigInt(a + b), 10n ** BigInt(b.length)] as const;
}
/** ECB lists foreign major units per EUR. Keep twelve decimal places without binary floating-point rounding. */
export function crossRate(from: string, to: string) {
  const [a, b] = fraction(from),
    [c, d] = fraction(to);
  const scale = 10n ** 12n,
    denominator = d * a;
  const result = (c * b * scale + denominator / 2n) / denominator;
  if (result <= 0n) throw new Error('ECB_RATE_INVALID');
  return `${result / scale}.${String(result % scale).padStart(12, '0')}`;
}
export function quoteFromDays(
  days: RateYear,
  request: { from: string; to: string; date: string },
  today: string,
): ExchangeRate {
  const date = request.date < today ? request.date : today;
  const day = days.find(
    (day) =>
      day.date <= date && day.rates[request.from] && day.rates[request.to],
  );
  // An obsolete discontinued currency (e.g. RUB after 2022) must never appear as a current rate.
  if (!day || Date.parse(date) - Date.parse(day.date) > 10 * 86400000)
    throw new ApiError(
      'EXCHANGE_RATE_REQUIRED',
      409,
      `Автоматический источник ECB не публикует курс ${request.from}/${request.to} на ${request.date}. Операция не сохранена.`,
    );
  return {
    ...request,
    rate: crossRate(day.rates[request.from], day.rates[request.to]),
    source: `ECB (${day.date})`,
  };
}
export class EcbRates {
  private cache = new Map<string, { at: number; days: RateYear }>();
  constructor(
    private loadYear: (year: string) => Promise<RateYear>,
    private clock = Date.now,
    private beforeQuotes?: (
      requests: Array<{ from: string; to: string; date: string }>,
    ) => Promise<boolean>,
  ) {}
  private async year(year: string): Promise<RateYear> {
    let cached = this.cache.get(year);
    if (!cached || this.clock() - cached.at > 3600000) {
      cached = { at: this.clock(), days: await this.loadYear(year) };
      this.cache.set(year, cached);
    }
    return cached.days;
  }
  async quotes(
    state: State,
    commands: Command[],
    overrides: ExchangeRate[] = [],
  ): Promise<ExchangeRate[]> {
    const requests = requiredExchangeRates(state, commands),
      today = new Date(this.clock()).toISOString().slice(0, 10);
    if (requests.length && (await this.beforeQuotes?.(requests)))
      this.cache.clear();
    const result: ExchangeRate[] = [];
    for (const request of requests) {
      const manual = overrides.find(
        (q) =>
          q.from === request.from &&
          q.to === request.to &&
          q.date === request.date,
      );
      if (manual) {
        result.push(manual);
        continue;
      }
      const target = request.date < today ? request.date : today,
        year = target.slice(0, 4);
      const days = await this.year(year);
      // The preceding year is looked up even if this year's cache was first populated in September.
      const previous =
        target.slice(5, 7) === '01'
          ? await this.year(String(Number(year) - 1))
          : [];
      result.push(
        quoteFromDays(
          [...days, ...previous].sort((a, b) => b.date.localeCompare(a.date)),
          request,
          today,
        ),
      );
    }
    return result;
  }
}
export function s3Rates(bucket: string, s3 = new S3Client({ maxAttempts: 2 })) {
  const freshness = new S3RateFreshness(bucket, s3);
  return new EcbRates(
    async (year) => {
      if (Number(year) < 1999 || Number(year) > new Date().getUTCFullYear())
        return [];
      const read = async () => {
        const object = await s3.send(
          new GetObjectCommand({ Bucket: bucket, Key: `rates/${year}.json` }),
          { abortSignal: AbortSignal.timeout(3000) },
        );
        return JSON.parse(await object.Body!.transformToString()) as RateYear;
      };
      try {
        return await read();
      } catch (error) {
        if ((error as Error).name !== 'NoSuchKey')
          throw new ApiError(
            'EXCHANGE_SOURCE_UNAVAILABLE',
            503,
            'Источник курсов временно недоступен. Повторите операцию позже.',
          );
        await freshness.refresh(true);
        return read();
      }
    },
    Date.now,
    async (requests) => {
      const recent = new Date(Date.now() - 10 * 86400000)
        .toISOString()
        .slice(0, 10);
      return requests.some((request) => request.date >= recent)
        ? freshness.ensure()
        : false;
    },
  );
}

/** S3 is the private VPC's existing gateway. No NAT or paid interface endpoint is needed.
 * A bounded refresh request wakes the separate internet-enabled rate worker. */
export class S3RateFreshness {
  private observed = 0;
  private readAt = 0;
  private pending: Promise<number> | undefined;
  constructor(
    private bucket: string,
    private s3: Pick<S3Client, 'send'>,
    private clock = Date.now,
    private pause = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ) {}
  private async status(): Promise<
    { checkedAt: number; full: boolean } | undefined
  > {
    try {
      const object = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: 'rates/status.json' }),
        { abortSignal: AbortSignal.timeout(2000) },
      );
      return JSON.parse(await object.Body!.transformToString());
    } catch (error) {
      if ((error as Error).name === 'NoSuchKey') return undefined;
      throw error;
    }
  }
  async ensure(): Promise<boolean> {
    if (this.observed && this.clock() - this.readAt < 60000) return false;
    const status = await this.status();
    const stamp =
      status && this.clock() - status.checkedAt < 15 * 60000
        ? status.checkedAt
        : await this.refresh(false);
    const changed = stamp !== this.observed;
    this.observed = stamp;
    this.readAt = this.clock();
    return changed;
  }
  async refresh(full: boolean): Promise<number> {
    if (this.pending) return this.pending;
    const pending = (async () => {
      const requestedAt = this.clock(),
        deadline = requestedAt + 12000;
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: `rates-refresh/${full ? 'history' : 'current'}.json`,
          Body: JSON.stringify({ requestedAt, full }),
          ContentType: 'application/json',
          ServerSideEncryption: 'AES256',
        }),
        { abortSignal: AbortSignal.timeout(2000) },
      );
      while (this.clock() < deadline) {
        await this.pause(500);
        const status = await this.status();
        if (status && status.checkedAt >= requestedAt && (!full || status.full))
          return status.checkedAt;
      }
      throw new ApiError(
        'EXCHANGE_SOURCE_UNAVAILABLE',
        503,
        'Курсы обновляются из официального источника. Повторите операцию через несколько секунд.',
      );
    })();
    this.pending = pending;
    try {
      return await pending;
    } finally {
      if (this.pending === pending) this.pending = undefined;
    }
  }
}

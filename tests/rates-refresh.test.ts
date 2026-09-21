import { describe, expect, it } from 'vitest';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  EcbRates,
  S3RateFreshness,
  type RateYear,
} from '../src/aws/exchange-rates';
import { createEmptyState, stableId, type Command } from '../src/domain';

describe('automatic official-rate cache', () => {
  it('looks up the preceding December even when this year was first cached in September', async () => {
    const loaded: string[] = [];
    const years: Record<string, RateYear> = {
      '2026': [
        { date: '2026-09-16', rates: { EUR: '1', USD: '1.2', CZK: '24' } },
      ],
      '2025': [
        { date: '2025-12-31', rates: { EUR: '1', USD: '1.1', CZK: '22' } },
      ],
    };
    const rates = new EcbRates(
      async (year) => {
        loaded.push(year);
        return years[year] ?? [];
      },
      () => Date.UTC(2026, 8, 17),
    );
    const command = (date: string): Command => ({
      type: 'RecordPaymentAndAllocate',
      payload: {
        payment: {
          id: stableId(date),
          paidAt: date,
          amount: 100,
          currency: 'USD',
          payerPersonId: stableId('payer'),
          source: 'manual',
        },
        allocations: [],
      },
    });
    const state = createEmptyState();
    expect((await rates.quotes(state, [command('2026-09-16')]))[0].rate).toBe(
      '20.000000000000',
    );
    expect((await rates.quotes(state, [command('2026-01-01')]))[0].source).toBe(
      'ECB (2025-12-31)',
    );
    expect(loaded).toEqual(['2026', '2025']);
  });
  it('refreshes a stale S3 cache once and reuses a confirmed current source snapshot', async () => {
    let now = Date.UTC(2026, 8, 17),
      requestedAt = 0,
      writes = 0,
      reads = 0;
    let status = { checkedAt: now - 3600000, full: false };
    const client = {
      send: async (command: any) => {
        if (command instanceof PutObjectCommand) {
          writes++;
          requestedAt = JSON.parse(command.input.Body as string).requestedAt;
          return {};
        }
        expect(command).toBeInstanceOf(GetObjectCommand);
        reads++;
        return {
          Body: { transformToString: async () => JSON.stringify(status) },
        };
      },
    };
    const cache = new S3RateFreshness(
      'private-bucket',
      client as any,
      () => now,
      async (ms) => {
        now += ms;
        status = { checkedAt: requestedAt + 1, full: false };
      },
    );
    expect(await cache.ensure()).toBe(true);
    expect(writes).toBe(1);
    const after = reads;
    expect(await cache.ensure()).toBe(false);
    expect(reads).toBe(after);
    now += 61000;
    expect(await cache.ensure()).toBe(false);
    expect(writes).toBe(1);
  });
  it('fails a payment request within a bounded time when the official source does not refresh', async () => {
    let now = Date.UTC(2026, 8, 17),
      writes = 0;
    const client = {
      send: async (command: any) => {
        if (command instanceof PutObjectCommand) {
          writes++;
          return {};
        }
        throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      },
    };
    const cache = new S3RateFreshness(
      'private-bucket',
      client as any,
      () => now,
      async (ms) => {
        now += ms;
      },
    );
    await expect(cache.ensure()).rejects.toMatchObject({
      code: 'EXCHANGE_SOURCE_UNAVAILABLE',
      status: 503,
    });
    expect(writes).toBe(1);
    expect(now - Date.UTC(2026, 8, 17)).toBe(12000);
  });
});

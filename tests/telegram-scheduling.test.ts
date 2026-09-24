import { describe, expect, it } from 'vitest';
import { nextTelegramReportAt } from '../src/aws/telegram-reminders';

const next = (after: string, hour: number, timeZone = 'Europe/Prague') =>
  new Date(
    nextTelegramReportAt({ hour, timeZone }, Date.parse(after)),
  ).toISOString();

describe('Local Telegram report hour mapped to UTC EventBridge ticks', () => {
  it('preserves the selected local hour across winter and summer', () => {
    expect(next('2026-01-15T00:00:00Z', 9)).toBe('2026-01-15T08:00:00.000Z');
    expect(next('2026-07-15T00:00:00Z', 9)).toBe('2026-07-15T07:00:00.000Z');
  });
  it('does not schedule the next hour after today’s selected hour already passed', () => {
    expect(next('2026-07-15T07:00:00Z', 9)).toBe('2026-07-16T07:00:00.000Z');
    expect(next('2026-07-15T07:00:01Z', 9)).toBe('2026-07-16T07:00:00.000Z');
  });
  it('runs a nonexistent spring hour at the next available local hour', () => {
    expect(next('2026-03-29T00:00:00Z', 2)).toBe('2026-03-29T01:00:00.000Z');
    expect(next('2026-03-29T01:00:00Z', 2)).toBe('2026-03-30T00:00:00.000Z');
  });
  it('uses the first repeated autumn hour only once', () => {
    expect(next('2026-10-24T22:00:00Z', 2)).toBe('2026-10-25T00:00:00.000Z');
    expect(next('2026-10-25T00:00:00Z', 2)).toBe('2026-10-26T01:00:00.000Z');
  });
  it('rounds fractional-offset zones to the next minute-zero UTC event', () => {
    expect(next('2026-07-15T00:00:00Z', 9, 'Asia/Kolkata')).toBe(
      '2026-07-15T04:00:00.000Z',
    );
    expect(next('2026-07-15T00:00:00Z', 9, 'Asia/Kathmandu')).toBe(
      '2026-07-15T04:00:00.000Z',
    );
  });
  it('handles local dates ahead of and behind UTC', () => {
    expect(next('2026-07-15T00:00:00Z', 9, 'Pacific/Kiritimati')).toBe(
      '2026-07-15T19:00:00.000Z',
    );
    expect(next('2026-07-15T00:00:00Z', 9, 'Pacific/Honolulu')).toBe(
      '2026-07-15T19:00:00.000Z',
    );
  });
  it('rejects invalid hours and timezones before deriving a trigger', () => {
    for (const spec of [
      { hour: 24, timeZone: 'UTC' },
      { hour: 1.5, timeZone: 'UTC' },
      { hour: 9, timeZone: 'Invalid/Zone' },
    ])
      expect(() => nextTelegramReportAt(spec, Date.now())).toThrow();
  });
});

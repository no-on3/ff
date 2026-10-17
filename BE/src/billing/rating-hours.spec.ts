/**
 * L1: when the hourly rating rates an hour (client-readiness plan, P-32, D9):
 * once its last usage can have arrived, in order, each once; and the key of
 * an account's debit for it.
 */
import { HOUR_MS, dueHours, hourOf, settleMs, usageKey } from './rating-hours';

const at = (iso: string) => new Date(iso);
const MINUTE = 60_000;

describe('the hours to rate (L1, P-32)', () => {
  it('waits 33 minutes after an hour ends at the platform limits: two 900 s timeouts, a 90 s cold start, 30 s, and a minute', () => {
    expect(settleMs(90)).toBe(33 * MINUTE);
    expect(settleMs(30)).toBe(32 * MINUTE);
  });

  it('starts an hour at its whole hour, UTC', () => {
    expect(hourOf(at('2026-10-17T10:59:59.999Z'))).toEqual(at('2026-10-17T10:00:00Z'));
    expect(hourOf(at('2026-10-17T10:00:00Z'))).toEqual(at('2026-10-17T10:00:00Z'));
  });

  it('rates an hour once it has settled, not a millisecond before', () => {
    const settle = 33 * MINUTE;
    const first = at('2026-10-17T10:00:00Z');

    expect(dueHours(first, at('2026-10-17T11:32:59.999Z'), settle)).toEqual([]);
    expect(dueHours(first, at('2026-10-17T11:33:00Z'), settle)).toEqual([first]);
  });

  it('gives every hour missed, in order, from the first to the last settled', () => {
    const hours = dueHours(at('2026-10-17T22:00:00Z'), at('2026-10-18T02:40:00Z'), 33 * MINUTE);

    expect(hours.map((hour) => hour.toISOString().slice(0, 16))).toEqual(['2026-10-17T22:00', '2026-10-17T23:00', '2026-10-18T00:00', '2026-10-18T01:00']);
    expect(hours.every((hour, index) => index === 0 || hour.getTime() - hours[index - 1].getTime() === HOUR_MS)).toBe(true);
  });

  it('starts from the hour of a first instant within it, as a book that starts at a whole hour does', () => {
    expect(dueHours(at('2026-10-01T00:20:00Z'), at('2026-10-01T01:33:00Z'), 33 * MINUTE)).toEqual([at('2026-10-01T00:00:00Z')]);
  });

  it('keys a debit by account and hour, so the hour is debited once', () => {
    expect(usageKey('000000000001', at('2026-10-17T10:00:00Z'))).toBe('usage:000000000001:2026-10-17T10');
  });
});

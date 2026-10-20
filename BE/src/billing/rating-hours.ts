import { PLATFORM_LIMITS } from '../plans/plan-limits';

/** An hour, in ms. */
export const HOUR_MS = 3_600_000;

/**
 * How long after an hour ends its usage can still arrive (P-32): a call's
 * record is written when it ends, at most two timeouts (a wait for a free
 * instance, then the run), a cold start and 30 s after its start, as P-20's
 * reaper counts; then a minute more, for the last minute's sample. 33 minutes
 * at the platform's limits, with the 90 s cold start.
 */
export const settleMs = (coldStartSeconds: number): number => (2 * PLATFORM_LIMITS.timeoutSeconds + coldStartSeconds + 30 + 60) * 1000;

/** The start of the hour an instant falls in, UTC. */
export const hourOf = (instant: Date): Date => new Date(Math.floor(instant.getTime() / HOUR_MS) * HOUR_MS);

/** The hours to rate, in order: from the hour of `first` to the last one that has ended `settle` ms before `now`. */
export function dueHours(first: Date, now: Date, settle: number): Date[] {
  const last = hourOf(new Date(now.getTime() - settle)).getTime() - HOUR_MS;
  const hours: Date[] = [];
  for (let at = hourOf(first).getTime(); at <= last; at += HOUR_MS) hours.push(new Date(at));
  return hours;
}

/** The idempotency key of an account's debit for an hour (D9): usage:<account>:<hour>, as usage:000000000001:2026-10-17T10. */
export const usageKey = (accountId: string, hour: Date): string => `usage:${accountId}:${hour.toISOString().slice(0, 13)}`;

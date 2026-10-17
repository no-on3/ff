/**
 * L1: D9's balance check (client-readiness plan, P-33): invokes go on down to
 * the negative buffer, then for the grace period, then answer 402; shadow
 * mode refuses nothing. The standing it reads runs against PostgreSQL in
 * credit.db.spec.ts.
 */
import { DEFAULT_SETTINGS } from '../admin/platform-settings';
import { CreditPolicy, CreditStanding, InsufficientCreditException, creditDecision, creditPolicy } from './credit-policy';

const HOUR = 3_600_000;
const BELOW = new Date('2026-10-17T10:33:00Z');
const POLICY: CreditPolicy = { bufferMinor: 1000n, graceMs: 24 * HOUR, shadow: false };
const standing = (balanceMinor: bigint, belowBufferSince: Date | null = balanceMinor < -1000n ? BELOW : null): CreditStanding => ({
  currency: 'TND',
  exponent: 3,
  balanceMinor,
  belowBufferSince,
});
const at = (msAfterBelow: number) => new Date(BELOW.getTime() + msAfterBelow);

describe('the balance check before an invoke (L1, P-33)', () => {
  it('lets calls go on down to the buffer, the buffer itself included', () => {
    for (const balance of [5000n, 0n, -1n, -1000n]) expect(creditDecision(standing(balance), POLICY, at(48 * HOUR))).toEqual({ state: 'ok', invokesStopAt: null });
    // Its own rule, whatever the standing says of since when: at the buffer is not below it.
    expect(creditDecision(standing(-1000n, BELOW), POLICY, at(48 * HOUR)).state).toBe('ok');
  });

  it('below it, for the grace period counted from when the balance fell; then they stop, at its end exactly', () => {
    const stopAt = at(24 * HOUR);

    expect(creditDecision(standing(-1001n), POLICY, at(0))).toEqual({ state: 'grace', invokesStopAt: stopAt });
    expect(creditDecision(standing(-1001n), POLICY, at(24 * HOUR - 1))).toEqual({ state: 'grace', invokesStopAt: stopAt });
    expect(creditDecision(standing(-1001n), POLICY, at(24 * HOUR))).toEqual({ state: 'stopped', invokesStopAt: stopAt });
  });

  it('with no grace period, stops at once; with a bigger buffer, later', () => {
    expect(creditDecision(standing(-1001n), { ...POLICY, graceMs: 0 }, at(0)).state).toBe('stopped');
    expect(creditDecision(standing(-1001n), { ...POLICY, bufferMinor: 5000n }, at(48 * HOUR)).state).toBe('ok');
  });

  it('refuses nothing in shadow mode, when nothing is debited', () => {
    expect(creditDecision(standing(-99999n), { ...POLICY, shadow: true }, at(48 * HOUR))).toEqual({ state: 'ok', invokesStopAt: null });
  });

  it('reads the rule from the platform settings, the buffer in the currency’s minor units', () => {
    expect(creditPolicy(DEFAULT_SETTINGS, 3)).toEqual({ bufferMinor: 1000n, graceMs: 24 * HOUR, shadow: true });
    expect(creditPolicy({ ...DEFAULT_SETTINGS, negativeBuffer: '2.500', gracePeriodHours: 0, billingShadowMode: false }, 3)).toEqual({ bufferMinor: 2500n, graceMs: 0, shadow: false });
  });

  it("answers 402 InsufficientCreditException, saying since when, until when, and what to do", () => {
    const refusal = new InsufficientCreditException(standing(-2345n), POLICY, creditDecision(standing(-2345n), POLICY, at(30 * HOUR)));

    expect(refusal.getStatus()).toBe(402);
    expect(refusal.getResponse()).toEqual({
      statusCode: 402,
      error: 'Payment Required',
      message:
        "InsufficientCreditException: Invokes stopped at 2026-10-18 10:33 UTC: the account's balance is -2.345 TND, below -1.000 TND since 2026-10-17 10:33 UTC, " +
        'past the 24-hour grace period. Add credit to invoke again; reads, logs and deploys go on.',
    });
  });
});

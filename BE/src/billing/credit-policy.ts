import { HttpException, HttpStatus } from '@nestjs/common';
import type { PlatformSettings } from '../admin/platform-settings';
import { formatMinor, parseMinor } from './money';

const HOUR_MS = 3_600_000;

/** Where an account stands with its credit (P-33): its wallet, from the ledger. */
export interface CreditStanding {
  currency: string;
  exponent: number;
  balanceMinor: bigint;
  /** When the balance last fell below the buffer and stayed there: the grace period counts from it. Null while it isn't below. */
  belowBufferSince: Date | null;
}

/** D9's rule, from the platform settings (P-70). */
export interface CreditPolicy {
  /** How far below zero a balance may go, in minor units: 1000n for 1.000 TND. */
  bufferMinor: bigint;
  /** How long invokes go on once the balance is below the buffer. */
  graceMs: number;
  /** Shadow mode: nothing is debited, so nothing is refused either. */
  shadow: boolean;
}

/** ok: above the buffer; grace: below it, invokes still go; stopped: invokes answer 402. */
export type CreditState = 'ok' | 'grace' | 'stopped';

export interface CreditDecision {
  state: CreditState;
  /** When invokes stop, or stopped: the grace period's end. Null while the balance is above the buffer. */
  invokesStopAt: Date | null;
}

/** The settings as the rule: the buffer, a string of the currency's decimals, in minor units. */
export const creditPolicy = (settings: Pick<PlatformSettings, 'billingShadowMode' | 'negativeBuffer' | 'gracePeriodHours'>, exponent: number): CreditPolicy => ({
  bufferMinor: parseMinor(settings.negativeBuffer, exponent),
  graceMs: settings.gracePeriodHours * HOUR_MS,
  shadow: settings.billingShadowMode,
});

/**
 * D9's balance check: calls go on down to the negative buffer, so that
 * metering lag never blocks a paying customer; below it, for the grace
 * period; then invokes stop until credit brings the balance back above the
 * buffer. In shadow mode nothing is debited, and nothing is refused.
 */
export function creditDecision(standing: CreditStanding, policy: CreditPolicy, now: Date): CreditDecision {
  if (policy.shadow || standing.balanceMinor >= -policy.bufferMinor || !standing.belowBufferSince) return { state: 'ok', invokesStopAt: null };
  const invokesStopAt = new Date(standing.belowBufferSince.getTime() + policy.graceMs);
  return { state: now < invokesStopAt ? 'grace' : 'stopped', invokesStopAt };
}

/** An instant to read in a message: "2026-10-18 10:33 UTC". */
export const utcMinute = (instant: Date): string => `${instant.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** Lambda's way of saying it (D9): 402, and the reason, with what to do. */
export class InsufficientCreditException extends HttpException {
  constructor(standing: CreditStanding, policy: CreditPolicy, decision: CreditDecision) {
    const money = (minor: bigint) => `${formatMinor(minor, standing.exponent)} ${standing.currency}`;
    const hours = policy.graceMs / HOUR_MS;
    super(
      {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        error: 'Payment Required',
        message:
          `InsufficientCreditException: Invokes stopped at ${utcMinute(decision.invokesStopAt as Date)}: the account's balance is ${money(standing.balanceMinor)}, ` +
          `below ${money(-policy.bufferMinor)} since ${utcMinute(standing.belowBufferSince as Date)}, past the ${hours}-hour grace period. ` +
          'Add credit to invoke again; reads, logs and deploys go on.',
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

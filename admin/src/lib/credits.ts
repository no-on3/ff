/**
 * Credit grants (P-74) and the account page's credit (P-33), as the admin
 * routes give them. Money stays a string; amounts are compared in minor
 * units, as BigInt, never through a float.
 */
import { formatMoney } from './money';
import { whenUtc } from './time';

export type GrantKind = 'promo' | 'adjustment';

/** The kinds, as the API names them (GRANT_KINDS in BE/src/admin/credit-grants.ts; contract.test.ts compares them), with what the page calls each. */
export const GRANT_KINDS: Array<{ value: GrantKind; label: string }> = [
  { value: 'promo', label: 'Promotional credit' },
  { value: 'adjustment', label: 'Correction' },
];

/** The account page's credit: AdminCreditView. */
export interface AccountCredit {
  currency: string;
  balance: string;
  state: { state: 'ok' | 'grace' | 'stopped'; buffer: string; belowBufferSince: string | null; invokesStopAt: string | null };
  shadowMode: boolean;
  month: string;
  debited: string;
  ratedOnly: string;
  ratedUntil: string | null;
  largeCreditThreshold: string;
}
/** Its fields, in the API's order: contract.test.ts compares them. */
export const ADMIN_CREDIT_FIELDS = ['currency', 'balance', 'state', 'shadowMode', 'month', 'debited', 'ratedOnly', 'ratedUntil', 'largeCreditThreshold'] as const;

/** A grant, as the API answers it: AdminGrantView. */
export interface Grant {
  id: string;
  kind: GrantKind;
  currency: string;
  amount: string;
  balance: string;
  createdAt: string;
  replayed: boolean;
}
export const GRANT_FIELDS = ['id', 'kind', 'currency', 'amount', 'balance', 'createdAt', 'replayed'] as const;

/** What the grant dialog sends: AdminGrantDto. */
export interface GrantRequest {
  kind: GrantKind;
  amount: string;
  reason: string;
  idempotencyKey: string;
  confirmAmount?: string;
  allowDebt?: boolean;
}
export const GRANT_REQUEST_FIELDS = ['kind', 'amount', 'confirmAmount', 'allowDebt', 'idempotencyKey'] as const;

/** The digits after the point of a currency's amounts, read from one the API gave: 3 for "100.000". */
export const decimalsOf = (amount: string): number => amount.split('.')[1]?.length ?? 0;

const magnitude = (minor: bigint): bigint => (minor < 0n ? -minor : minor);

/** An amount as typed, in minor units; null when it isn't one with these decimals at most. */
export function toMinor(text: string, decimals: number): bigint | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match || (match[3] ?? '').length > decimals) return null;
  const minor = BigInt(match[2] + (match[3] ?? '').padEnd(decimals, '0'));
  return match[1] ? -minor : minor;
}

/** An amount typed, with every decimal of its currency: "150" is "150.000"; as typed when it isn't one. */
export function withDecimals(text: string, decimals: number): string {
  const minor = toMinor(text, decimals);
  if (minor === null) return text.trim();
  const digits = magnitude(minor).toString().padStart(decimals + 1, '0');
  const whole = decimals > 0 ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}` : digits;
  return `${minor < 0n ? '-' : ''}${whole}`;
}

/** Why the amount typed, without a sign, can't be granted yet; null when it can. The direction says which way it goes. */
export function amountProblem(text: string, decimals: number): string | null {
  if (text.trim() === '') return 'Type an amount.';
  const minor = toMinor(text, decimals);
  const example = decimals > 0 ? `25.${'0'.repeat(decimals)}` : '25';
  if (minor === null || minor < 0n) return `Type an amount such as ${example}, with ${decimals} decimals at most: the direction says which way it goes.`;
  if (minor === 0n) return 'Type an amount above 0.';
  return null;
}

/** The amount the API takes: signed, below 0 for a correction that takes credit away. */
export const signedAmount = (text: string, takeAway: boolean): string => `${takeAway ? '-' : ''}${text.trim()}`;

/** Whether a grant needs its second confirmation (D12): above the large-credit threshold, either way. */
export function needsConfirmation(amount: string, threshold: string): boolean {
  const decimals = decimalsOf(threshold);
  const [minor, limit] = [toMinor(amount, decimals), toMinor(threshold, decimals)];
  return minor !== null && limit !== null && magnitude(minor) > limit;
}

/** Whether the amount typed again is the amount: the same value to the minor unit, "250" as "250.000". */
export function confirms(again: string, amount: string, decimals: number): boolean {
  const [typed, first] = [toMinor(again, decimals), toMinor(amount, decimals)];
  return typed !== null && first !== null && typed === first;
}

/** Whether invokes go on, and until when (D9). */
export function creditStateLabel(credit: Pick<AccountCredit, 'state' | 'shadowMode' | 'currency'>): string {
  const { state, buffer, belowBufferSince, invokesStopAt } = credit.state;
  const floor = formatMoney(`-${buffer}`, credit.currency);
  if (credit.shadowMode) return 'Invokes go on: shadow mode refuses nothing (D9).';
  if (state === 'ok') return `Invokes go on, down to ${floor}.`;
  if (state === 'grace') return `Below ${floor} since ${whenUtc(belowBufferSince as string)}: invokes stop at ${whenUtc(invokesStopAt as string)}.`;
  return `Invokes stopped at ${whenUtc(invokesStopAt as string)}, and answer 402 until credit brings the balance to ${floor} or more.`;
}

const isZero = (amount: string): boolean => /^-?0(\.0+)?$/.test(amount);

/** This month's charges: debited, and only rated in shadow mode, and until when usage is rated. */
export function chargesLabel(credit: Pick<AccountCredit, 'debited' | 'ratedOnly' | 'ratedUntil' | 'currency'>): string {
  if (!credit.ratedUntil) return 'Nothing rated yet.';
  const parts = [`${formatMoney(credit.debited, credit.currency)} debited`];
  if (!isZero(credit.ratedOnly)) parts.push(`${formatMoney(credit.ratedOnly, credit.currency)} only rated, in shadow mode`);
  return `${parts.join('; ')}. Rated until ${whenUtc(credit.ratedUntil)}.`;
}

/** What the page says once a grant is made, or found made before. */
export function grantNotice(grant: Grant): string {
  const balance = formatMoney(grant.balance, grant.currency);
  if (grant.replayed) return `This grant was made at ${whenUtc(grant.createdAt)}: nothing was granted again. The balance is ${balance}.`;
  const amount = formatMoney(grant.amount.replace(/^-/, ''), grant.currency);
  const what = grant.kind === 'promo' ? `${amount} of promotional credit granted` : `Corrected: ${amount} ${grant.amount.startsWith('-') ? 'taken away' : 'added'}`;
  return `${what}. The balance is now ${balance}; the owners got an e-mail.`;
}

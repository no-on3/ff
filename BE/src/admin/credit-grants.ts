import { LedgerTransactionKind } from '../billing/ledger/ledger-transaction.entity';
import { formatMinor } from '../billing/money';
import type { Mail } from '../mail/mail.service';

/** What an operator grants (P-74): promotional credit, which only adds, or a correction, either way. */
export type GrantKind = LedgerTransactionKind.PROMO | LedgerTransactionKind.ADJUSTMENT;
export const GRANT_KINDS: GrantKind[] = [LedgerTransactionKind.PROMO, LedgerTransactionKind.ADJUSTMENT];

/** The audit action of each kind of grant. */
export const GRANT_ACTIONS = { promo: 'credit.promo', adjustment: 'credit.adjustment' } as const;

/** The most one grant moves, either way, in whole units of the currency: as much as the largest pro-forma's credit. */
export const GRANT_LIMIT = 1_000_000n;

/** A grant's ledger key: the client's key for it, so that a retried request grants once. */
export const grantKey = (idempotencyKey: string): string => `grant:${idempotencyKey}`;

const magnitude = (minor: bigint): bigint => (minor < 0n ? -minor : minor);

/** Why a grant of this kind and amount, in minor units, can't be made; null when it can. */
export function grantProblem(kind: GrantKind, amountMinor: bigint, exponent: number, currency: string): string | null {
  if (amountMinor === 0n) return 'amount must not be 0: a grant moves the balance';
  if (kind === LedgerTransactionKind.PROMO && amountMinor < 0n) {
    return 'A promotion adds credit: its amount is above 0. A correction (kind adjustment) takes credit away';
  }
  const limitMinor = GRANT_LIMIT * 10n ** BigInt(exponent);
  if (magnitude(amountMinor) > limitMinor) return `A grant moves ${formatMinor(limitMinor, exponent)} ${currency} at most, either way`;
  return null;
}

/** Whether a grant needs its second confirmation (D12): above the large-credit threshold, either way. */
export const needsConfirmation = (amountMinor: bigint, thresholdMinor: bigint): boolean => magnitude(amountMinor) > thresholdMinor;

/**
 * Why the grant's confirmation doesn't do; null when it does. Above the
 * threshold, the amount is typed again; a confirmation, whenever it is sent,
 * is the amount itself.
 */
export function confirmationProblem(amountMinor: bigint, confirmMinor: bigint | undefined, thresholdMinor: bigint, exponent: number, currency: string): string | null {
  const money = (minor: bigint) => `${formatMinor(minor, exponent)} ${currency}`;
  if (confirmMinor !== undefined && confirmMinor !== amountMinor) {
    return `confirmAmount is ${formatMinor(confirmMinor, exponent)}, not the amount, ${formatMinor(amountMinor, exponent)}: nothing was granted`;
  }
  if (confirmMinor === undefined && needsConfirmation(amountMinor, thresholdMinor)) {
    return `${money(magnitude(amountMinor))} is above the large-credit threshold, ${money(thresholdMinor)}: type the amount again as confirmAmount to grant it (D12)`;
  }
  return null;
}

/** What the owners' e-mail says of a grant. */
export interface GrantFacts {
  account: { id: string; name: string };
  kind: GrantKind;
  amountMinor: bigint;
  /** The balance once granted. */
  balanceMinor: bigint;
  currency: string;
  exponent: number;
  reason: string;
  consoleUrl: string;
}

/** The e-mail each owner gets for a grant: what moved, why, and the balance. Like the reason in their audit log, it hides nothing of the operator's words. */
export function grantMail(facts: GrantFacts): Omit<Mail, 'to'> {
  const money = (minor: bigint) => `${formatMinor(minor, facts.exponent)} ${facts.currency}`;
  const which = `your account "${facts.account.name}" (${facts.account.id})`;
  const promotion = facts.kind === LedgerTransactionKind.PROMO;
  const first = promotion
    ? `FF added ${money(facts.amountMinor)} of credit to ${which}.`
    : facts.amountMinor > 0n
      ? `FF corrected the credit of ${which}: ${money(facts.amountMinor)} added.`
      : `FF corrected the credit of ${which}: ${money(-facts.amountMinor)} taken away.`;
  return {
    subject: promotion ? `FF added credit to your account: ${facts.account.name}` : `FF corrected your credit: ${facts.account.name}`,
    text: [first, `Why: ${facts.reason}`, `The balance is now ${money(facts.balanceMinor)}.`, '', `Your balance, and what moved it: ${facts.consoleUrl}/billing`].join('\n'),
  };
}

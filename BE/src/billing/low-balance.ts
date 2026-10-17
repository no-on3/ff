import type { Mail } from '../mail/mail.service';
import type { CreditPolicy } from './credit-policy';
import { formatMinor } from './money';

/**
 * The shares of the last credit that the balance has fallen to or below and
 * that no e-mail has named yet for that credit, largest first (P-33): 50%
 * means the balance is half the credit or less; 0% that the credit is used up.
 */
export function sharesReached(balanceMinor: bigint, creditMinor: bigint, percents: number[], notified: ReadonlySet<number>): number[] {
  return percents.filter((percent) => !notified.has(percent) && balanceMinor * 100n <= creditMinor * BigInt(percent));
}

export interface LowBalanceFacts {
  account: { id: string; name: string };
  /** The lowest share reached, which the e-mail names. */
  percent: number;
  balanceMinor: bigint;
  creditMinor: bigint;
  creditAt: Date;
  currency: string;
  exponent: number;
  policy: CreditPolicy;
  consoleUrl: string;
}

/** The e-mail each owner gets when the balance reaches a share of the last credit. */
export function lowBalanceMail(facts: LowBalanceFacts): Omit<Mail, 'to'> {
  const money = (minor: bigint) => `${formatMinor(minor, facts.exponent)} ${facts.currency}`;
  const which = `your account "${facts.account.name}" (${facts.account.id})`;
  const credit = `${money(facts.creditMinor)} on ${facts.creditAt.toISOString().slice(0, 10)}`;
  const first =
    facts.percent === 0
      ? `The balance of ${which} is ${money(facts.balanceMinor)}: your last credit, ${credit}, is used up.`
      : `The balance of ${which} is ${money(facts.balanceMinor)}: ${facts.percent}% or less of your last credit, ${credit}.`;
  return {
    subject: facts.percent === 0 ? `Your FF credit has run out: ${facts.account.name}` : `Your FF credit is down to ${facts.percent}%: ${facts.account.name}`,
    text: [
      first,
      '',
      `Add credit before invokes stop: they go on down to ${money(-facts.policy.bufferMinor)}, then for ${facts.policy.graceMs / 3_600_000} hours more. Reads, logs and deploys always go on.`,
      '',
      `Your balance, and when these e-mails come: ${facts.consoleUrl}/billing`,
    ].join('\n'),
  };
}

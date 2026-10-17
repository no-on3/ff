import type { Balance } from '../services/api';
import { formatMoney } from './usage';

/** The header's balance: "12.500 TND", "-0.250 TND". */
export const balanceLabel = (balance: Balance): string => formatMoney(balance.balance, balance.currency);

/** An instant to read in the header's note: "17 Oct, 10:00 UTC". */
function shortUtc(iso: string): string {
  const date = new Date(iso);
  const day = date.toLocaleString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${day}, ${iso.slice(11, 16)} UTC`;
}

/**
 * What the billing trial means for the account (D9), as the header's badge
 * explains it: null once usage is charged. The amount is this month's, rated
 * hour by hour, up to the last hour rated.
 */
export function trialNote(balance: Balance): string | null {
  if (!balance.shadowMode) return null;
  const until = balance.ratedUntil && balance.ratedUntil.slice(0, 7) === balance.month ? `, up to ${shortUtc(balance.ratedUntil)}` : '';
  return `Billing trial: usage is rated every hour but not charged yet. This month so far: ${formatMoney(balance.charged, balance.currency)}${until}.`;
}

/**
 * The banner on every page once the balance is below the buffer (P-33): a
 * warning while invokes still go, an alert once they stopped; null while all
 * is well.
 */
export function creditBanner(balance: Balance): { tone: 'warning' | 'danger'; text: string } | null {
  const { credit } = balance;
  if (credit.state === 'ok' || !credit.invokesStopAt) return null;
  const money = formatMoney(balance.balance, balance.currency);
  const limit = formatMoney(`-${credit.buffer}`, balance.currency);
  if (credit.state === 'grace') {
    return { tone: 'warning', text: `Your balance is ${money}, below the ${limit} FF allows: invokes stop on ${shortUtc(credit.invokesStopAt)} unless you add credit.` };
  }
  return { tone: 'danger', text: `Invokes are stopped: your balance is ${money}, below ${limit}. Add credit to invoke again; reads, logs and deploys go on.` };
}

/** Whether invokes go on, for the Billing page. */
export function invokesLabel(balance: Balance): string {
  const { credit } = balance;
  if (balance.shadowMode) return 'Going on: nothing is charged during the billing trial';
  if (credit.state === 'grace' && credit.invokesStopAt) return `Stop on ${shortUtc(credit.invokesStopAt)}`;
  if (credit.state === 'stopped' && credit.invokesStopAt) return `Stopped since ${shortUtc(credit.invokesStopAt)}`;
  return `Going on, down to ${formatMoney(`-${credit.buffer}`, balance.currency)}`;
}

const KINDS: Record<string, string> = {
  usage: 'Usage',
  topup: 'Top-up',
  payment: 'Payment',
  promo: 'Credit from FF',
  adjustment: 'Correction',
  refund: 'Refund',
  invoice: 'Invoice',
  withholding: 'Withholding tax',
};

/** A transaction to read: "Usage, 17 Oct, 10:00–11:00 UTC" for an hour's debit; else its kind. */
export function transactionLabel(transaction: { kind: string; occurredAt: string }): string {
  if (transaction.kind !== 'usage') return KINDS[transaction.kind] ?? transaction.kind;
  const end = new Date(new Date(transaction.occurredAt).getTime() + 3_600_000).toISOString();
  return `Usage, ${shortUtc(transaction.occurredAt).replace(' UTC', '')}–${end.slice(11, 16)} UTC`;
}

/** Shares as the form shows them: "50, 20, 0". */
export const percentsText = (percents: number[]): string => percents.join(', ');

/** Shares as an owner types them, "80, 20, 0", or what is wrong with them. The API checks them again. */
export function parsePercents(text: string): { percents: number[] } | { problem: string } {
  const parts = text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 100)) return { problem: 'Each share is a whole percent from 0 to 100, such as 50, 20, 0' };
  const percents = parts.map(Number);
  if (percents.length > 5) return { problem: 'Five shares at most' };
  if (percents.some((percent, index) => index > 0 && percent >= percents[index - 1])) return { problem: 'From the largest share to the smallest, each once' };
  return { percents };
}

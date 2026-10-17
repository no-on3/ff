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

import type { Balance, ProForma } from '../services/api';
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

/** D9's VAT on prepaid credit, as the API adds it to a pro-forma; contract.test.ts checks it against BE's pro-forma.ts. */
export const VAT_PERCENT = 19;
/** The credit a pro-forma may ask for, in whole units of the currency: the API's limits, checked by contract.test.ts. */
export const CREDIT_LIMITS = { min: 10, max: 1_000_000 };
/** The parent plan's prepaid packs (§8.7), in whole units of the currency. */
export const CREDIT_PACKS = ['20', '50', '100', '500'];

/** A currency's decimals, from an amount the API wrote with all of them: "1.000" has 3. */
export const decimalsOf = (amount: string): number => amount.split('.')[1]?.length ?? 0;

/** Minor units as the API writes them: 59500 at 3 decimals is "59.500". */
function minorText(minor: bigint, decimals: number): string {
  if (decimals === 0) return minor.toString();
  const digits = minor.toString().padStart(decimals + 1, '0');
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

/**
 * What a pro-forma for this credit comes to (P-35), before the owner asks for
 * it: the credit with every decimal, the VAT on top rounded once to the minor
 * unit, half up as the API rounds, and the total to transfer. Or what is wrong
 * with the amount typed; the API checks it again.
 */
export function proFormaQuote(text: string, decimals: number, vatPercent = VAT_PERCENT): { credit: string; vat: string; total: string } | { problem: string } {
  const match = /^(\d{1,9})(?:\.(\d+))?$/.exec(text.trim());
  if (!match) return { problem: 'The credit is an amount, such as 50 or 50.500' };
  const [, whole, fraction = ''] = match;
  if (fraction.length > decimals) return { problem: decimals === 0 ? 'The credit is a whole amount' : `The credit has at most ${decimals} decimals` };
  const unit = 10n ** BigInt(decimals);
  const credit = BigInt(whole) * unit + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (credit < BigInt(CREDIT_LIMITS.min) * unit || credit > BigInt(CREDIT_LIMITS.max) * unit) {
    return { problem: `The credit is from ${CREDIT_LIMITS.min} to ${CREDIT_LIMITS.max.toLocaleString('en-US')}` };
  }
  const vat = (credit * BigInt(vatPercent) + 50n) / 100n;
  return { credit: minorText(credit, decimals), vat: minorText(vat, decimals), total: minorText(credit + vat, decimals) };
}

/** "20 Oct 2026", from a date or an instant, in UTC. */
const shortDay = (iso: string) => new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Where a pro-forma stands, as the Billing page lists it: the transfer, then the share withheld at source, if any. */
export function proFormaState(proForma: ProForma): { label: string; note: string | null } {
  const { transfer, currency } = proForma;
  if (!transfer) return { label: 'Waiting for the transfer', note: null };
  const label = `Paid on ${shortDay(transfer.receivedOn)}: ${formatMoney(transfer.credited, currency)} credited`;
  if (/^0(\.0+)?$/.test(transfer.withheld)) return { label, note: null };
  const withheld = formatMoney(transfer.withheld, currency);
  return {
    label,
    note: transfer.withheldCreditedAt
      ? `${withheld} withheld at source, credited on ${shortDay(transfer.withheldCreditedAt)} with the certificate`
      : `${withheld} withheld at source: credited when FF receives the withholding certificate`,
  };
}

/** An amount on the French pro-forma: "1 234,500 TND", thousands apart with a narrow space, as French typesetting has them. */
export function frenchMoney(amount: string, currency: string): string {
  const [whole, fraction] = amount.replace(/^-/, '').split('.');
  const sign = amount.startsWith('-') ? '-' : '';
  return `${sign}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f')}${fraction === undefined ? '' : `,${fraction}`}\u00a0${currency}`;
}

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** A date on the French pro-forma, in UTC: "17 octobre 2026", "1er octobre 2026". */
export function frenchDate(iso: string): string {
  const date = new Date(iso);
  const day = date.getUTCDate();
  return `${day === 1 ? '1er' : day} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

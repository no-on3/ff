import type { UsageAmounts, UsageEstimate } from '../services/api';

const MS = { second: 1_000, minute: 60_000, hour: 3_600_000 };
const decimals = (value: number, digits: number) => value.toLocaleString('en-US', { maximumFractionDigits: digits });

/** This month and last month, as YYYY-MM by the UTC calendar, as the API counts them (P-22). */
export function usageMonths(now: Date): { thisMonth: string; lastMonth: string } {
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { thisMonth: now.toISOString().slice(0, 7), lastMonth: last.toISOString().slice(0, 7) };
}

/** "2026-10" as "October 2026". */
export function monthLabel(month: string): string {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** A billed duration to read: "16 ms", "3.02 s", "4.5 min", "2.1 h". */
export function formatBilledDuration(ms: number): string {
  if (ms < MS.second) return `${ms} ms`;
  if (ms < MS.minute) return `${decimals(ms / MS.second, 2)} s`;
  if (ms < MS.hour) return `${decimals(ms / MS.minute, 1)} min`;
  return `${decimals(ms / MS.hour, 1)} h`;
}

/** The API's exact GB-seconds to read: at most 6 decimals, and never rounded down to 0. */
export function formatGbSeconds(exact: string): string {
  const value = Number(exact);
  if (value === 0) return '0';
  if (value < 0.000001) return '< 0.000001';
  return decimals(value, 6);
}

/** The calls that weren't billed, by why (D7): "2 throttled", "1 lost". */
export function notBilled(amounts: UsageAmounts): string[] {
  const reasons: Array<[number, string]> = [
    [amounts.throttled, 'throttled'],
    [amounts.platformErrors, 'failed on the platform'],
    [amounts.lost, 'lost'],
  ];
  return reasons.filter(([count]) => count > 0).map(([count, why]) => `${count.toLocaleString('en-US')} ${why}`);
}

/** The CSV's file name, as the API names the download. */
export const usageCsvName = (accountId: string, month: string) => `ff-usage-${accountId}-${month}.csv`;

/** An amount the API rounded, to read: "1,234.567 TND", "-20.655 TND". */
export function formatMoney(amount: string, currency: string): string {
  const [whole, fraction] = amount.replace(/^-/, '').split('.');
  const sign = amount.startsWith('-') ? '-' : '';
  return `${sign}${BigInt(whole).toLocaleString('en-US')}${fraction === undefined ? '' : `.${fraction}`} ${currency}`;
}

/** The estimate's lines, as the page lists them: the usage, then only the deductions and fees there are, then the total. */
export function estimateLines(estimate: UsageEstimate): Array<[string, string]> {
  const zero = (amount: string) => /^-?0(\.0+)?$/.test(amount);
  const lines: Array<[string, string]> = [['Usage, before the free tier', estimate.usage]];
  if (!zero(estimate.freeTier)) lines.push(['Free tier', estimate.freeTier]);
  if (!zero(estimate.volumeTiers)) lines.push(['Volume tiers', estimate.volumeTiers]);
  if (!zero(estimate.monthlyFee)) lines.push(['Monthly fee', estimate.monthlyFee]);
  lines.push(['Estimated total', estimate.total]);
  return lines.map(([label, amount]) => [label, formatMoney(amount, estimate.currency)]);
}

/** When the prices start after the month does, from when: "Priced from 2026-10-16 (UTC)"; else nothing. */
export function pricedFromNote(month: string, estimate: UsageEstimate): string | null {
  const from = estimate.pricedFrom.slice(0, 10);
  return from === `${month}-01` ? null : `Priced from ${from} (UTC): no price applies before.`;
}

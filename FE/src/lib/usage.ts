import type { UsageAmounts } from '../services/api';

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

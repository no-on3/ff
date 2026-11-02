import { AWS_EXTRA_LINES, type AwsEstimate, type AwsEstimateMonth, type AwsExtraLine, type UsageAmounts, type UsageEstimate } from '../services/api';

const MS = { second: 1_000, minute: 60_000, hour: 3_600_000 };
const decimals = (value: number, digits: number) => value.toLocaleString('en-US', { maximumFractionDigits: digits });

/** This month and last month, as YYYY-MM by the UTC calendar, as the API counts them. */
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

/** An exact amount the API counted, GB-seconds or GB-months, to read: at most 6 decimals, and never rounded down to 0. */
export function formatExact(exact: string): string {
  const value = Number(exact);
  if (value === 0) return '0';
  if (value < 0.000001) return '< 0.000001';
  return decimals(value, 6);
}

/** The calls that weren't billed, by why: "2 throttled", "1 lost". */
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

/** An amount the API rounded, to read, thousands apart: "1,234.567", "-20.655". */
export function formatDecimal(amount: string): string {
  const [whole, fraction] = amount.replace(/^-/, '').split('.');
  const sign = amount.startsWith('-') ? '-' : '';
  return `${sign}${BigInt(whole).toLocaleString('en-US')}${fraction === undefined ? '' : `.${fraction}`}`;
}

/** The same with its currency: "1,234.567 TND", "-20.655 TND". */
export const formatMoney = (amount: string, currency: string): string => `${formatDecimal(amount)} ${currency}`;

/** A function's or a resource's cost in the month's estimate, or a dash when no price applies to the month. */
export const costText = (cost: string | null, estimate: UsageEstimate | null): string =>
  cost !== null && estimate ? formatMoney(cost, estimate.currency) : '–';

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

/** A row of the estimate at AWS's prices: a line, a cell a month, or a total under them. */
export interface AwsEstimateRow {
  /** The line's name, as the API gives it, or the total's. */
  key: string;
  label: string;
  /** The line of what AWS bills that FF doesn't, which a box leaves out; null for FF's own counts and the totals. */
  extra: AwsExtraLine | null;
  leftOut: boolean;
  total: boolean;
  /** A cell a month, in its column's order. */
  cells: string[];
}

/**
 * The estimate at AWS's prices as the page shows it, a column a month, this one marked "so far": each line in US$,
 * then the totals in US$ and in the book's currency, and the same months at FF's prices.
 */
export function awsEstimateTable(estimate: AwsEstimate): { months: string[]; rows: AwsEstimateRow[] } {
  const months = estimate.months.map((month) => `${monthLabel(month.month)}${month.until ? ', so far' : ''}`);
  const cells = (amount: (month: AwsEstimateMonth) => string | null | undefined) =>
    estimate.months.map((month) => {
      const value = amount(month);
      return value === null || value === undefined ? '–' : formatDecimal(value);
    });
  const lines: AwsEstimateRow[] = (estimate.months[0]?.lines ?? []).map((line) => ({
    key: line.line,
    label: line.label,
    extra: AWS_EXTRA_LINES.find((extra) => extra === line.line) ?? null,
    leftOut: line.leftOut,
    total: false,
    cells: cells((month) => month.lines.find((other) => other.line === line.line)?.usd),
  }));
  const total = (key: string, label: string, amount: (month: AwsEstimateMonth) => string | null): AwsEstimateRow => ({
    key,
    label,
    extra: null,
    leftOut: false,
    total: true,
    cells: cells(amount),
  });
  return {
    months,
    rows: [
      ...lines,
      total('totalUsd', 'Total, in US$', (month) => month.totalUsd),
      total('total', `Total, in ${estimate.currency}`, (month) => month.total),
      total('ffTotal', `At FF's prices, in ${estimate.currency}`, (month) => month.ffTotal),
    ],
  };
}

/** Where the estimate's prices come from and when FF read them, its currency's rate, and that it is an estimate. */
export function awsPricesNote(estimate: AwsEstimate): string {
  const [first, last] = estimate.pricesReadOn;
  const read = first === undefined ? '' : last !== undefined && last !== first ? ` from ${first} to ${last}` : ` on ${first}`;
  const rateOf = estimate.usdRateDate ? `, the rate of ${estimate.usdRateDate}` : '';
  return (
    `At AWS's US$ list prices in ${estimate.region}, as FF read them${read}, with the free tier AWS gives every account every month; ` +
    `in ${estimate.currency} at ${estimate.usdRate} ${estimate.currency} a US$${rateOf}. An estimate, not a quote: AWS bills what it measures.`
  );
}

/** The lines to leave out, `line` added or taken back, in the API's order, so that the same choice asks the same. */
export function toggleLine(without: readonly AwsExtraLine[], line: AwsExtraLine): AwsExtraLine[] {
  const next = without.includes(line) ? without.filter((other) => other !== line) : [...without, line];
  return AWS_EXTRA_LINES.filter((other) => next.includes(other));
}

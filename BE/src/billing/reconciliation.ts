import { DataSource } from 'typeorm';
import { HOUR_MS } from './rating-hours';
import { formatMinor, toMinor } from './money';
import { PricingService, monthBounds } from './pricing.service';
import { BILLED_CALL } from './usage-sql';

/** One account's month, as the hourly rating charged it and as the raw usage prices it. */
export interface ReconciledAccount {
  accountId: string;
  currency: string;
  exponent: number;
  /** The month's hourly charges added up, shadow or debited. */
  chargedMinor: bigint;
  /** The month to the end of the last hour rated, priced from the usage records and samples (P-30's estimate), rounded once. */
  estimatedMinor: bigint;
  /** Billed calls, as usage_hourly sums them and as the usage records count them. */
  ratedRequests: bigint;
  rawRequests: bigint;
}

export interface Reconciliation {
  month: string;
  /** The end of the month's last hour rated; null before the first. */
  ratedUntil: Date | null;
  accounts: ReconciledAccount[];
}

/** Whether an account's charges and its usage agree: the parent's criterion, rated usage equals raw usage (B-01). */
export const reconciled = (account: ReconciledAccount): boolean =>
  account.chargedMinor === account.estimatedMinor && account.ratedRequests === account.rawRequests;

/**
 * A month's charges against its raw usage (P-32): per account, what the
 * hourly rating charged, against the month to the end of the last hour rated
 * as P-30's estimate prices it from the usage records and samples. They differ
 * only if usage reached the database after its hour was rated: a call's record
 * later than its hour's settle time.
 */
export async function reconcile(dataSource: DataSource, pricing: PricingService, month: string): Promise<Reconciliation> {
  const { from, to } = monthBounds(month);
  const [{ latest }] = await dataSource.query<Array<{ latest: Date | null }>>(
    `SELECT max("hour") AS "latest" FROM "rating_runs" WHERE "hour" >= $1 AND "hour" < $2`,
    [from, to],
  );
  if (!latest) return { month, ratedUntil: null, accounts: [] };
  const ratedUntil = new Date(latest.getTime() + HOUR_MS);
  const rows = await dataSource.query<Array<{ account_id: string; charged: string | null; rated_requests: string | null; raw_requests: string | null }>>(
    `WITH charged AS (SELECT "account_id", sum("amount_minor") AS "charged" FROM "usage_charges"
                       WHERE "hour" >= $1 AND "hour" < $2 GROUP BY "account_id"),
          rated AS (SELECT "account_id", sum("on_demand_requests" + "provisioned_requests") AS "requests" FROM "usage_hourly"
                     WHERE "hour" >= $1 AND "hour" < $2 GROUP BY "account_id"),
          raw AS (SELECT "account_id", count(*) AS "requests" FROM "usage_records"
                   WHERE "started_at" >= $1 AND "started_at" < $2 AND ${BILLED_CALL} GROUP BY "account_id"),
          sampled AS (SELECT DISTINCT "account_id" FROM "capacity_samples" WHERE "minute" >= $1 AND "minute" < $2)
     SELECT a."account_id", charged."charged"::text AS "charged", rated."requests"::text AS "rated_requests", raw."requests"::text AS "raw_requests"
       FROM (SELECT "account_id" FROM charged UNION SELECT "account_id" FROM rated UNION SELECT "account_id" FROM raw
             UNION SELECT "account_id" FROM sampled) a
       LEFT JOIN charged ON charged."account_id" = a."account_id"
       LEFT JOIN rated ON rated."account_id" = a."account_id"
       LEFT JOIN raw ON raw."account_id" = a."account_id"
      ORDER BY a."account_id"`,
    [from, ratedUntil],
  );
  const accounts: ReconciledAccount[] = [];
  for (const row of rows) {
    const estimate = await pricing.estimate(row.account_id, month, undefined, ratedUntil);
    if (!estimate) continue;
    accounts.push({
      accountId: row.account_id,
      currency: estimate.currency,
      exponent: estimate.exponent,
      chargedMinor: BigInt(row.charged ?? '0'),
      estimatedMinor: toMinor(estimate.total, estimate.exponent),
      ratedRequests: BigInt(row.rated_requests ?? '0'),
      rawRequests: BigInt(row.raw_requests ?? '0'),
    });
  }
  return { month, ratedUntil, accounts };
}

function verdict(accounts: number, different: number): string {
  if (accounts === 0) return 'No account used anything.';
  if (different === 0) return accounts === 1 ? 'The account agrees.' : `All ${accounts} accounts agree.`;
  return accounts === 1 ? 'The account differs.' : `${different} of ${accounts} accounts ${different === 1 ? 'differs' : 'differ'}.`;
}

/** The reconciliation as a table to read, one line per account, the differences marked. */
export function formatReconciliation({ month, ratedUntil, accounts }: Reconciliation): string {
  if (!ratedUntil) return `No hour of ${month} is rated yet.`;
  const header = ['Account', 'Charged', 'From usage', 'Requests rated', 'Requests used', ''];
  const lines = accounts.map((account) => [
    account.accountId,
    `${formatMinor(account.chargedMinor, account.exponent)} ${account.currency}`,
    `${formatMinor(account.estimatedMinor, account.exponent)} ${account.currency}`,
    account.ratedRequests.toLocaleString('en-US'),
    account.rawRequests.toLocaleString('en-US'),
    reconciled(account) ? 'ok' : 'DIFFERENT',
  ]);
  const widths = header.map((title, column) => Math.max(title.length, ...lines.map((line) => line[column].length)));
  const row = (cells: string[]) =>
    cells
      .map((cell, column) => (column === 0 || column === cells.length - 1 ? cell.padEnd(widths[column]) : cell.padStart(widths[column])))
      .join('  ')
      .trimEnd();
  const different = accounts.filter((account) => !reconciled(account)).length;
  return [
    `${month} until ${ratedUntil.toISOString()} (the end of the last hour rated):`,
    '',
    row(header),
    ...lines.map(row),
    '',
    verdict(accounts.length, different),
  ].join('\n');
}

import { DataSource, EntityManager } from 'typeorm';

const DAY_MS = 24 * 60 * 60 * 1000;

/** One account's day (UTC): the capacity FF held for it, against what it was billed (client-readiness plan, P-21, D8). */
export interface CapacityDay {
  /** YYYY-MM-DD, by the UTC calendar. */
  day: string;
  accountId: string;
  /** Ready instances × memory, a minute per sample: what FF's servers held. */
  reservedGbS: number;
  /** minInstances × memory, a minute per sample: what D8 bills at the provisioned price. */
  provisionedGbS: number;
  /** Billed duration × memory, from the usage records (D7). */
  billedGbS: number;
  /** Requests billed (D7): successes, errors and timeouts. */
  requests: number;
}

/**
 * Every account's days with capacity or usage, from `from` (included) to
 * `to` (excluded), oldest first. GB-s counts 1,024 MB as 1 GB, as Lambda does,
 * and is rounded to the thousandth.
 */
export async function capacityReport(db: DataSource | EntityManager, from: Date, to: Date): Promise<CapacityDay[]> {
  const rows = await db.query<
    Array<{ day: string; account_id: string; reserved: string; provisioned: string; billed: string; requests: string }>
  >(
    `WITH "capacity" AS (
       SELECT "account_id", to_char("minute" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "day",
              sum("instances" * "memory_mb")::numeric * 60 / 1024 AS "reserved",
              sum("min_instances" * "memory_mb")::numeric * 60 / 1024 AS "provisioned"
         FROM "capacity_samples" WHERE "minute" >= $1 AND "minute" < $2 GROUP BY 1, 2),
     "usage" AS (
       SELECT "account_id", to_char("started_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "day",
              sum("billed_ms"::numeric * "memory_mb") / 1000 / 1024 AS "billed",
              count(*) FILTER (WHERE "status" IN ('success', 'error', 'timeout')) AS "requests"
         FROM "usage_records" WHERE "started_at" >= $1 AND "started_at" < $2 GROUP BY 1, 2)
     SELECT coalesce(c."day", u."day") AS "day", coalesce(c."account_id", u."account_id") AS "account_id",
            round(coalesce(c."reserved", 0), 3) AS "reserved", round(coalesce(c."provisioned", 0), 3) AS "provisioned",
            round(coalesce(u."billed", 0), 3) AS "billed", coalesce(u."requests", 0) AS "requests"
       FROM "capacity" c FULL JOIN "usage" u ON u."account_id" = c."account_id" AND u."day" = c."day"
      ORDER BY 1, 2`,
    [from, to],
  );
  return rows.map((row) => ({
    day: row.day,
    accountId: row.account_id,
    reservedGbS: Number(row.reserved),
    provisionedGbS: Number(row.provisioned),
    billedGbS: Number(row.billed),
    requests: Number(row.requests),
  }));
}

/** The last `days` UTC days, today included: from the first one's midnight to tomorrow's. */
export function reportWindow(now: Date, days: number): { from: Date; to: Date } {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return { from: new Date(to.getTime() - days * DAY_MS), to };
}

/** `--days N` (1 to 366), 7 without it. */
export function parseReportArgs(argv: string[]): { days: number } {
  if (argv.length === 0) return { days: 7 };
  const [flag, value, ...rest] = argv;
  const days = Number(value);
  if (flag !== '--days' || rest.length > 0 || !Number.isInteger(days) || days < 1 || days > 366) {
    throw new Error(`Usage: npm run capacity:report -- [--days N], N from 1 to 366; got "${argv.join(' ')}"`);
  }
  return { days };
}

const gbS = (value: number) => value.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
/** How many times the billed GB-s the reserved ones are: D8's cost gap. */
function gap(reserved: number, billed: number): string {
  if (billed === 0) return reserved === 0 ? '–' : 'nothing billed';
  const ratio = reserved / billed;
  return `${ratio.toLocaleString('en-US', { maximumFractionDigits: ratio < 10 ? 1 : 0 })}×`;
}

/** The report as a table, with a total line. */
export function formatCapacityReport(rows: CapacityDay[]): string {
  if (rows.length === 0) return 'No capacity samples or usage records in these days.';
  const total = rows.reduce(
    (sum, row) => ({
      reservedGbS: sum.reservedGbS + row.reservedGbS,
      provisionedGbS: sum.provisionedGbS + row.provisionedGbS,
      billedGbS: sum.billedGbS + row.billedGbS,
      requests: sum.requests + row.requests,
    }),
    { reservedGbS: 0, provisionedGbS: 0, billedGbS: 0, requests: 0 },
  );
  const line = (day: string, account: string, row: Omit<CapacityDay, 'day' | 'accountId'>) => [
    day,
    account,
    gbS(row.reservedGbS),
    gbS(row.provisionedGbS),
    gbS(row.billedGbS),
    row.requests.toLocaleString('en-US'),
    gap(row.reservedGbS, row.billedGbS),
  ];
  const table = [
    ['Day (UTC)', 'Account', 'Reserved GB-s', 'Provisioned GB-s', 'Billed GB-s', 'Requests', 'Reserved ÷ billed'],
    ...rows.map((row) => line(row.day, row.accountId, row)),
    line('Total', '', total),
  ];
  const widths = table[0].map((_, column) => Math.max(...table.map((cells) => cells[column].length)));
  // Text columns to the left, numbers to the right.
  return table
    .map((cells) => cells.map((cell, column) => (column < 2 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join('  '))
    .join('\n');
}

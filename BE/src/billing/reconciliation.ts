import { DataSource } from 'typeorm';
import { Decimal } from './decimal';
import { HOUR_MS } from './rating-hours';
import { formatMinor, toMinor } from './money';
import { BYTES_PER_GB } from './rating';
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
  /** Customers' databases' and buckets' storage, in byte-hours, as resource_usage_hourly sums it and as their hourly samples do. */
  ratedByteHours: bigint;
  sampledByteHours: bigint;
  /** Buckets' requests that S3 bills, its two classes together, as resource_usage_hourly sums them and as the front door counted them. */
  ratedStorageRequests: bigint;
  countedStorageRequests: bigint;
  /** Queues' requests that SQS bills, as resource_usage_hourly sums them and as they were counted. */
  ratedQueueRequests: bigint;
  countedQueueRequests: bigint;
  /** Mail's recipients that SES bills, as resource_usage_hourly sums them and as the messages' billing records count them. */
  ratedEmailRecipients: bigint;
  countedEmailRecipients: bigint;
}

export interface Reconciliation {
  month: string;
  /** The end of the month's last hour rated; null before the first. */
  ratedUntil: Date | null;
  accounts: ReconciledAccount[];
}

/** Whether an account's charges and its usage agree: the parent's criterion, rated usage equals raw usage (B-01), calls, storage, buckets' and queues' requests, mail's recipients. */
export const reconciled = (account: ReconciledAccount): boolean =>
  account.chargedMinor === account.estimatedMinor &&
  account.ratedRequests === account.rawRequests &&
  account.ratedByteHours === account.sampledByteHours &&
  account.ratedStorageRequests === account.countedStorageRequests &&
  account.ratedQueueRequests === account.countedQueueRequests &&
  account.ratedEmailRecipients === account.countedEmailRecipients;

/**
 * A month's charges against its raw usage (P-32): per account, what the
 * hourly rating charged, against the month to the end of the last hour rated
 * as P-30's estimate prices it from the usage records and samples, the
 * databases', buckets' and caches' hourly samples, the buckets' and queues' request
 * counts and the account's messages too. They differ only if usage reached the database after its hour
 * was rated: a call's record later than its hour's settle time.
 */
export async function reconcile(dataSource: DataSource, pricing: PricingService, month: string): Promise<Reconciliation> {
  const { from, to } = monthBounds(month);
  const [{ latest }] = await dataSource.query<Array<{ latest: Date | null }>>(
    `SELECT max("hour") AS "latest" FROM "rating_runs" WHERE "hour" >= $1 AND "hour" < $2`,
    [from, to],
  );
  if (!latest) return { month, ratedUntil: null, accounts: [] };
  const ratedUntil = new Date(latest.getTime() + HOUR_MS);
  const rows = await dataSource.query<
    Array<{
      account_id: string;
      charged: string | null;
      rated_requests: string | null;
      raw_requests: string | null;
      rated_storage: string | null;
      sampled_storage: string | null;
      rated_s3: string | null;
      counted_s3: string | null;
      rated_sqs: string | null;
      counted_sqs: string | null;
      rated_mail: string | null;
      counted_mail: string | null;
    }>
  >(
    `WITH charged AS (SELECT "account_id", sum("amount_minor") AS "charged" FROM "usage_charges"
                       WHERE "hour" >= $1 AND "hour" < $2 GROUP BY "account_id"),
          rated AS (SELECT "account_id", sum("on_demand_requests" + "provisioned_requests") AS "requests" FROM "usage_hourly"
                     WHERE "hour" >= $1 AND "hour" < $2 GROUP BY "account_id"),
          raw AS (SELECT "account_id", count(*) AS "requests" FROM "usage_records"
                   WHERE "started_at" >= $1 AND "started_at" < $2 AND ${BILLED_CALL} GROUP BY "account_id"),
          sampled AS (SELECT DISTINCT "account_id" FROM "capacity_samples" WHERE "minute" >= $1 AND "minute" < $2),
          stored AS (SELECT "account_id", sum("byte_hours") AS "byte_hours", sum("tier1_requests" + "tier2_requests") AS "s3",
                            sum("requests") FILTER (WHERE "kind" <> 'email') AS "sqs", sum("requests") FILTER (WHERE "kind" = 'email') AS "mail"
                       FROM "resource_usage_hourly" WHERE "hour" >= $1 AND "hour" < $2 GROUP BY "account_id"),
          measured AS (SELECT "account_id", sum("size_bytes") AS "byte_hours" FROM
                         (SELECT "account_id", "size_bytes" FROM "database_samples" WHERE "hour" >= $1 AND "hour" < $2
                          UNION ALL SELECT "account_id", "size_bytes" FROM "bucket_samples" WHERE "hour" >= $1 AND "hour" < $2
                          UNION ALL SELECT "account_id", "memory_mb"::bigint * 1048576 FROM "cache_samples" WHERE "hour" >= $1 AND "hour" < $2) samples
                        GROUP BY "account_id"),
          counted AS (SELECT "account_id", sum("requests") AS "s3" FROM "storage_request_counts"
                       WHERE "minute" >= $1 AND "minute" < $2 AND "class" <> 'free' GROUP BY "account_id"),
          queued AS (SELECT "account_id", sum("requests") AS "sqs" FROM "queue_request_counts"
                      WHERE "minute" >= $1 AND "minute" < $2 GROUP BY "account_id" HAVING sum("requests") > 0),
          mailed AS (SELECT "account_id", sum("recipients") AS "mail" FROM "email_sends"
                      WHERE "sent_at" >= $1 AND "sent_at" < $2 GROUP BY "account_id")
     SELECT a."account_id", charged."charged"::text AS "charged", rated."requests"::text AS "rated_requests", raw."requests"::text AS "raw_requests",
            stored."byte_hours"::text AS "rated_storage", measured."byte_hours"::text AS "sampled_storage",
            stored."s3"::text AS "rated_s3", counted."s3"::text AS "counted_s3", stored."sqs"::text AS "rated_sqs", queued."sqs"::text AS "counted_sqs",
            stored."mail"::text AS "rated_mail", mailed."mail"::text AS "counted_mail"
       FROM (SELECT "account_id" FROM charged UNION SELECT "account_id" FROM rated UNION SELECT "account_id" FROM raw
             UNION SELECT "account_id" FROM sampled UNION SELECT "account_id" FROM stored UNION SELECT "account_id" FROM measured
             UNION SELECT "account_id" FROM counted UNION SELECT "account_id" FROM queued UNION SELECT "account_id" FROM mailed) a
       LEFT JOIN charged ON charged."account_id" = a."account_id"
       LEFT JOIN rated ON rated."account_id" = a."account_id"
       LEFT JOIN raw ON raw."account_id" = a."account_id"
       LEFT JOIN stored ON stored."account_id" = a."account_id"
       LEFT JOIN measured ON measured."account_id" = a."account_id"
       LEFT JOIN counted ON counted."account_id" = a."account_id"
       LEFT JOIN queued ON queued."account_id" = a."account_id"
       LEFT JOIN mailed ON mailed."account_id" = a."account_id"
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
      ratedByteHours: BigInt(row.rated_storage ?? '0'),
      sampledByteHours: BigInt(row.sampled_storage ?? '0'),
      ratedStorageRequests: BigInt(row.rated_s3 ?? '0'),
      countedStorageRequests: BigInt(row.counted_s3 ?? '0'),
      ratedQueueRequests: BigInt(row.rated_sqs ?? '0'),
      countedQueueRequests: BigInt(row.counted_sqs ?? '0'),
      ratedEmailRecipients: BigInt(row.rated_mail ?? '0'),
      countedEmailRecipients: BigInt(row.counted_mail ?? '0'),
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
  const gbHours = (byteHours: bigint) => {
    const [whole, fraction] = Decimal.ratio(byteHours, BYTES_PER_GB).toFixed(3).split('.');
    return `${BigInt(whole).toLocaleString('en-US')}.${fraction}`;
  };
  const header = ['Account', 'Charged', 'From usage', 'Requests rated', 'Requests used', 'GB-h rated', 'GB-h sampled', 'S3 requests rated', 'S3 requests counted', 'SQS requests rated', 'SQS requests counted', 'Recipients rated', 'Recipients sent', ''];
  const lines = accounts.map((account) => [
    account.accountId,
    `${formatMinor(account.chargedMinor, account.exponent)} ${account.currency}`,
    `${formatMinor(account.estimatedMinor, account.exponent)} ${account.currency}`,
    account.ratedRequests.toLocaleString('en-US'),
    account.rawRequests.toLocaleString('en-US'),
    gbHours(account.ratedByteHours),
    gbHours(account.sampledByteHours),
    account.ratedStorageRequests.toLocaleString('en-US'),
    account.countedStorageRequests.toLocaleString('en-US'),
    account.ratedQueueRequests.toLocaleString('en-US'),
    account.countedQueueRequests.toLocaleString('en-US'),
    account.ratedEmailRecipients.toLocaleString('en-US'),
    account.countedEmailRecipients.toLocaleString('en-US'),
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

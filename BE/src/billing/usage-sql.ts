import type { ResourceUsage } from './rating';

/**
 * How billed usage is summed in SQL (D7, D8): the same expressions for the
 * month's estimate (P-30) and the hourly rating (P-32), so the two never
 * count a call or a minute differently. Each selects camelCase columns.
 */

/** The calls D7 bills: those that ran. Throttled, lost and the platform's failures are free. */
export const BILLED_CALL = `"status" IN ('success', 'error', 'timeout')`;

/** A billed call's MB-ms: its billed ms, raised to the book's minimum billed duration (the parameter `minimum`), times its memory. */
const callMbMs = (minimum: string) => `GREATEST("billed_ms", ${minimum})::bigint * "memory_mb"`;

/** Over billed calls: those without provisioned concurrency and those with it (D8), each counted, and their MB-ms. */
export const callSums = (minimum: string): string =>
  [
    `count(*) FILTER (WHERE "min_instances" = 0) AS "onDemandRequests"`,
    `coalesce(sum(${callMbMs(minimum)}) FILTER (WHERE "min_instances" = 0), 0) AS "onDemandMbMs"`,
    `count(*) FILTER (WHERE "min_instances" > 0) AS "provisionedRequests"`,
    `coalesce(sum(${callMbMs(minimum)}) FILTER (WHERE "min_instances" > 0), 0) AS "provisionedMbMs"`,
  ].join(', ');

/** Over minute samples (P-21): the minInstances that were ready, held at the provisioned price, and the ready instances above them. */
export const SAMPLE_SUMS = [
  `sum(LEAST("instances", "min_instances")::bigint * "memory_mb" * 60000) AS "provisionedTimeMbMs"`,
  `sum(GREATEST("instances" - "min_instances", 0)::bigint * "memory_mb" * 60000) AS "reservedMbMs"`,
].join(', ');

/** A database's, bucket's, queue's or cache's rated hours with one book, or a domain's or address's mail, summed, as RESOURCE_SUMS selects them. */
export interface ResourceRow {
  resourceId: string;
  kind: 'database' | 'bucket' | 'queue' | 'cache' | 'email';
  priceBookId: string;
  byteHours: string;
  hours: string;
  tier1: string;
  tier2: string;
  requests: string;
  bytes: string;
}

/** Over resource_usage_hourly, grouped by "resource_id", "kind" and "price_book_id": the hourly rating's sums and the statement's alike. */
export const RESOURCE_SUMS = [
  `"resource_id" AS "resourceId"`,
  `"kind"`,
  `"price_book_id" AS "priceBookId"`,
  `sum("byte_hours")::text AS "byteHours"`,
  `sum("hours")::text AS "hours"`,
  `sum("tier1_requests")::text AS "tier1"`,
  `sum("tier2_requests")::text AS "tier2"`,
  `sum("requests")::text AS "requests"`,
  `sum("bytes")::text AS "bytes"`,
].join(', ');

/** The same, as the rater takes them. */
export const resourceUsage = (row: ResourceRow): ResourceUsage => ({
  resourceId: row.resourceId,
  kind: row.kind,
  byteHours: BigInt(row.byteHours),
  hours: BigInt(row.hours),
  tier1Requests: BigInt(row.tier1),
  tier2Requests: BigInt(row.tier2),
  requests: BigInt(row.requests),
  bytes: BigInt(row.bytes),
});

/**
 * Mail's resource in resource_usage_hourly, one for each domain or address an
 * account sends from (ADR 0012): a UUID of its own, made of the account and
 * the identity, as the hourly rating and the month's estimate both name it.
 */
export const EMAIL_RESOURCE_ID = `md5('email:' || "account_id" || ':' || "identity")::uuid`;

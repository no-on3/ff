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

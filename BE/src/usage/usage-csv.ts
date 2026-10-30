import { csvField, csvLines } from '../common/csv';
import { MonthlyUsageView } from './usage.dto';

export { csvField, wantsCsv } from '../common/csv';

const COLUMNS = [
  'kind',
  'id',
  'name',
  'deleted',
  'requests',
  'billed_ms',
  'gb_seconds',
  'gb_months',
  'tier1_requests',
  'tier2_requests',
  'bytes_downloaded',
  'bytes_uploaded',
  'attachment_bytes',
  'throttled',
  'platform_errors',
  'lost',
  'cost',
] as const;

/**
 * GET /usage as CSV (P-22): a header, then one line per function, then one
 * per database, one per bucket, one per queue, one per cache and one per
 * domain or address the account's mail went from, each with its cost, and the
 * columns that aren't its kind's left empty: a queue's requests are SQS's, in
 * the requests column; a cache's memory held is in the GB-months column; mail's
 * recipients are in the requests column. No total line, which a spreadsheet's
 * sum would count twice.
 */
export function usageCsv(view: MonthlyUsageView): string {
  // Each line by its columns' names; those it doesn't name are left empty.
  const line = (fields: Partial<Record<(typeof COLUMNS)[number], string>>) => COLUMNS.map((column) => fields[column] ?? '');
  const common = (kind: string, id: string, name: string, deleted: boolean, cost: string | null) => ({
    kind,
    id: csvField(id),
    name: csvField(name, true),
    deleted: csvField(deleted),
    cost: csvField(cost),
  });
  const functions = view.functions.map((usage) =>
    line({
      ...common('function', usage.functionId, usage.functionName, usage.deleted, usage.cost),
      requests: csvField(usage.requests),
      billed_ms: csvField(usage.billedMs),
      gb_seconds: csvField(usage.gbSeconds),
      throttled: csvField(usage.throttled),
      platform_errors: csvField(usage.platformErrors),
      lost: csvField(usage.lost),
    }),
  );
  const databases = view.databases.map((usage) => line({ ...common('database', usage.databaseId, usage.name, usage.deleted, usage.cost), gb_months: csvField(usage.gbMonths) }));
  const buckets = view.buckets.map((usage) =>
    line({
      ...common('bucket', usage.bucketId, usage.name, usage.deleted, usage.cost),
      gb_months: csvField(usage.gbMonths),
      tier1_requests: csvField(usage.tier1Requests),
      tier2_requests: csvField(usage.tier2Requests),
      bytes_downloaded: csvField(usage.bytesDownloaded),
      bytes_uploaded: csvField(usage.bytesUploaded),
    }),
  );
  const queues = view.queues.map((usage) => line({ ...common('queue', usage.queueId, usage.name, usage.deleted, usage.cost), requests: csvField(usage.requests) }));
  const caches = view.caches.map((usage) => line({ ...common('cache', usage.cacheId, usage.name, usage.deleted, usage.cost), gb_months: csvField(usage.gbMonths) }));
  const email = view.email.map((usage) =>
    line({
      ...common('email', usage.resourceId, usage.identity, usage.deleted, usage.cost),
      requests: csvField(usage.recipients),
      attachment_bytes: csvField(usage.attachmentBytes),
    }),
  );
  return csvLines([[...COLUMNS], ...functions, ...databases, ...buckets, ...queues, ...caches, ...email]);
}

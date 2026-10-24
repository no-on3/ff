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
  'throttled',
  'platform_errors',
  'lost',
  'cost',
];

/**
 * GET /usage as CSV (P-22): a header, then one line per function, then one
 * per database, one per bucket and one per queue, each with its cost, and the
 * columns that aren't its kind's left empty: a queue's requests are SQS's, in
 * the requests column. No total line, which a spreadsheet's sum would count
 * twice.
 */
export function usageCsv(view: MonthlyUsageView): string {
  const functions = view.functions.map((usage) => [
    'function',
    csvField(usage.functionId),
    csvField(usage.functionName, true),
    csvField(usage.deleted),
    csvField(usage.requests),
    csvField(usage.billedMs),
    csvField(usage.gbSeconds),
    '',
    '',
    '',
    '',
    '',
    csvField(usage.throttled),
    csvField(usage.platformErrors),
    csvField(usage.lost),
    csvField(usage.cost),
  ]);
  const databases = view.databases.map((usage) => [
    'database',
    csvField(usage.databaseId),
    csvField(usage.name, true),
    csvField(usage.deleted),
    '',
    '',
    '',
    csvField(usage.gbMonths),
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    csvField(usage.cost),
  ]);
  const buckets = view.buckets.map((usage) => [
    'bucket',
    csvField(usage.bucketId),
    csvField(usage.name, true),
    csvField(usage.deleted),
    '',
    '',
    '',
    csvField(usage.gbMonths),
    csvField(usage.tier1Requests),
    csvField(usage.tier2Requests),
    csvField(usage.bytesDownloaded),
    csvField(usage.bytesUploaded),
    '',
    '',
    '',
    csvField(usage.cost),
  ]);
  const queues = view.queues.map((usage) => [
    'queue',
    csvField(usage.queueId),
    csvField(usage.name, true),
    csvField(usage.deleted),
    csvField(usage.requests),
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    csvField(usage.cost),
  ]);
  return csvLines([COLUMNS, ...functions, ...databases, ...buckets, ...queues]);
}

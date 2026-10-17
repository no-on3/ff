import { csvField, csvLines } from '../common/csv';
import { MonthlyUsageView } from './usage.dto';

export { csvField, wantsCsv } from '../common/csv';

const COLUMNS = ['function_id', 'function_name', 'deleted', 'requests', 'billed_ms', 'gb_seconds', 'throttled', 'platform_errors', 'lost'];

/**
 * GET /usage as CSV (P-22): a header, then one line per function. No total
 * line, which a spreadsheet's sum would count twice.
 */
export function usageCsv(view: MonthlyUsageView): string {
  const lines = view.functions.map((usage) => [
    csvField(usage.functionId),
    csvField(usage.functionName, true),
    csvField(usage.deleted),
    csvField(usage.requests),
    csvField(usage.billedMs),
    csvField(usage.gbSeconds),
    csvField(usage.throttled),
    csvField(usage.platformErrors),
    csvField(usage.lost),
  ]);
  return csvLines([COLUMNS, ...lines]);
}

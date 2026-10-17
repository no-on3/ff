import { MonthlyUsageView } from './usage.dto';

const COLUMNS = ['function_id', 'function_name', 'deleted', 'requests', 'billed_ms', 'gb_seconds', 'throttled', 'platform_errors', 'lost'];

/**
 * One CSV field (RFC 4180): quoted when it holds a comma, a quote or a line
 * break. Free text that a spreadsheet would run as a formula (=, +, -, @, a
 * tab or a carriage return first) gets a leading apostrophe, as OWASP advises.
 */
export function csvField(value: string | number | boolean, freeText = false): string {
  let text = String(value);
  if (freeText && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * GET /usage as CSV (P-22): a header, then one line per function. No total
 * line, which a spreadsheet's sum would count twice.
 */
export function usageCsv(view: MonthlyUsageView): string {
  const lines = view.functions.map((usage) =>
    [
      csvField(usage.functionId),
      csvField(usage.functionName, true),
      csvField(usage.deleted),
      csvField(usage.requests),
      csvField(usage.billedMs),
      csvField(usage.gbSeconds),
      csvField(usage.throttled),
      csvField(usage.platformErrors),
      csvField(usage.lost),
    ].join(','),
  );
  return [COLUMNS.join(','), ...lines].map((line) => `${line}\r\n`).join('');
}

/** Whether the caller asked for CSV. */
export const wantsCsv = (accept: string | undefined): boolean => /\btext\/csv\b/i.test(accept ?? '');

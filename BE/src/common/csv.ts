/**
 * One CSV field (RFC 4180): quoted when it holds a comma, a quote or a line
 * break. Free text that a spreadsheet would run as a formula (=, +, -, @, a
 * tab or a carriage return first) gets a leading apostrophe, as OWASP advises.
 */
export function csvField(value: string | number | boolean | null, freeText = false): string {
  let text = value === null ? '' : String(value);
  if (freeText && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV lines, each ended with CRLF (RFC 4180). */
export const csvLines = (lines: string[][]): string => lines.map((fields) => `${fields.join(',')}\r\n`).join('');

/** Whether the caller asked for CSV. */
export const wantsCsv = (accept: string | undefined): boolean => /\btext\/csv\b/i.test(accept ?? '');

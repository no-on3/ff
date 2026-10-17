/**
 * Days in Tunisia (P-36): an invoice is dated there, and its fiscal year is
 * that day's year. Usage months stay UTC, as everywhere else (D6).
 */
const DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The day in Tunisia at an instant, YYYY-MM-DD. */
export const tunisDay = (at: Date): string => DAY.format(at);

/** A month, YYYY-MM, such as a usage month or the month an invoice closes. */
export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The month before, YYYY-MM. */
export function previousMonth(month: string): string {
  const [year, number] = month.split('-').map(Number);
  return number === 1 ? `${year - 1}-12` : `${year}-${String(number - 1).padStart(2, '0')}`;
}

/** A month's last day, YYYY-MM-DD. */
export function lastDay(month: string): string {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
}

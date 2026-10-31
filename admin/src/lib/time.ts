/** When something happened, in UTC like the filters, the CSV and FF's months: "2026-10-17 10:13:11 UTC". */
export function whenUtc(at: string): string {
  const iso = new Date(at).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

const TUNIS_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The day in Tunisia at an instant, YYYY-MM-DD: a bank statement's, as the API dates transfers and invoices. */
export const tunisDay = (at: Date): string => TUNIS_DAY.format(at);

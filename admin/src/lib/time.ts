/** When something happened, in UTC like the filters, the CSV and FF's months: "2026-10-17 10:13:11 UTC". */
export function whenUtc(at: string): string {
  const iso = new Date(at).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

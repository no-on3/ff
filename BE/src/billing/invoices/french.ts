/**
 * Amounts, dates and numbers as the invoices write them, in French (P-36):
 * "1 234,500 TND", "1er octobre 2026". The no-break space is U+00A0, which the
 * PDF's standard fonts have, unlike the narrow one French typesetting prefers.
 */
const NBSP = '\u00a0';
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** Digits in groups of three: "1 234 567". */
export const groupDigits = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);

/** An amount in minor units: "1 234,500 TND", "-0,250 TND". */
export function frenchMoney(minor: bigint, exponent: number, currency: string): string {
  const sign = minor < 0n ? '-' : '';
  const digits = (minor < 0n ? -minor : minor).toString().padStart(exponent + 1, '0');
  const whole = exponent === 0 ? digits : digits.slice(0, -exponent);
  const fraction = exponent === 0 ? '' : `,${digits.slice(-exponent)}`;
  return `${sign}${groupDigits(whole)}${fraction}${NBSP}${currency}`;
}

/** A decimal written with a point, as the API writes GB-seconds: "1234.5678" is "1 234,5678". */
export function frenchDecimal(text: string): string {
  const [whole, fraction] = text.split('.');
  return `${groupDigits(whole)}${fraction === undefined ? '' : `,${fraction}`}`;
}

/** A day, YYYY-MM-DD: "17 octobre 2026", "1er octobre 2026". */
export function frenchDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return `${date === 1 ? '1er' : date} ${MONTHS[month - 1]} ${year}`;
}

/** A month, YYYY-MM: "octobre 2026". */
export function frenchMonth(month: string): string {
  const [year, number] = month.split('-').map(Number);
  return `${MONTHS[number - 1]} ${year}`;
}

/** "19 %": a percent, with French typesetting's space before the sign. */
export const frenchPercent = (percent: number): string => `${percent}${NBSP}%`;

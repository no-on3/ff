import { Decimal } from './decimal';

/**
 * Money, as the ledger keeps it (P-31, parent §8.3): whole minor units of a
 * currency, as bigint from the database to the API, never a float. TND has
 * three decimals, the millime; the exponent is the currency's
 * (currencies.exponent), never a constant. The API writes money as a string
 * with every decimal of the currency: "8.222".
 */

/** An exact amount in minor units, rounded once, half away from zero: 8.221880704 TND is 8222n millimes. */
export const toMinor = (amount: Decimal, exponent: number): bigint => amount.unitsAt(exponent);

/** Minor units to read, with every decimal: 8222n is "8.222"; -500n is "-0.500". Exact: the divisor is a power of ten. */
export const formatMinor = (minor: bigint, exponent: number): string => Decimal.ratio(minor, 10n ** BigInt(exponent)).toFixed(exponent);

/**
 * An amount as someone types it, in minor units, exactly: "50", "50.5" and
 * "50.500" are 50500n millimes. More decimals than the currency has are
 * refused, not rounded: "0.0005" TND is no whole number of millimes.
 */
export function parseMinor(text: string, exponent: number): bigint {
  const match = /^-?\d+(?:\.(\d+))?$/.exec(text);
  if (!match || (match[1] ?? '').length > exponent) {
    const decimals = `${exponent} decimal${exponent === 1 ? '' : 's'}`;
    throw new Error(`"${text}" is not an amount with ${decimals} at most, such as ${formatMinor(50n * 10n ** BigInt(exponent), exponent)}`);
  }
  return Decimal.parse(text).unitsAt(exponent);
}

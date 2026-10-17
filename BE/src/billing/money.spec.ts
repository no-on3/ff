/**
 * L1: money in minor units (client-readiness plan, P-31, parent §8.3): an
 * exact amount rounded once to the currency's minor unit, and written or read
 * with its decimals, never through a float.
 */
import { Decimal } from './decimal';
import { formatMinor, parseMinor, toMinor } from './money';

const d = (text: string) => Decimal.parse(text);

describe('money (L1, P-31)', () => {
  it('rounds an exact amount once to minor units, half away from zero: what a debit takes', () => {
    expect(toMinor(d('8.221880704'), 3)).toBe(8222n); // AWS's first example, in TND (P-30)
    expect(toMinor(d('60.047633152'), 3)).toBe(60048n);
    expect(toMinor(d('0.0005'), 3)).toBe(1n);
    expect(toMinor(d('0.000499999'), 3)).toBe(0n);
    expect(toMinor(d('-0.0005'), 3)).toBe(-1n);
    expect(toMinor(d('7'), 3)).toBe(7000n);
    expect(toMinor(d('2.5'), 0)).toBe(3n);
  });

  it('rounds the total once, not each part: three calls of 0.0004 TND are 1 millime, not 0', () => {
    const calls = [d('0.0004'), d('0.0004'), d('0.0004')];
    expect(toMinor(calls.reduce((sum, call) => sum.plus(call)), 3)).toBe(1n);
    expect(calls.map((call) => toMinor(call, 3)).reduce((sum, minor) => sum + minor)).toBe(0n);
  });

  it('writes minor units with every decimal of the currency, a debt with its sign', () => {
    expect(formatMinor(8222n, 3)).toBe('8.222');
    expect(formatMinor(5n, 3)).toBe('0.005');
    expect(formatMinor(0n, 3)).toBe('0.000');
    expect(formatMinor(-500n, 3)).toBe('-0.500');
    expect(formatMinor(-1250n, 2)).toBe('-12.50');
    expect(formatMinor(42n, 0)).toBe('42');
    // Past 2^53, where a JavaScript number would lose the millimes.
    expect(formatMinor(9007199254740993n, 3)).toBe('9007199254740.993');
  });

  it('reads an amount as typed, up to the currency’s decimals, exactly', () => {
    expect(['50', '50.5', '50.500', '0.001', '-1.25'].map((text) => parseMinor(text, 3))).toEqual([50000n, 50500n, 50500n, 1n, -1250n]);
    expect(parseMinor('9007199254740.993', 3)).toBe(9007199254740993n);
    expect(parseMinor('42', 0)).toBe(42n);
    for (const text of ['0.0005', '1e3', '50,000', ' 50', '', '.5', '5.', '+5']) {
      expect(() => parseMinor(text, 3)).toThrow(`"${text}" is not an amount with 3 decimals at most, such as 50.000`);
    }
    expect(() => parseMinor('1.5', 0)).toThrow('"1.5" is not an amount with 0 decimals at most, such as 50');
  });

  it('reads back what it writes', () => {
    for (const minor of [0n, 1n, -1n, 999n, 1000n, -123456789n]) expect(parseMinor(formatMinor(minor, 3), 3)).toBe(minor);
  });
});

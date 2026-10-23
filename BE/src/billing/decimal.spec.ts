/**
 * L1: exact decimals (client-readiness plan, P-30): what prices, GB-seconds
 * and money are computed with. A float would give 0.1 + 0.2 = 0.30000000000000004.
 */
import { Decimal } from './decimal';

const d = (text: string) => Decimal.parse(text);

describe('Decimal (L1, P-30)', () => {
  it('adds, subtracts and multiplies exactly', () => {
    expect(d('0.1').plus(d('0.2')).toString()).toBe('0.3');
    expect(d('1').minus(d('0.0000166667')).toString()).toBe('0.9999833333');
    expect(d('0.0000166667').times(d('3.0080')).toString()).toBe('0.0000501334336');
    expect(d('-2.5').times(d('-2')).toString()).toBe('5');
  });

  it('divides by powers of 2 and 5 exactly, as MB-ms per GB-s and per million requests do, and refuses anything else', () => {
    expect(Decimal.ratio(1n, 1_024_000n).toString()).toBe('0.0000009765625');
    expect(Decimal.ratio(460_800_000_000n, 1_024_000n).toString()).toBe('450000');
    expect(Decimal.ratio(3n, 1_000_000n).toString()).toBe('0.000003');
    expect(() => Decimal.ratio(1n, 3n)).toThrow('1/3 has no finite decimal form');
    expect(() => Decimal.ratio(1n, 0n)).toThrow('Cannot divide by 0');
  });

  it('divides by anything to a number of places, half away from zero, for a quantity with no finite decimal form', () => {
    expect(Decimal.quotient(200n, 744n, 12).toString()).toBe('0.268817204301');
    expect(Decimal.quotient(1n, 3n, 2).toString()).toBe('0.33');
    expect(Decimal.quotient(2n, 3n, 2).toString()).toBe('0.67');
    expect(Decimal.quotient(1n, 8n, 2).toFixed(2)).toBe('0.13'); // 0.125, the half away from zero
    expect(Decimal.quotient(-1n, 8n, 2).toFixed(2)).toBe('-0.13');
    expect(Decimal.quotient(1_440n, 720n, 12).toString()).toBe('2');
    expect(() => Decimal.quotient(1n, 0n, 2)).toThrow('Cannot divide by 0');
  });

  it('rounds once, half away from zero, and writes every place', () => {
    expect(d('8.221880704').toFixed(3)).toBe('8.222');
    expect(d('0.0005').toFixed(3)).toBe('0.001');
    expect(d('0.00049999').toFixed(3)).toBe('0.000');
    expect(d('-0.0005').toFixed(3)).toBe('-0.001');
    expect(d('-0.0004').toFixed(3)).toBe('0.000'); // never "-0.000"
    expect(d('2.5').toFixed(0)).toBe('3');
    expect(d('7').toFixed(3)).toBe('7.000');
  });

  it('compares across scales', () => {
    expect([d('0.50').compare(d('0.5')), d('0.4999').compare(d('0.5')), d('1').compare(d('0.99'))]).toEqual([0, -1, 1]);
    expect([d('3').min(d('2.5')).toString(), d('3').max(d('2.5')).toString()]).toEqual(['2.5', '3']);
    expect([d('0.000').isZero(), d('-0.001').isZero()]).toEqual([true, false]);
  });

  it('reads only decimal numbers, as price books write them', () => {
    expect(Decimal.parse('42').toString()).toBe('42');
    for (const text of ['1e-5', '0.5.1', ' 1', '1,5', '', '.5', 'NaN']) expect(() => Decimal.parse(text)).toThrow(`"${text}" is not a decimal number`);
    expect(() => Decimal.of(0.5)).toThrow('0.5 is not a whole number');
  });
});

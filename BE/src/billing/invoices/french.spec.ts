/**
 * L1: how the invoices write amounts, dates and numbers in French, and how
 * documents are dated and numbered (client-readiness plan, P-36).
 */
import { lastDay, previousMonth, tunisDay } from '../tunisia';
import { frenchDay, frenchDecimal, frenchMoney, frenchMonth, frenchPercent, groupDigits } from './french';
import { invoiceNumber, pdfKey } from './invoice-number';

const NBSP = String.fromCharCode(0xa0);

describe('French on the invoices (L1, P-36)', () => {
  it('writes amounts with a decimal comma, thousands apart, the currency after a no-break space the PDF fonts have', () => {
    expect(frenchMoney(59500n, 3, 'TND')).toBe(`59,500${NBSP}TND`);
    expect(frenchMoney(1234567890n, 3, 'TND')).toBe(`1${NBSP}234${NBSP}567,890${NBSP}TND`);
    expect(frenchMoney(-250n, 3, 'TND')).toBe(`-0,250${NBSP}TND`);
    expect(frenchMoney(7n, 3, 'TND')).toBe(`0,007${NBSP}TND`);
    expect(frenchMoney(1000n, 0, 'XOF')).toBe(`1${NBSP}000${NBSP}XOF`);
    expect(groupDigits('1234567')).toBe(`1${NBSP}234${NBSP}567`);
  });

  it('writes decimals and percents the French way', () => {
    expect([frenchDecimal('98765.4321'), frenchDecimal('0.000125'), frenchDecimal('42')]).toEqual([`98${NBSP}765,4321`, '0,000125', '42']);
    expect(frenchPercent(19)).toBe(`19${NBSP}%`);
  });

  it('writes days and months in words, the first of the month as 1er', () => {
    expect([frenchDay('2026-11-02'), frenchDay('2026-10-01'), frenchDay('2027-02-28')]).toEqual(['2 novembre 2026', '1er octobre 2026', '28 février 2027']);
    expect([frenchMonth('2026-10'), frenchMonth('2026-08'), frenchMonth('2027-12')]).toEqual(['octobre 2026', 'août 2026', 'décembre 2027']);
  });
});

describe('dates and numbers of the documents (L1, P-36)', () => {
  it("dates a document by Tunisia's day, an hour ahead of UTC", () => {
    expect(tunisDay(new Date('2026-12-31T22:59:59Z'))).toBe('2026-12-31');
    expect(tunisDay(new Date('2026-12-31T23:00:00Z'))).toBe('2027-01-01'); // already next year's fiscal year there
    expect(tunisDay(new Date('2026-07-01T12:00:00Z'))).toBe('2026-07-01');
  });

  it("finds the month before and a month's last day, across years and in leap years", () => {
    expect([previousMonth('2026-11'), previousMonth('2027-01')]).toEqual(['2026-10', '2026-12']);
    expect([lastDay('2026-10'), lastDay('2026-11'), lastDay('2028-02'), lastDay('2027-02'), lastDay('2026-12')]).toEqual([
      '2026-10-31',
      '2026-11-30',
      '2028-02-29',
      '2027-02-28',
      '2026-12-31',
    ]);
  });

  it('numbers each series by fiscal year, six digits, and keeps the PDF under the number', () => {
    expect([invoiceNumber('FAC', 2026, 1), invoiceNumber('AV', 2027, 123456)]).toEqual(['FAC-2026-000001', 'AV-2027-123456']);
    expect(pdfKey('FAC-2026-000001')).toBe('invoices/FAC-2026-000001.pdf');
  });
});

import { describe, expect, it } from 'vitest';
import { balanceNote, formatMoney } from './money';

describe('money on the account page (P-31)', () => {
  it('writes an amount with its currency, thousands apart, every decimal kept', () => {
    expect(formatMoney('12500.000', 'TND')).toBe('12,500.000 TND');
    expect(formatMoney('0.000', 'TND')).toBe('0.000 TND');
    expect(formatMoney('-0.250', 'TND')).toBe('-0.250 TND');
    expect(formatMoney('-1234567.5', 'EUR')).toBe('-1,234,567.5 EUR');
    expect(formatMoney('42', 'JPY')).toBe('42 JPY');
  });

  it('never goes through a float: millimes past 2^53 stay', () => {
    expect(formatMoney('9007199254740.993', 'TND')).toBe('9,007,199,254,740.993 TND');
  });

  it('says what a balance below zero is', () => {
    expect([balanceNote('50.000'), balanceNote('0.000'), balanceNote('-0.250')]).toEqual(['Credit left', 'Credit left', 'Owed: usage beyond the credit']);
  });
});

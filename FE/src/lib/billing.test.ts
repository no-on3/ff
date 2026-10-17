import { describe, expect, it } from 'vitest';
import type { Balance } from '../services/api';
import { balanceLabel, trialNote } from './billing';

const BALANCE: Balance = { currency: 'TND', balance: '12500.000', shadowMode: true, month: '2026-10', charged: '1.234', ratedUntil: '2026-10-17T10:00:00.000Z' };

describe("the header's balance (P-32)", () => {
  it('writes the balance with its currency, thousands apart, a debt with its sign', () => {
    expect(balanceLabel(BALANCE)).toBe('12,500.000 TND');
    expect(balanceLabel({ ...BALANCE, balance: '-0.250' })).toBe('-0.250 TND');
  });

  it("explains the billing trial: this month's charges, rated and not debited, up to the last hour rated", () => {
    expect(trialNote(BALANCE)).toBe('Billing trial: usage is rated every hour but not charged yet. This month so far: 1.234 TND, up to 17 Oct, 10:00 UTC.');
  });

  it("names no end of rating when it is last month's, or there is none yet", () => {
    expect(trialNote({ ...BALANCE, charged: '0.000', ratedUntil: '2026-09-30T23:00:00.000Z' })).toBe(
      'Billing trial: usage is rated every hour but not charged yet. This month so far: 0.000 TND.',
    );
    expect(trialNote({ ...BALANCE, ratedUntil: null })).toBe('Billing trial: usage is rated every hour but not charged yet. This month so far: 1.234 TND.');
  });

  it('says nothing once usage is charged', () => {
    expect(trialNote({ ...BALANCE, shadowMode: false })).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { AccountCredit, Grant, amountProblem, chargesLabel, confirms, creditStateLabel, decimalsOf, grantNotice, needsConfirmation, signedAmount, toMinor, withDecimals } from './credits';

const CREDIT: AccountCredit = {
  currency: 'TND',
  balance: '12.500',
  state: { state: 'ok', buffer: '1.000', belowBufferSince: null, invokesStopAt: null },
  shadowMode: false,
  month: '2026-10',
  debited: '1.234',
  ratedOnly: '0.000',
  ratedUntil: '2026-10-17T12:00:00.000Z',
  largeCreditThreshold: '100.000',
};

describe('the grant dialog (P-74)', () => {
  it("reads amounts in the currency's minor units, to the last decimal, without a float", () => {
    expect([decimalsOf('100.000'), decimalsOf('42')]).toEqual([3, 0]);
    expect([toMinor('25', 3), toMinor(' 25.5 ', 3), toMinor('-0.001', 3), toMinor('9007199254740.993', 3)]).toEqual([25000n, 25500n, -1n, 9007199254740993n]);
    expect([toMinor('1.0001', 3), toMinor('1e3', 3), toMinor('25,5', 3), toMinor('', 3)]).toEqual([null, null, null, null]);
  });

  it('writes an amount typed with every decimal of its currency, to show it back', () => {
    expect([withDecimals('150', 3), withDecimals(' 0.5', 3), withDecimals('-0.001', 3), withDecimals('42', 0)]).toEqual(['150.000', '0.500', '-0.001', '42']);
    expect(withDecimals('1.0001', 3)).toBe('1.0001');
  });

  it('says what an amount typed lacks: something, digits, not 0; the direction gives the sign', () => {
    expect(amountProblem('', 3)).toBe('Type an amount.');
    expect(amountProblem('1.0001', 3)).toBe('Type an amount such as 25.000, with 3 decimals at most: the direction says which way it goes.');
    expect(amountProblem('-5', 3)).toBe('Type an amount such as 25.000, with 3 decimals at most: the direction says which way it goes.');
    expect(amountProblem('0.000', 3)).toBe('Type an amount above 0.');
    expect(amountProblem('25.5', 3)).toBeNull();
    expect(signedAmount(' 25.5 ', true)).toBe('-25.5');
    expect(signedAmount('25.5', false)).toBe('25.5');
  });

  it('asks for the amount again above the threshold, either way, and not at it', () => {
    expect([needsConfirmation('100', '100.000'), needsConfirmation('-100.000', '100.000')]).toEqual([false, false]);
    expect([needsConfirmation('100.001', '100.000'), needsConfirmation('-100.001', '100.000')]).toEqual([true, true]);
    expect(needsConfirmation('not an amount', '100.000')).toBe(false);
  });

  it('takes the amount typed again as the same value, "250" as "250.000", and nothing else', () => {
    expect([confirms('250', '250.000', 3), confirms(' 250.000 ', '250', 3)]).toEqual([true, true]);
    expect([confirms('250.001', '250', 3), confirms('2500', '250', 3), confirms('', '250', 3)]).toEqual([false, false, false]);
  });
});

describe("the account page's credit (P-74)", () => {
  it('says whether invokes go on, and until when', () => {
    expect(creditStateLabel(CREDIT)).toBe('Invokes go on, down to -1.000 TND.');
    expect(creditStateLabel({ ...CREDIT, shadowMode: true })).toBe('Invokes go on: shadow mode refuses nothing (D9).');
    expect(creditStateLabel({ ...CREDIT, state: { state: 'grace', buffer: '1.000', belowBufferSince: '2026-10-17T10:00:00Z', invokesStopAt: '2026-10-18T10:00:00Z' } })).toBe(
      'Below -1.000 TND since 2026-10-17 10:00:00 UTC: invokes stop at 2026-10-18 10:00:00 UTC.',
    );
    expect(creditStateLabel({ ...CREDIT, state: { state: 'stopped', buffer: '1.000', belowBufferSince: '2026-10-17T10:00:00Z', invokesStopAt: '2026-10-18T10:00:00Z' } })).toBe(
      'Invokes stopped at 2026-10-18 10:00:00 UTC, and answer 402 until credit brings the balance to -1.000 TND or more.',
    );
  });

  it("gives the month's charges: debited, and only rated in shadow mode when there are any", () => {
    expect(chargesLabel(CREDIT)).toBe('1.234 TND debited. Rated until 2026-10-17 12:00:00 UTC.');
    expect(chargesLabel({ ...CREDIT, debited: '0.000', ratedOnly: '1500.250' })).toBe('0.000 TND debited; 1,500.250 TND only rated, in shadow mode. Rated until 2026-10-17 12:00:00 UTC.');
    expect(chargesLabel({ ...CREDIT, ratedUntil: null })).toBe('Nothing rated yet.');
  });

  it('says what a grant did, or that it was made before', () => {
    const grant: Grant = { id: 'tx', kind: 'promo', currency: 'TND', amount: '25.000', balance: '37.500', createdAt: '2026-10-17T10:00:00Z', replayed: false };

    expect(grantNotice(grant)).toBe('25.000 TND of promotional credit granted. The balance is now 37.500 TND; the owners got an e-mail.');
    expect(grantNotice({ ...grant, kind: 'adjustment', amount: '-1500.000', balance: '-2.000' })).toBe(
      'Corrected: 1,500.000 TND taken away. The balance is now -2.000 TND; the owners got an e-mail.',
    );
    expect(grantNotice({ ...grant, kind: 'adjustment', amount: '2.000' })).toBe('Corrected: 2.000 TND added. The balance is now 37.500 TND; the owners got an e-mail.');
    expect(grantNotice({ ...grant, replayed: true })).toBe('This grant was made at 2026-10-17 10:00:00 UTC: nothing was granted again. The balance is 37.500 TND.');
  });
});

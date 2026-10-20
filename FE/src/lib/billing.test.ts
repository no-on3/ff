import { describe, expect, it } from 'vitest';
import type { Balance, ProForma } from '../services/api';
import {
  CREDIT_PACKS,
  balanceLabel,
  creditBanner,
  decimalsOf,
  frenchDate,
  invoiceKindLabel,
  monthName,
  frenchMoney,
  invokesLabel,
  parsePercents,
  percentsText,
  proFormaQuote,
  proFormaState,
  statementMonths,
  transactionLabel,
  trialNote,
} from './billing';

const BALANCE: Balance = {
  currency: 'TND',
  balance: '12500.000',
  shadowMode: true,
  month: '2026-10',
  charged: '1.234',
  ratedUntil: '2026-10-17T10:00:00.000Z',
  credit: { state: 'ok', buffer: '1.000', belowBufferSince: null, invokesStopAt: null },
};
const GRACE: Balance = {
  ...BALANCE,
  balance: '-2.345',
  shadowMode: false,
  credit: { state: 'grace', buffer: '1.000', belowBufferSince: '2026-10-17T10:33:00.000Z', invokesStopAt: '2026-10-18T10:33:00.000Z' },
};
const STOPPED: Balance = { ...GRACE, credit: { ...GRACE.credit, state: 'stopped' } };

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

describe('the balance check, as the console tells it (P-33)', () => {
  it('shows no banner while invokes go on, a warning with their end in the grace period, an alert once they stopped', () => {
    expect(creditBanner(BALANCE)).toBeNull();
    expect(creditBanner({ ...GRACE, credit: { ...GRACE.credit, state: 'ok', invokesStopAt: null } })).toBeNull();
    expect(creditBanner(GRACE)).toEqual({
      tone: 'warning',
      text: 'Your balance is -2.345 TND, below the -1.000 TND FF allows: invokes stop on 18 Oct, 10:33 UTC unless you add credit.',
    });
    expect(creditBanner(STOPPED)).toEqual({
      tone: 'danger',
      text: 'Invokes are stopped: your balance is -2.345 TND, below -1.000 TND. Add credit to invoke again; reads, logs and deploys go on.',
    });
  });

  it('says on the Billing page whether invokes go on', () => {
    expect(invokesLabel(BALANCE)).toBe('Going on: nothing is charged during the billing trial');
    expect(invokesLabel({ ...BALANCE, shadowMode: false })).toBe('Going on, down to -1.000 TND');
    expect(invokesLabel(GRACE)).toBe('Stop on 18 Oct, 10:33 UTC');
    expect(invokesLabel(STOPPED)).toBe('Stopped since 18 Oct, 10:33 UTC');
  });

  it('names a usage debit by its hour, and a credit by its kind', () => {
    expect(transactionLabel({ kind: 'usage', occurredAt: '2026-10-17T10:00:00.000Z' })).toBe('Usage, 17 Oct, 10:00–11:00 UTC');
    expect(transactionLabel({ kind: 'usage', occurredAt: '2026-10-31T23:00:00.000Z' })).toBe('Usage, 31 Oct, 23:00–00:00 UTC');
    expect(['promo', 'adjustment', 'topup', 'mystery'].map((kind) => transactionLabel({ kind, occurredAt: '2026-10-17T10:00:00.000Z' }))).toEqual([
      'Credit from FF',
      'Correction',
      'Top-up',
      'mystery',
    ]);
  });

  it('reads the shares an owner types, as the API takes them, or says what is wrong', () => {
    expect(parsePercents('80, 20, 0')).toEqual({ percents: [80, 20, 0] });
    expect(parsePercents(' 50 ,')).toEqual({ percents: [50] });
    expect(parsePercents('')).toEqual({ percents: [] });
    expect(parsePercents('20, 80')).toEqual({ problem: 'From the largest share to the smallest, each once' });
    expect(parsePercents('50, 50')).toEqual({ problem: 'From the largest share to the smallest, each once' });
    expect(parsePercents('101')).toEqual({ problem: 'Each share is a whole percent from 0 to 100, such as 50, 20, 0' });
    expect(parsePercents('12.5')).toEqual({ problem: 'Each share is a whole percent from 0 to 100, such as 50, 20, 0' });
    expect(parsePercents('90, 70, 50, 30, 10, 0')).toEqual({ problem: 'Five shares at most' });
    expect(percentsText([50, 20, 0])).toBe('50, 20, 0');
  });
});

const PRO_FORMA: ProForma = {
  id: '7d0b8a3e-9a51-4c7e-8d5f-1b2c3d4e5f60',
  reference: 'FF-7KQ2-9MXA',
  status: 'pending',
  currency: 'TND',
  credit: '50.000',
  vatPercent: 19,
  vat: '9.500',
  total: '59.500',
  createdAt: '2026-10-17T09:30:00.000Z',
  buyer: { name: 'Tunis Labs', taxId: '1234567/A/B/M/000' },
  seller: { name: 'FF', taxId: '0000000/A/A/M/000', address: 'Tunis, Tunisia' },
  bank: { name: 'A bank', iban: 'TN59 1000 6035 1835 9847 8831', bic: null },
  transfer: null,
  cancelledAt: null,
};
const PAID = { received: '58.608', withheld: '0.892', receivedOn: '2026-10-20', recordedAt: '2026-10-21T08:00:00.000Z', credited: '49.108', withheldCreditedAt: null };

describe('asking for a pro-forma (P-35)', () => {
  it("quotes a pack as the API will write it: the credit, D9's 19% VAT on top, and the total to transfer", () => {
    expect(CREDIT_PACKS.map((pack) => proFormaQuote(pack, 3, 19))).toEqual([
      { credit: '20.000', vat: '3.800', total: '23.800' },
      { credit: '50.000', vat: '9.500', total: '59.500' },
      { credit: '100.000', vat: '19.000', total: '119.000' },
      { credit: '500.000', vat: '95.000', total: '595.000' },
    ]);
  });

  it('rounds the VAT once to the millime, half up, as the API does (pro-forma.spec.ts has the same amounts)', () => {
    expect(proFormaQuote('50.001', 3, 19)).toEqual({ credit: '50.001', vat: '9.500', total: '59.501' }); // 9500.19
    expect(proFormaQuote('50.003', 3, 19)).toEqual({ credit: '50.003', vat: '9.501', total: '59.504' }); // 9500.57
    expect(proFormaQuote('10.050', 3, 19)).toEqual({ credit: '10.050', vat: '1.910', total: '11.960' }); // 1909.5
    expect(proFormaQuote(' 12.5 ', 3, 19)).toEqual({ credit: '12.500', vat: '2.375', total: '14.875' });
    expect(proFormaQuote('50', 0, 19)).toEqual({ credit: '50', vat: '10', total: '60' }); // 9.5, in a currency without decimals
  });

  it("refuses what the API would, from 10 to 1,000,000 of credit, with the currency's decimals at most", () => {
    expect(proFormaQuote('10', 3, 19)).toEqual({ credit: '10.000', vat: '1.900', total: '11.900' });
    expect(proFormaQuote('1000000', 3, 19)).toEqual({ credit: '1000000.000', vat: '190000.000', total: '1190000.000' });
    for (const amount of ['9.999', '1000000.001', '0']) expect(proFormaQuote(amount, 3, 19)).toEqual({ problem: 'The credit is from 10 to 1,000,000' });
    for (const amount of ['fifty', '-50', '50,000', '50.', '', '1e3']) expect(proFormaQuote(amount, 3, 19)).toEqual({ problem: 'The credit is an amount, such as 50 or 50.500' });
    expect(proFormaQuote('50.0001', 3, 19)).toEqual({ problem: 'The credit has at most 3 decimals' });
    expect(proFormaQuote('50.5', 0, 19)).toEqual({ problem: 'The credit is a whole amount' });
  });

  it("quotes at the rate of the day the API gives, as tax rates are dated data (P-36)", () => {
    expect(proFormaQuote('50', 3, 20)).toEqual({ credit: '50.000', vat: '10.000', total: '60.000' });
    expect(proFormaQuote('50.005', 3, 7)).toEqual({ credit: '50.005', vat: '3.500', total: '53.505' }); // 3500.35
  });

  it("reads the currency's decimals from an amount the API wrote", () => {
    expect([decimalsOf('12.500'), decimalsOf('-0.250'), decimalsOf('7')]).toEqual([3, 3, 0]);
  });
});

describe("a pro-forma's state (P-35)", () => {
  it('waits for the transfer, then says when it came and the credit it added', () => {
    expect(proFormaState(PRO_FORMA)).toEqual({ label: 'Waiting for the transfer', note: null });
    expect(proFormaState({ ...PRO_FORMA, status: 'paid', transfer: { ...PAID, received: '59.500', withheld: '0.000', credited: '50.000' } })).toEqual({
      label: 'Paid on 20 Oct 2026: 50.000 TND credited',
      note: null,
    });
  });

  it('names the share withheld at source, until the certificate credits it, and after', () => {
    const paid = { ...PRO_FORMA, status: 'paid' as const, transfer: PAID };

    expect(proFormaState(paid)).toEqual({
      label: 'Paid on 20 Oct 2026: 49.108 TND credited',
      note: '0.892 TND withheld at source: credited when FF receives the withholding certificate',
    });
    expect(proFormaState({ ...paid, transfer: { ...PAID, withheldCreditedAt: '2026-10-23T14:00:00.000Z' } }).note).toBe(
      '0.892 TND withheld at source, credited on 23 Oct 2026 with the certificate',
    );
  });

  it('says when it was cancelled, and not to pay it; paid anyway, it says what was paid (P-74)', () => {
    const cancelled = { ...PRO_FORMA, status: 'cancelled' as const, cancelledAt: '2026-10-18T07:30:00.000Z' };

    expect(proFormaState(cancelled)).toEqual({ label: 'Cancelled on 18 Oct 2026', note: "Don't transfer for it." });
    expect(proFormaState({ ...cancelled, status: 'paid', transfer: { ...PAID, received: '59.500', withheld: '0.000', credited: '50.000' } }).label).toBe(
      'Paid on 20 Oct 2026: 50.000 TND credited',
    );
  });
});

describe('the printed pro-forma, in French (P-35)', () => {
  it('writes amounts the French way: a decimal comma, thousands apart with a narrow space, the currency after a fixed space', () => {
    expect(frenchMoney('59.500', 'TND')).toBe('59,500\u00a0TND');
    expect(frenchMoney('1190000.000', 'TND')).toBe('1\u202f190\u202f000,000\u00a0TND');
    expect(frenchMoney('1000', 'XOF')).toBe('1\u202f000\u00a0XOF');
    expect(frenchMoney('-0.250', 'TND')).toBe('-0,250\u00a0TND');
  });

  it('writes dates the French way, in UTC, the first of the month as 1er', () => {
    expect(frenchDate('2026-10-17T09:30:00.000Z')).toBe('17 octobre 2026');
    expect(frenchDate('2026-08-01T00:00:00.000Z')).toBe('1er août 2026');
    expect(frenchDate('2026-12-31T23:59:59.000Z')).toBe('31 décembre 2026');
    expect(frenchDate('2026-02-01')).toBe('1er février 2026');
  });
});

describe('invoices and usage statements (P-36)', () => {
  it('names an invoice by its month, and a credit note by the invoice it corrects', () => {
    expect(invoiceKindLabel({ kind: 'invoice', corrects: null })).toBe('Invoice');
    expect(invoiceKindLabel({ kind: 'credit_note', corrects: 'FAC-2026-000001' })).toBe('Credit note for FAC-2026-000001');
    expect([monthName('2026-10'), monthName('2027-01')]).toEqual(['October 2026', 'January 2027']);
  });

  it('offers the statements of this month, by the UTC calendar, and the eleven before, newest first', () => {
    const months = statementMonths(new Date('2026-10-31T23:30:00Z'));

    expect(months).toHaveLength(12);
    expect([months[0], months[1], months[months.length - 1]]).toEqual(['2026-10', '2026-09', '2025-11']);
    expect(statementMonths(new Date('2027-01-01T00:00:00Z'), 3)).toEqual(['2027-01', '2026-12', '2026-11']);
  });
});

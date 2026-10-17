import { describe, expect, it } from 'vitest';
import { AdminInvoice, Draft, draftsTotal, invoiceFileName, invoiceLabel, issueNotice, lastMonthInTunisia, monthName } from './invoices';

const draft = (accountId: string, total: string): Draft => ({
  accountId,
  buyerName: `Account ${accountId}`,
  buyerTaxId: null,
  currency: 'TND',
  lines: [],
  subtotal: '0.000',
  vat: '0.000',
  stampDuty: '1.000',
  total,
  withheld: '0.000',
});
const issued = (number: string) => ({ number }) as AdminInvoice;

describe('invoices in the admin dashboard (P-36)', () => {
  it('names a document: an invoice by its month, a credit note by the invoice it corrects', () => {
    expect(invoiceLabel({ kind: 'invoice', month: '2026-10', corrects: null })).toBe('Invoice, October 2026');
    expect(invoiceLabel({ kind: 'credit_note', month: null, corrects: 'FAC-2026-000001' })).toBe('Credit note for FAC-2026-000001');
    expect(invoiceFileName({ number: 'AV-2026-000002' })).toBe('AV-2026-000002.pdf');
    expect(monthName('2027-01')).toBe('January 2027');
  });

  it('opens on last month in Tunisia, an hour ahead of UTC', () => {
    expect(lastMonthInTunisia(new Date('2026-11-15T12:00:00Z'))).toBe('2026-10');
    expect(lastMonthInTunisia(new Date('2026-10-31T23:30:00Z'))).toBe('2026-10'); // 1 November there
    expect(lastMonthInTunisia(new Date('2027-01-01T00:30:00Z'))).toBe('2026-12');
  });

  it('adds up the drafts for the "Issue all" dialog, exactly, thousands apart', () => {
    expect(draftsTotal([draft('1', '1250.500'), draft('2', '11.900'), draft('3', '0.001')])).toBe('1,262.401 TND');
    expect(draftsTotal([])).toBe('nothing');
  });

  it('says what issuing did: the numbers issued, then each account not issued and why', () => {
    expect(issueNotice({ issued: [issued('FAC-2026-000001')], failed: [] })).toEqual({ ok: true, text: 'Issued FAC-2026-000001.' });
    expect(issueNotice({ issued: ['FAC-2026-000003', 'FAC-2026-000004', 'FAC-2026-000005'].map(issued), failed: [] })).toEqual({
      ok: true,
      text: 'Issued 3 invoices, FAC-2026-000003 to FAC-2026-000005.',
    });
    expect(issueNotice({ issued: [], failed: [{ accountId: '000000000007', problem: 'Nothing to invoice' }, { accountId: '000000000008', problem: 'Account 000000000008 not found' }] })).toEqual({
      ok: false,
      text: 'Nothing issued. Not issued: 000000000007: Nothing to invoice; 000000000008: Account 000000000008 not found.',
    });
  });
});

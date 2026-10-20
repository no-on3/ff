/** L1: the e-mails about invoices (client-readiness plan, P-36): the owners', and the operator's. */
import { Invoice, InvoiceKind } from './invoice.entity';
import { creditNoteMail, invoiceMail, operatorInvoicesMail } from './invoice-mail';

const ACCOUNT = { id: '000000000001', name: 'Tunis Labs' };
const INVOICE = { number: 'FAC-2026-000001', kind: InvoiceKind.INVOICE, month: '2026-10', currency: 'TND', totalMinor: 60_500n, stampDutyMinor: 1_000n } as Invoice;

describe('the e-mails about invoices (L1, P-36)', () => {
  it("tell the owners an invoice is issued: its number, total and stamp duty, and where it is", () => {
    expect(invoiceMail({ account: ACCOUNT, invoice: INVOICE, exponent: 3, consoleUrl: 'https://console.ff.example' }, 'en')).toEqual({
      subject: 'Your invoice FAC-2026-000001: Tunis Labs',
      text: [
        "Your invoice for October 2026 is issued: FAC-2026-000001, 60.500 TND including VAT, with the 1.000 TND stamp duty, which was taken from your credit. It lists the credit you bought; the month's usage statement is attached to it.",
        '',
        'Download it from your Billing page: https://console.ff.example/billing',
      ].join('\n'),
    });
    expect(invoiceMail({ account: ACCOUNT, invoice: { ...INVOICE, stampDutyMinor: 0n }, exponent: 3, consoleUrl: 'x' }, 'en').text).not.toContain('stamp duty');
  });

  it('tell them of a credit note, and why', () => {
    const note = { number: 'AV-2026-000001', kind: InvoiceKind.CREDIT_NOTE, currency: 'TND', totalMinor: 23_800n, reason: 'Unused credit refunded' } as Invoice;

    expect(creditNoteMail({ account: ACCOUNT, note, corrects: 'FAC-2026-000001', exponent: 3, consoleUrl: 'https://console.ff.example' }, 'en')).toEqual({
      subject: 'A credit note for your invoice FAC-2026-000001: Tunis Labs',
      text: [
        'We issued the credit note AV-2026-000001 for your invoice FAC-2026-000001: 23.800 TND including VAT.',
        '',
        'Why: Unused credit refunded',
        '',
        'Download it from your Billing page: https://console.ff.example/billing',
      ].join('\n'),
    });
  });

  it("tell the operator a month's invoices are ready to issue, then, past the reminder day, that some still aren't", () => {
    expect(operatorInvoicesMail('ready', '2026-10', 12, 3, 'https://admin.ff.example')).toEqual({
      subject: 'Invoices to issue: October 2026',
      text: '12 invoices for October 2026 are ready to issue, by the 3rd:\n\nhttps://admin.ff.example/invoices?month=2026-10',
    });
    expect(operatorInvoicesMail('reminder', '2026-12', 1, 1, 'https://admin.ff.example')).toEqual({
      subject: 'Invoices still to issue: December 2026',
      text: '1 invoice for December 2026 is still not issued, past the 1st:\n\nhttps://admin.ff.example/invoices?month=2026-12',
    });
    expect([2, 11, 12, 13, 21, 22, 23, 28].map((day) => operatorInvoicesMail('ready', '2026-10', 2, day, '').text.split(':')[0].split(' ').at(-1))).toEqual([
      '2nd',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '23rd',
      '28th',
    ]);
  });
});

describe('the e-mails about invoices, in French', () => {
  const NB = ' ';

  it("give the invoice's number, its total with VAT, the stamp duty taken from the credit, and where to download it", () => {
    expect(invoiceMail({ account: ACCOUNT, invoice: INVOICE, exponent: 3, consoleUrl: 'https://console.ff.example' }, 'fr')).toEqual({
      subject: 'Votre facture FAC-2026-000001 : Tunis Labs',
      text: [
        `Votre facture d'octobre 2026 est émise : FAC-2026-000001, 60,500${NB}TND TTC, dont le droit de timbre de 1,000${NB}TND, pris sur votre crédit. Elle reprend le crédit que vous avez acheté ; le relevé de consommation du mois y est joint.`,
        '',
        'Téléchargez-la depuis la page Billing de la console : https://console.ff.example/billing',
      ].join('\n'),
    });
    expect(invoiceMail({ account: ACCOUNT, invoice: { ...INVOICE, stampDutyMinor: 0n }, exponent: 3, consoleUrl: 'x' }, 'fr').text).not.toContain('timbre');
    expect(invoiceMail({ account: ACCOUNT, invoice: { ...INVOICE, month: '2026-03' }, exponent: 3, consoleUrl: 'x' }, 'fr').text).toMatch(/^Votre facture de mars 2026 est émise/);
  });

  it("give a credit note's number, the invoice it corrects, its total and why", () => {
    const note = { number: 'AV-2026-000001', kind: InvoiceKind.CREDIT_NOTE, currency: 'TND', totalMinor: 11_900n, reason: 'Crédit facturé deux fois' } as Invoice;

    expect(creditNoteMail({ account: ACCOUNT, note, corrects: 'FAC-2026-000001', exponent: 3, consoleUrl: 'https://console.ff.example' }, 'fr')).toEqual({
      subject: 'Un avoir pour votre facture FAC-2026-000001 : Tunis Labs',
      text: [
        `Nous avons émis l'avoir AV-2026-000001 pour votre facture FAC-2026-000001 : 11,900${NB}TND TTC.`,
        '',
        'Motif : Crédit facturé deux fois',
        '',
        'Téléchargez-le depuis la page Billing de la console : https://console.ff.example/billing',
      ].join('\n'),
    });
  });
});

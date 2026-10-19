/**
 * L1: the language of each e-mail: a user's choice, French at first; the same
 * e-mail sent to each recipient in theirs; and every e-mail a customer gets
 * giving, in French as in English, the same links, IDs, references, amounts
 * and reasons. Each e-mail's French text is checked word for word in the spec
 * beside its English one.
 */
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { invitationMail } from '../accounts/invitation-mail';
import { ownerMail } from '../admin/admin-accounts.service';
import { STATUS_CHANGE_NAMES } from '../admin/account-status-changes';
import { grantMail } from '../admin/credit-grants';
import { LedgerTransactionKind } from '../billing/ledger/ledger-transaction.entity';
import { creditNoteMail, invoiceMail } from '../billing/invoices/invoice-mail';
import { Invoice, InvoiceKind } from '../billing/invoices/invoice.entity';
import { lowBalanceMail } from '../billing/low-balance';
import { cancelMail, transferMail, withholdingMail } from '../billing/payments/pro-forma';
import { Language, languageOf, recipientsOf } from './language';
import { Mail, MailService } from './mail.service';

describe('the language of an e-mail', () => {
  it("is English for an English locale, and French for any other, or none: every user's at first", () => {
    expect(['en', 'EN', 'en-GB', 'en-US'].map(languageOf)).toEqual(['en', 'en', 'en', 'en']);
    expect(['fr-TN', 'fr', 'ar-TN', 'english', '', null, undefined].map(languageOf)).toEqual(['fr', 'fr', 'fr', 'fr', 'fr', 'fr', 'fr']);
  });

  it("takes an account's members' addresses and languages; one without a login has no address", () => {
    expect(recipientsOf([{ user: { email: 'amira@ff.tn', locale: 'en' } }, { user: null }])).toEqual([
      { email: 'amira@ff.tn', locale: 'en' },
      { email: '', locale: undefined },
    ]);
  });
});

describe('MailService.sendEach', () => {
  const config = { getOrThrow: () => ({ smtpUrl: 'smtp://unused', from: 'FF <no-reply@ff.tn>' }) } as unknown as ConfigService;

  it('sends each recipient the e-mail in their language, composed once per language, and skips one without an address', async () => {
    const sendMail = jest.fn(async (_message: { to: string; subject: string }) => ({}));
    const compose = jest.fn((language: Language): Omit<Mail, 'to'> => ({ subject: `subject ${language}`, text: `text ${language}` }));
    const mail = new MailService(config, { sendMail } as never);

    const sent = await mail.sendEach(
      [
        { email: 'amira@ff.tn', locale: 'fr-TN' },
        { email: 'sami@ff.tn', locale: 'en' },
        { email: '', locale: 'en' },
        { email: 'leila@ff.tn', locale: null },
      ],
      compose,
    );

    expect(sent).toBe(true);
    expect(compose.mock.calls).toEqual([['fr'], ['en']]);
    expect(sendMail.mock.calls.map(([message]) => [message.to, message.subject])).toEqual([
      ['amira@ff.tn', 'subject fr'],
      ['sami@ff.tn', 'subject en'],
      ['leila@ff.tn', 'subject fr'],
    ]);
  });

  it("goes on to the next recipient when one can't be sent, and says not all were", async () => {
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const sendMail = jest.fn().mockRejectedValueOnce(new Error('mailbox full')).mockResolvedValue({});
    const mail = new MailService(config, { sendMail });

    const sent = await mail.sendEach([{ email: 'amira@ff.tn' }, { email: 'sami@ff.tn' }], () => ({ subject: 's', text: 't' }));

    expect([sent, sendMail.mock.calls.length]).toEqual([false, 2]);
    errors.mockRestore();
  });
});

/** The facts an e-mail gives that mustn't change with its language: links, account IDs, references, amounts in either way of writing them. */
function facts(mail: Omit<Mail, 'to'>, words: string[]): string[] {
  const text = `${mail.subject}\n${mail.text}`;
  const links = text.match(/https?:\/\/[^\s]+/g) ?? [];
  const ids = text.match(/\b\d{12}\b/g) ?? [];
  const references = text.match(/\b(?:FF|FAC|AV)-[0-9A-Z]{4}-[0-9A-Z]{4,6}\b/g) ?? [];
  // "1 234,500 TND" and "1234.500 TND" are both the digits 1234500.
  const amounts = (text.match(/-?[\d\u00a0.,]*\d[\u00a0 ]TND/g) ?? []).map((amount) => amount.replace(/[^\d-]/g, ''));
  return [...links, ...ids, ...references, ...amounts, ...words.filter((word) => text.includes(word))].sort();
}

describe('every e-mail a customer gets, in French and in English', () => {
  const account = { id: '000000000042', name: 'Tunis Labs' };
  const consoleUrl = 'https://console.ff.tn';
  const reason = 'Mining cryptocurrency';
  const transfer = { account, reference: 'FF-7KQ2-9MXA', creditMinor: 50000n, receivedMinor: 58608n, withheldMinor: 892n, exponent: 3, currency: 'TND', consoleUrl };
  const invoice = { number: 'FAC-2026-000001', kind: InvoiceKind.INVOICE, month: '2026-10', currency: 'TND', totalMinor: 60_500n, stampDutyMinor: 1_000n } as Invoice;
  const note = { number: 'AV-2026-000001', kind: InvoiceKind.CREDIT_NOTE, currency: 'TND', totalMinor: 11_900n, reason } as Invoice;
  const policy = { bufferMinor: 1000n, graceMs: 24 * 3_600_000, shadow: false };
  const closed = { ...account, dataDeletionDueAt: new Date('2026-11-17T10:32:45Z') };

  const mails: Array<[string, (language: Language) => Omit<Mail, 'to'>]> = [
    ...STATUS_CHANGE_NAMES.map((change): [string, (language: Language) => Omit<Mail, 'to'>] => [`the account's status change, ${change}`, (language) => ownerMail(closed, change, reason, consoleUrl, language)]),
    ['an invitation', (language) => invitationMail({ inviter: { email: 'amira@ff.tn', name: 'Amira' }, account, role: 'developer', expiresAt: new Date('2026-10-26T09:00:00Z'), consoleUrl }, language)],
    ['a low balance', (language) => lowBalanceMail({ account, percent: 20, balanceMinor: 9800n, creditMinor: 50000n, creditAt: new Date('2026-10-17T10:00:00Z'), currency: 'TND', exponent: 3, policy, consoleUrl }, language)],
    ['the credit used up', (language) => lowBalanceMail({ account, percent: 0, balanceMinor: -120n, creditMinor: 50000n, creditAt: new Date('2026-10-17T10:00:00Z'), currency: 'TND', exponent: 3, policy, consoleUrl }, language)],
    ['a transfer received', (language) => transferMail(transfer, language)],
    ['a withheld share added', (language) => withholdingMail(transfer, language)],
    ['a pro-forma cancelled', (language) => cancelMail({ account, reference: 'FF-7KQ2-9MXA', totalMinor: 59500n, exponent: 3, currency: 'TND', reason, consoleUrl }, language)],
    ['an invoice', (language) => invoiceMail({ account, invoice, exponent: 3, consoleUrl }, language)],
    ['a credit note', (language) => creditNoteMail({ account, note, corrects: invoice.number, exponent: 3, consoleUrl }, language)],
    ['a promotion', (language) => grantMail({ account, kind: LedgerTransactionKind.PROMO, amountMinor: 25_000n, balanceMinor: 37_500n, currency: 'TND', exponent: 3, reason, consoleUrl }, language)],
    ['a correction', (language) => grantMail({ account, kind: LedgerTransactionKind.ADJUSTMENT, amountMinor: -2_000n, balanceMinor: -750n, currency: 'TND', exponent: 3, reason, consoleUrl }, language)],
  ];

  it.each(mails)('%s: the same links, IDs, references, amounts and reason in both', (_name, mail) => {
    const [french, english] = [mail('fr'), mail('en')];

    expect(facts(french, [reason, 'Tunis Labs', 'amira@ff.tn'])).toEqual(facts(english, [reason, 'Tunis Labs', 'amira@ff.tn']));
    expect(french).not.toEqual(english);
    for (const text of [french.subject, french.text, english.subject, english.text]) expect(text).not.toMatch(/undefined|NaN|null|\[object/);
  });

  it('are in French without a word of the English ones', () => {
    for (const [, mail] of mails) {
      const french = mail('fr');
      expect(`${french.subject}\n${french.text}`).not.toMatch(/\b(?:your|the|is|was|account|credit has|balance)\b/i);
    }
  });
});

/**
 * L1: what comes back for a return-path domain (ADR 0012), read as FF reads
 * it: a bounce as Postfix writes one (this one Postfix 3.11's, from step 4's
 * spike), whose message its return path names; each recipient failed for good,
 * for now, or only delayed; and a complaint, an abuse report as mailbox
 * providers send them (RFC 5965).
 */
import { isBounce, isPermanent, readReport } from './email-reports';

const ID = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';

/** Postfix's bounce of a message to two recipients: one a mailbox that doesn't exist, one a server that refuses for now; a third only delayed. */
const BOUNCE = [
  'Return-Path: <>',
  `X-Original-To: b-${ID}@bounces.mail.shop.example.tn`,
  `Delivered-To: b-${ID}@bounces.mail.shop.example.tn`,
  'Received: by mail.ffunc.cloud (Postfix)',
  '\tid 6534D1E69349; Fri, 30 Oct 2026 02:18:26 +0000 (UTC)',
  'From: Mail Delivery System <MAILER-DAEMON@mail.ffunc.cloud>',
  'Subject: Undelivered Mail Returned to Sender',
  `To: b-${ID}@bounces.mail.shop.example.tn`,
  'MIME-Version: 1.0',
  'Content-Type: multipart/report; report-type=delivery-status;',
  '\tboundary="539BA1E69345.1793326706/mail.ffunc.cloud"',
  '',
  'This is a MIME-encapsulated message.',
  '',
  '--539BA1E69345.1793326706/mail.ffunc.cloud',
  'Content-Description: Notification',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'This is the mail system at host mail.ffunc.cloud.',
  '',
  '--539BA1E69345.1793326706/mail.ffunc.cloud',
  'Content-Description: Delivery report',
  'Content-Type: message/delivery-status',
  '',
  'Reporting-MTA: dns; mail.ffunc.cloud',
  `X-Postfix-Sender: rfc822; b-${ID}@bounces.mail.shop.example.tn`,
  'Arrival-Date: Fri, 30 Oct 2026 02:18:26 +0000 (UTC)',
  '',
  'Final-Recipient: rfc822; Gone@Example.TN',
  'Original-Recipient: rfc822;gone@example.tn',
  'Action: failed',
  'Status: 5.1.1',
  'Remote-MTA: dns; mx.example.tn',
  'Diagnostic-Code: smtp; 550 5.1.1 <gone@example.tn>: Recipient address',
  '    rejected: User unknown in virtual mailbox table',
  '',
  'Final-Recipient: rfc822; full@example.tn',
  'Action: failed',
  'Status: 4.2.2',
  'Diagnostic-Code: smtp; 452 4.2.2 Mailbox full',
  '',
  'Final-Recipient: rfc822; slow@example.tn',
  'Action: delayed',
  'Status: 4.4.1',
  '',
  '--539BA1E69345.1793326706/mail.ffunc.cloud',
  'Content-Description: Undelivered Message',
  'Content-Type: message/rfc822',
  '',
  `Return-Path: <b-${ID}@bounces.mail.shop.example.tn>`,
  'From: Boutique Ana <orders@shop.example.tn>',
  'To: gone@example.tn',
  'Subject: Votre reçu',
  '',
  'Merci.',
  '',
  '--539BA1E69345.1793326706/mail.ffunc.cloud--',
  '',
].join('\r\n');

/** An abuse report, as a mailbox provider's feedback loop sends one, to an address of its own: the message it reports names FF's. */
const COMPLAINT = [
  'From: Feedback Loop <fbl@mailbox.example>',
  'To: abuse@bounces.mail.ffunc.cloud',
  'Subject: Abuse report',
  'MIME-Version: 1.0',
  'Content-Type: multipart/report; report-type=feedback-report; boundary="part"',
  '',
  '--part',
  'Content-Type: text/plain',
  '',
  'A complaint about a message from your server.',
  '--part',
  'Content-Type: message/feedback-report',
  '',
  'Feedback-Type: abuse',
  'User-Agent: Mailbox/1.0',
  'Version: 1',
  'Original-Rcpt-To: <Angry@Example.TN>',
  '',
  '--part',
  'Content-Type: message/rfc822',
  '',
  `Return-Path: <b-${ID}@bounces.mail.shop.example.tn>`,
  'From: orders@shop.example.tn',
  'To: angry@example.tn',
  '',
  'Our offers.',
  '--part--',
  '',
].join('\r\n');

describe('what comes back for a return-path domain (L1, ADR 0012)', () => {
  it('reads a bounce: whose message, and what became of each recipient, folded fields unfolded', () => {
    const report = readReport(Buffer.from(BOUNCE));

    expect(report).toEqual({
      messageId: ID,
      kind: 'bounce',
      recipients: [
        { address: 'gone@example.tn', action: 'failed', status: '5.1.1', diagnostic: 'smtp; 550 5.1.1 <gone@example.tn>: Recipient address rejected: User unknown in virtual mailbox table' },
        { address: 'full@example.tn', action: 'failed', status: '4.2.2', diagnostic: 'smtp; 452 4.2.2 Mailbox full' },
        { address: 'slow@example.tn', action: 'delayed', status: '4.4.1', diagnostic: null },
      ],
    });
    expect(report.recipients.map((recipient) => [isBounce(recipient), isPermanent(recipient)])).toEqual([
      [true, true],
      [true, false],
      [false, false],
    ]);
  });

  it('reads a complaint: the message it reports, by its return path, and who complained', () => {
    expect(readReport(Buffer.from(COMPLAINT))).toEqual({
      messageId: ID,
      kind: 'complaint',
      recipients: [{ address: 'angry@example.tn', action: 'complained', status: '', diagnostic: null }],
      feedbackType: 'abuse',
    });
  });

  it("names no message for what isn't FF's, and reads anything else as no report", () => {
    expect(readReport(Buffer.from(BOUNCE.replaceAll(`b-${ID}@`, 'someone@')))).toMatchObject({ messageId: null, kind: 'bounce' });
    expect(readReport(Buffer.from(`To: b-${ID}@bounces.mail.shop.example.tn\r\nSubject: Out of office\r\n\r\nBack Monday.\r\n`))).toEqual({ messageId: ID, kind: 'other', recipients: [] });
  });
});

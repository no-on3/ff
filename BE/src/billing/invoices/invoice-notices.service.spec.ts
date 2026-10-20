/**
 * L1: the operator's e-mails about last month's invoices (client-readiness
 * plan, P-36, D9): which is due when, once each, and none while nothing
 * waits. Its row's uniqueness, which makes it once across backends, is
 * PostgreSQL's (invoices.db.spec.ts).
 */
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { PlatformSettingsService } from '../../admin/platform-settings.service';
import { Mail, MailService } from '../../mail/mail.service';
import { InvoiceNoticesService } from './invoice-notices.service';
import { InvoicesService } from './invoices.service';

describe("the operator's invoice e-mails (L1, P-36)", () => {
  let written: Set<string>;
  let sent: Mail[];
  let waiting: number;
  let operatorEmail: string;
  const asked: string[] = [];
  const service = () =>
    new InvoiceNoticesService(
      {
        // INSERT … ON CONFLICT DO NOTHING RETURNING: a row the first time only.
        query: async (_sql: string, [month, kind]: string[]) => {
          if (written.has(`${month} ${kind}`)) return [];
          written.add(`${month} ${kind}`);
          return [{ month }];
        },
      } as unknown as DataSource,
      { drafts: async (month: string) => (asked.push(month), { month, issuable: true, drafts: Array.from({ length: waiting }) }) } as unknown as InvoicesService,
      { get: async () => ({ invoiceReminderDay: 3 }) } as unknown as PlatformSettingsService,
      { send: async (mail: Mail) => sent.push(mail) > 0 } as unknown as MailService,
      { getOrThrow: () => ({ operatorEmail, adminUrl: 'https://admin.ff.example' }) } as unknown as ConfigService,
    );

  beforeEach(() => {
    written = new Set();
    sent = [];
    waiting = 2;
    operatorEmail = 'operator@ff.test';
    asked.length = 0;
  });

  it("from the 1st in Tunisia, says last month's invoices are ready, once", async () => {
    const notices = service();

    expect(await notices.notify(new Date('2026-10-31T23:30:00Z'))).toBe('ready'); // already 1 November in Tunisia
    expect(await notices.notify(new Date('2026-11-01T08:00:00Z'))).toBeNull();
    expect(await notices.notify(new Date('2026-11-03T20:00:00Z'))).toBeNull(); // the reminder day itself: still the ready notice's
    expect(asked).toEqual(['2026-10', '2026-10', '2026-10']);
    expect(sent.map((mail) => [mail.to, mail.subject])).toEqual([['operator@ff.test', 'Invoices to issue: October 2026']]);
    expect(sent[0].text).toBe('2 invoices for October 2026 are ready to issue, by the 3rd:\n\nhttps://admin.ff.example/invoices?month=2026-10');
  });

  it('after the reminder day, reminds once that some are still to issue', async () => {
    const notices = service();
    await notices.notify(new Date('2026-11-02T08:00:00Z'));
    waiting = 1;

    expect(await notices.notify(new Date('2026-11-04T08:00:00Z'))).toBe('reminder');
    expect(await notices.notify(new Date('2026-11-20T08:00:00Z'))).toBeNull();
    expect(sent.map((mail) => mail.subject)).toEqual(['Invoices to issue: October 2026', 'Invoices still to issue: October 2026']);
    expect(sent[1].text).toContain('1 invoice for October 2026 is still not issued, past the 3rd');
  });

  it('says nothing while nothing waits, and writes nothing to send later', async () => {
    waiting = 0;
    const notices = service();

    expect(await notices.notify(new Date('2026-11-02T08:00:00Z'))).toBeNull();
    expect([written.size, sent]).toEqual([0, []]);
  });

  it('logs it when there is no operator address, and still writes it once', async () => {
    operatorEmail = '';
    const notices = service();

    expect(await notices.notify(new Date('2026-11-02T08:00:00Z'))).toBe('ready');
    expect([written.size, sent]).toEqual([1, []]);
  });
});

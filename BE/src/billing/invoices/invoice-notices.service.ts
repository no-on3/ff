import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { PlatformSettingsService } from '../../admin/platform-settings.service';
import { describeError } from '../../common/describe-error';
import { MailService } from '../../mail/mail.service';
import { previousMonth, tunisDay } from '../tunisia';
import { operatorInvoicesMail } from './invoice-mail';
import { InvoicesService } from './invoices.service';

const TURN_MS = 10 * 60_000;

/**
 * The operator's e-mails about last month's invoices (P-36, D9): from the 1st,
 * that they are ready to issue; after the platform's invoiceReminderDay, that
 * some still aren't. Each once per month, by whichever backend writes its row
 * in invoice_notices first; none while nothing waits.
 */
@Injectable()
export class InvoiceNoticesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InvoiceNoticesService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly dataSource: DataSource,
    private readonly invoices: InvoicesService,
    private readonly settings: PlatformSettingsService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const turn = () => void this.notify().catch((error: unknown) => this.logger.error(`The invoice notices failed: ${describeError(error)}`));
    turn();
    this.timer = setInterval(turn, TURN_MS);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** Sends the e-mail due now, if any and not sent yet, and answers which. */
  async notify(now = new Date()): Promise<'ready' | 'reminder' | null> {
    const today = tunisDay(now);
    const month = previousMonth(today.slice(0, 7));
    const { invoiceReminderDay } = await this.settings.get();
    const kind = Number(today.slice(8, 10)) > invoiceReminderDay ? 'reminder' : 'ready';
    const { drafts } = await this.invoices.drafts(month, now);
    if (drafts.length === 0) return null;
    const [written] = await this.dataSource.query<Array<{ month: string }>>(
      `INSERT INTO "invoice_notices" ("month", "kind", "waiting") VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING "month"`,
      [month, kind, drafts.length],
    );
    if (!written) return null;
    const { operatorEmail, adminUrl } = this.config.getOrThrow<{ operatorEmail: string; adminUrl: string }>('mail');
    const message = operatorInvoicesMail(kind, month, drafts.length, invoiceReminderDay, adminUrl);
    if (operatorEmail) await this.mail.send({ to: operatorEmail, ...message });
    else this.logger.log(`${message.subject} (no FF_OPERATOR_EMAIL to send it to)`);
    return kind;
  }
}

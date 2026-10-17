import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, Transporter } from 'nodemailer';
import { describeError } from '../common/describe-error';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Sends e-mail through the SMTP server of FF_SMTP_URL (Mailpit in development),
 * or writes it to the log when there is none. Never throws: an e-mail that
 * can't leave mustn't fail the request that wrote it.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly from: string;
  private readonly transport?: Pick<Transporter, 'sendMail'>;

  constructor(config: ConfigService, transport?: Pick<Transporter, 'sendMail'>) {
    const { smtpUrl, from } = config.getOrThrow<{ smtpUrl: string; from: string }>('mail');
    this.from = from;
    this.transport = transport ?? (smtpUrl ? createTransport(smtpUrl) : undefined);
  }

  /** True once the SMTP server took the e-mail. */
  async send(mail: Mail): Promise<boolean> {
    if (!this.transport) {
      this.logger.log(`E-mail not sent (no FF_SMTP_URL) to ${mail.to}: ${mail.subject}\n${mail.text}`);
      return false;
    }
    try {
      await this.transport.sendMail({ from: this.from, to: mail.to, subject: mail.subject, text: mail.text });
      return true;
    } catch (error) {
      this.logger.error(`Could not send "${mail.subject}" to ${mail.to}: ${describeError(error)}`);
      return false;
    }
  }
}

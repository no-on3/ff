import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Transporter, createTransport } from 'nodemailer';
import { Repository } from 'typeorm';
import { describeError } from '../common/describe-error';
import type { EmailSettings, MailServerSettings } from '../config/configuration';
import { EmailIdentitiesService } from './email-identities.service';
import { EmailIdentityStatus, EmailIdentityType } from './email-identity.entity';
import { EmailMessage, EmailMessageStatus, MessageRecipient } from './email-message.entity';
import { domainOf } from './email-names';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The most messages one round takes. */
const BATCH = 10;
/** How long a message taken is the round's: past it, another round tries it again, as a backend that stopped would leave it. */
const LEASE = "interval '5 minutes'";

/** How long a message waits after the server refused it for now, by the times it was tried: 30 s, 2 min, 10 min, 30 min, then hourly. */
export function backoffMs(attempts: number): number {
  return [30_000, 120_000, 600_000, 1_800_000][attempts - 1] ?? 3_600_000;
}

/** A message a round took: what it needs to go. */
interface Taken {
  id: string;
  account_id: string;
  identity: string;
  return_path: string;
  recipients: MessageRecipient[];
  raw: Buffer;
  attempts: number;
  created_at: Date;
}

/** What nodemailer says of a message the server took: whom it refused, and why. */
interface Sent {
  rejected?: Array<string | { address: string }>;
  rejectedErrors?: Array<{ recipient?: string; response?: string }>;
  response?: string;
}

/**
 * The queue of customers' messages, emptied (ADR 0012): each handed to the
 * server of customers' mail by SMTP over TLS, signed with its domain's DKIM
 * key, its envelope's sender its return path, its recipients the ones not
 * suppressed. A refusal for now is tried again, later and later, for a day; a
 * refusal for good fails the message. Every second, and at once when a message
 * is queued; a round's messages are its alone, under a lease, so that two
 * backends never hand one over twice at once.
 */
@Injectable()
export class EmailSender implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmailSender.name);
  private readonly server: MailServerSettings | null;
  private transport?: Transporter;
  private timer?: NodeJS.Timeout;
  private draining: Promise<void> | null = null;
  private again = false;

  constructor(
    @InjectRepository(EmailMessage) private readonly messages: Repository<EmailMessage>,
    private readonly identities: EmailIdentitiesService,
    config: ConfigService,
  ) {
    this.server = config.getOrThrow<EmailSettings>('email').server;
  }

  onModuleInit(): void {
    if (!this.server) return;
    this.open();
    this.timer = setInterval(() => this.kick(), 1000);
  }

  /** The connections to the server, a pool of two: opened at start, and by the tests, which run each round themselves. */
  open(): void {
    if (!this.server || this.transport) return;
    this.transport = createTransport({
      host: this.server.smtpHost,
      port: this.server.smtpPort,
      secure: false,
      requireTLS: this.server.requireTls,
      // nodemailer names the server for TLS itself, its host unless an address, which TLS can't name.
      ...(this.server.ca ? { tls: { ca: this.server.ca } } : {}),
      pool: true,
      maxConnections: 2,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 60_000,
    });
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
    this.transport?.close();
  }

  /** A round now, or once the one under way ends. */
  kick(): void {
    if (!this.transport) return;
    if (this.draining) {
      this.again = true;
      return;
    }
    this.draining = this.drain().finally(() => (this.draining = null));
  }

  /** Until nothing is due: the rounds one after the other. Resolves once they are done. */
  async drain(): Promise<void> {
    do {
      this.again = false;
      try {
        while ((await this.round()) === BATCH);
      } catch (error) {
        this.logger.error(`The customers' mail queue's round failed: ${describeError(error)}`);
      }
    } while (this.again);
  }

  /** One round: the messages due, taken, each handed to the server. Answers how many. */
  async round(): Promise<number> {
    const [taken] = await this.messages.query<[Taken[], number]>(
      `UPDATE "email_messages" SET "attempts" = "attempts" + 1, "next_attempt_at" = now() + ${LEASE}
       WHERE "id" IN (SELECT "id" FROM "email_messages" WHERE "status" = 'QUEUED' AND "next_attempt_at" <= now() ORDER BY "next_attempt_at" LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
       RETURNING "id", "account_id", "identity", "return_path", "recipients", "raw", "attempts", "created_at"`,
    );
    // Oldest first: an UPDATE's RETURNING keeps no order of its own.
    taken.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    for (const message of taken) await this.deliver(message);
    return taken.length;
  }

  /** The DKIM key that signs the message: its identity's domain's, while the account has it proved. */
  private async dkimOf(message: Taken): Promise<{ domainName: string; keySelector: string; privateKey: string } | null> {
    const own = await this.identities.find(message.account_id, message.identity);
    const domain = own?.type === EmailIdentityType.DOMAIN ? own : await this.identities.find(message.account_id, domainOf(message.identity));
    if (!domain || domain.type !== EmailIdentityType.DOMAIN || domain.status !== EmailIdentityStatus.SUCCESS || !domain.dkimSelector) return null;
    return { domainName: domain.identity, keySelector: domain.dkimSelector, privateKey: this.identities.privateKeyOf(domain) };
  }

  private async deliver(message: Taken): Promise<void> {
    const to = message.recipients.filter((recipient) => recipient.status === 'QUEUED').map((recipient) => recipient.address);
    const own = await this.identities.find(message.account_id, message.identity);
    if (!own) return this.fail(message, `The identity ${message.identity} was deleted before the message went`);
    try {
      const dkim = await this.dkimOf(message);
      const sent = (await (this.transport as Transporter).sendMail({ envelope: { from: message.return_path, to }, raw: message.raw, ...(dkim ? { dkim } : {}) })) as Sent;
      const refused = new Map<string, string>();
      for (const error of sent.rejectedErrors ?? []) if (error.recipient) refused.set(error.recipient.toLowerCase(), error.response ?? 'refused');
      for (const one of sent.rejected ?? []) {
        const address = (typeof one === 'string' ? one : one.address).toLowerCase();
        if (!refused.has(address)) refused.set(address, sent.response ?? 'refused');
      }
      const recipients = message.recipients.map((recipient): MessageRecipient => {
        if (recipient.status !== 'QUEUED') return recipient;
        const why = refused.get(recipient.address);
        return why === undefined ? { ...recipient, status: 'SENT' } : { ...recipient, status: 'BOUNCED', permanent: false, diagnostic: why };
      });
      await this.messages.update({ id: message.id }, { status: EmailMessageStatus.SENT, sentAt: new Date(), raw: null, recipients, lastError: null });
    } catch (error) {
      const { responseCode: code, response } = error as { responseCode?: number; response?: string };
      const why = describeError(error);
      if (code !== undefined && code >= 500) return this.fail(message, response ?? why, why);
      // The customer reads the diagnostic: never the network's error, which names the server's address.
      if (Date.now() - new Date(message.created_at).getTime() > DAY_MS) return this.fail(message, "FF's mail server took none of it for a day", why);
      await this.messages.update({ id: message.id }, { nextAttemptAt: new Date(Date.now() + backoffMs(message.attempts)), lastError: why });
      this.logger.warn(`Message ${message.id} of account ${message.account_id} waits: the server of customers' mail said ${why}`);
    }
  }

  /** The message failed for good: each recipient still waiting with it, with the diagnostic the account reads, and its copy dropped. */
  private async fail(message: Taken, diagnostic: string, why = diagnostic): Promise<void> {
    const recipients = message.recipients.map((recipient): MessageRecipient => (recipient.status === 'QUEUED' ? { ...recipient, status: 'FAILED', diagnostic } : recipient));
    await this.messages.update({ id: message.id }, { status: EmailMessageStatus.FAILED, raw: null, recipients, lastError: why });
    this.logger.warn(`Message ${message.id} of account ${message.account_id} failed: ${why}`);
  }
}

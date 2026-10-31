import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { describeError } from '../common/describe-error';
import type { EmailSettings, MailServerSettings } from '../config/configuration';
import { MailService } from '../mail/mail.service';
import { EmailMessage, MessageRecipient } from './email-message.entity';
import { isBounce, isPermanent, readReport } from './email-reports';
import { EmailSending, EnforcementStatus } from './email-sending.entity';
import { SuppressionReason } from './email-suppression.entity';
import { EmailSuppressionsService } from './email-suppressions.service';

/** How often the agent is asked for what came back. */
const POLL_MS = 10_000;
/** The rates SES reviews an account past, then stops it past (ADR 0012): bounces, and complaints, of what it sent. */
export const RATES = { review: { bounces: 0.05, complaints: 0.001 }, stop: { bounces: 0.1, complaints: 0.005 } };
/** The sends a rate is judged on: those of the last 14 days, once there are 100. */
const REVIEW_DAYS = 14;
const REVIEW_MIN_SENT = 100;

/** A message of the agent's: what came back, whole, in base64. */
interface Waiting {
  id: string;
  receivedAt: string;
  message: string;
}

/** Where an account's rates put it: the worse of its bounces' and complaints'. */
export function enforcementOf(sent: number, bounced: number, complained: number): EnforcementStatus {
  if (sent < REVIEW_MIN_SENT) return 'HEALTHY';
  const bounces = bounced / sent;
  const complaints = complained / sent;
  if (bounces >= RATES.stop.bounces || complaints >= RATES.stop.complaints) return 'SHUTDOWN';
  if (bounces >= RATES.review.bounces || complaints >= RATES.review.complaints) return 'PROBATION';
  return 'HEALTHY';
}
const SEVERITY: Record<EnforcementStatus, number> = { HEALTHY: 0, PROBATION: 1, SHUTDOWN: 2 };

/**
 * What comes back for customers' return-path domains (ADR 0012), taken from
 * the agent of the server of customers' mail every 10 seconds: each bounce or
 * complaint read, its message found by its return path, and each recipient's
 * fate kept; a bounce for good or a complaint puts the address on the
 * account's suppression list, as SES's does. Then the account's rates, over
 * its last 14 days: past SES's, it is reviewed, then stopped, the operator told.
 * Each report is deleted from the server once read, kept or not.
 */
@Injectable()
export class EmailBounces implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmailBounces.name);
  private readonly server: MailServerSettings | null;
  private timer?: NodeJS.Timeout;
  private polling = false;

  constructor(
    @InjectRepository(EmailMessage) private readonly messages: Repository<EmailMessage>,
    @InjectRepository(EmailSending) private readonly sending: Repository<EmailSending>,
    private readonly suppressions: EmailSuppressionsService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {
    this.server = config.getOrThrow<EmailSettings>('email').server;
  }

  onModuleInit(): void {
    if (!this.server) return;
    this.timer = setInterval(() => void this.poll().catch((error: unknown) => this.logger.error(`The bounces' round failed: ${describeError(error)}`)), POLL_MS);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** One round: what waits on the server, read, applied, deleted. Answers how many. */
  async poll(): Promise<number> {
    if (!this.server || this.polling) return 0;
    this.polling = true;
    try {
      const { bounces } = (await this.call('GET', '/bounces?limit=20', [200])) as { bounces: Waiting[] };
      for (const waiting of bounces) {
        await this.apply(Buffer.from(waiting.message, 'base64'));
        await this.call('DELETE', `/bounces/${encodeURIComponent(waiting.id)}`, [204, 404]);
      }
      return bounces.length;
    } finally {
      this.polling = false;
    }
  }

  /** A report, applied to its message and its account; nothing when it names no message of FF's. */
  async apply(raw: Buffer): Promise<void> {
    const report = readReport(raw);
    const message = report.messageId ? await this.messages.findOneBy({ id: report.messageId }) : null;
    if (!message) {
      if (report.kind !== 'other') this.logger.warn(`A ${report.kind} came back for no message of FF's (${report.messageId ?? 'no return path of FF'}'s): dropped`);
      return;
    }
    const changes = new Map<string, MessageRecipient>();
    for (const reported of report.recipients) {
      const recipient = message.recipients.find((one) => one.address === reported.address);
      if (!recipient) continue;
      if (report.kind === 'complaint') {
        changes.set(reported.address, { ...recipient, status: 'COMPLAINED', diagnostic: report.feedbackType });
        await this.suppressions.put(null, message.accountId, reported.address, SuppressionReason.COMPLAINT, { messageId: message.id, feedback: report.feedbackType });
      } else if (isBounce(reported)) {
        const permanent = isPermanent(reported);
        changes.set(reported.address, { ...recipient, status: 'BOUNCED', permanent, diagnostic: reported.diagnostic ?? reported.status });
        if (permanent) await this.suppressions.put(null, message.accountId, reported.address, SuppressionReason.BOUNCE, { messageId: message.id, feedback: reported.diagnostic ?? reported.status });
      }
    }
    if (changes.size === 0) return;
    await this.messages.update({ id: message.id }, { recipients: message.recipients.map((one) => changes.get(one.address) ?? one) });
    await this.review(message.accountId);
  }

  /** The account's rates, over its last 14 days: past SES's, reviewed, then stopped, never back by itself; the operator told. */
  async review(accountId: string): Promise<EnforcementStatus> {
    const [counts] = await this.messages.query<Array<{ sent: number; bounced: number; complained: number }>>(
      `SELECT count(*) FILTER (WHERE r->>'status' IN ('SENT', 'BOUNCED', 'COMPLAINED'))::int AS "sent",
              count(*) FILTER (WHERE r->>'status' = 'BOUNCED' AND r->>'permanent' = 'true')::int AS "bounced",
              count(*) FILTER (WHERE r->>'status' = 'COMPLAINED')::int AS "complained"
         FROM "email_messages" m, jsonb_array_elements(m."recipients") r
        WHERE m."account_id" = $1 AND m."created_at" > now() - make_interval(days => $2)`,
      [accountId, REVIEW_DAYS],
    );
    const now = (await this.sending.findOneBy({ accountId }))?.enforcementStatus ?? 'HEALTHY';
    const judged = enforcementOf(counts.sent, counts.bounced, counts.complained);
    if (SEVERITY[judged] <= SEVERITY[now]) return now;
    const reason = `${counts.bounced} bounce(s) for good and ${counts.complained} complaint(s) of ${counts.sent} recipient(s) in ${REVIEW_DAYS} days`;
    await this.sending.query(
      `INSERT INTO "email_sending" ("account_id", "enforcement_status", "reason", "updated_at") VALUES ($1, $2, $3, now())
       ON CONFLICT ("account_id") DO UPDATE SET "enforcement_status" = EXCLUDED."enforcement_status", "reason" = EXCLUDED."reason", "updated_at" = now()`,
      [accountId, judged, reason],
    );
    await this.audit.record({ accountId, action: 'email.sending.enforce', resource: `email-sending:${accountId}`, details: { enforcementStatus: judged, ...counts } });
    const { operatorEmail: operator } = this.config.getOrThrow<{ operatorEmail: string }>('mail');
    if (operator) {
      const what = judged === 'SHUTDOWN' ? 'its sending stopped' : 'its sending reviewed';
      await this.mail.send({ to: operator, subject: `FF: account ${accountId}'s mail, ${what}`, text: `Account ${accountId}'s mail: ${reason}, past SES's rates. Its enforcement is now ${judged}.` });
    }
    this.logger.warn(`Account ${accountId}'s mail is ${judged}: ${reason}`);
    return judged;
  }

  /** One request to the agent; its JSON answer, or an error naming its status. */
  private call(method: string, path: string, expected: number[]): Promise<unknown> {
    const server = this.server as MailServerSettings;
    const url = new URL(path, server.agentUrl);
    // HTTPS, as the settings require; plain HTTP only for the tests' stand-in agent.
    const request = url.protocol === 'http:' ? httpRequest : httpsRequest;
    return new Promise((resolve, reject) => {
      const sent = request(
        url,
        { method, headers: { authorization: `Bearer ${server.agentToken}` }, ...(server.ca ? { ca: server.ca } : {}), timeout: 15_000 },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (!expected.includes(response.statusCode ?? 0)) return reject(new Error(`the mail server's agent answered ${response.statusCode} to ${method} ${path}: ${text}`));
            try {
              resolve(text === '' ? undefined : JSON.parse(text));
            } catch {
              reject(new Error(`the mail server's agent answered ${method} ${path} with something other than JSON`));
            }
          });
          response.on('error', reject);
        },
      );
      sent.on('timeout', () => sent.destroy(new Error(`the mail server's agent didn't answer ${method} ${path} within 15 s`)));
      sent.on('error', reject);
      sent.end();
    });
  }
}

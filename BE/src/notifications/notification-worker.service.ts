import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { describeError } from '../common/describe-error';
import { MailService } from '../mail/mail.service';
import { DeliveryChannel } from './entities/notification-delivery.entity';
import { NotificationsService } from './notifications.service';
import { nextAttempt } from './retry';
import { signatureHeader } from './signature';
import { postWebhook } from './webhook-client';
import { resolveWebhook } from './webhook-target';
import { notificationAttempts } from '../monitoring/operator-metrics';

/** The most deliveries one backend sends at once. */
export const BATCH = 10;
/** How long a backend holds the deliveries it took: another one takes them again after, should it have stopped. */
export const LEASE_MS = 5 * 60_000;
/** How long a webhook has to answer. */
export const WEBHOOK_TIMEOUT_MS = 5_000;

/** A claimed delivery, as the claim's SQL returns it. */
interface Due {
  id: string;
  account_id: string;
  notification_id: string;
  kind: string;
  channel: DeliveryChannel;
  target: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/** How an attempt went. */
type Outcome = { delivered: true; status?: number } | { delivered: false; error: string; status?: number; final?: boolean };

/**
 * Sends the notifications that are due, every FF_NOTIFY_INTERVAL_SECONDS:
 * ten at a time, each taken with FOR UPDATE SKIP LOCKED and held for five
 * minutes, so that two backends never send one twice and one that stops
 * leaves them to another. A failed delivery is tried again later, up to 5
 * times, then it is failed.
 */
@Injectable()
export class NotificationWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationWorker.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<number>;
  /** The webhook's timeout: tests shorten it. */
  timeoutMs = WEBHOOK_TIMEOUT_MS;

  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const { intervalSeconds } = this.config.getOrThrow<{ intervalSeconds: number }>('notifications');
    this.timer = setInterval(() => void this.tick(), intervalSeconds * 1000);
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  /** One round: the deliveries due, sent at once; how many were tried. A round still running is waited for, never doubled. */
  async tick(now = new Date()): Promise<number> {
    if (this.running) return this.running;
    this.running = this.round(now).finally(() => (this.running = undefined));
    return this.running;
  }

  private async round(now: Date): Promise<number> {
    let due: Due[];
    try {
      due = await this.claim(now);
    } catch (error) {
      this.logger.error(`Could not take the notifications due: ${describeError(error)}`);
      return 0;
    }
    await Promise.all(due.map((delivery) => this.attempt(delivery, now)));
    return due.length;
  }

  /** Takes the deliveries due, each attempt counted now and held for the lease. */
  private async claim(now: Date): Promise<Due[]> {
    const [rows] = await this.dataSource.query<[Due[], number]>(
      `UPDATE "notification_deliveries" SET "attempts" = "attempts" + 1, "next_attempt_at" = $2
        WHERE "id" IN (SELECT "id" FROM "notification_deliveries"
                        WHERE "status" = 'pending' AND "next_attempt_at" <= $1
                        ORDER BY "next_attempt_at" LIMIT $3 FOR UPDATE SKIP LOCKED)
        RETURNING "id", "account_id", "notification_id", "kind", "channel", "target", "payload", "attempts"`,
      [now, new Date(now.getTime() + LEASE_MS), BATCH],
    );
    return rows;
  }

  private async attempt(delivery: Due, now: Date): Promise<void> {
    let outcome: Outcome;
    try {
      outcome = delivery.channel === DeliveryChannel.EMAIL ? await this.email(delivery) : await this.webhook(delivery, now);
    } catch (error) {
      outcome = { delivered: false, error: describeError(error) };
    }
    try {
      await this.record(delivery, outcome, now);
    } catch (error) {
      this.logger.error(`Could not record how delivery ${delivery.id} went: ${describeError(error)}`);
    }
  }

  private async email(delivery: Due): Promise<Outcome> {
    if (!this.mail.sends) return { delivered: false, final: true, error: 'FF_SMTP_URL is not set: the e-mail was written to the backend log instead' };
    const { subject, text } = delivery.payload as { subject: string; text: string };
    return (await this.mail.send({ to: delivery.target, subject, text })) ? { delivered: true } : { delivered: false, error: 'the SMTP server did not take the e-mail' };
  }

  private async webhook(delivery: Due, now: Date): Promise<Outcome> {
    const url = new URL(delivery.target);
    const { allowPrivate } = this.config.getOrThrow<{ allowPrivate: boolean }>('notifications');
    const target = await resolveWebhook(url, allowPrivate);
    if ('problem' in target) return { delivered: false, error: target.problem };
    const body = JSON.stringify(delivery.payload);
    const secrets = await this.notifications.signingSecrets(delivery.account_id, now);
    const status = await postWebhook({
      url,
      ...target,
      body,
      timeoutMs: this.timeoutMs,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'FF-Webhooks/1',
        'ff-event-id': delivery.notification_id,
        'ff-event-type': delivery.kind,
        'ff-delivery-id': delivery.id,
        'ff-signature': signatureHeader(secrets, body, new Date()),
      },
    });
    if (status >= 200 && status < 300) return { delivered: true, status };
    return { delivered: false, status, error: status >= 300 && status < 400 ? `HTTP ${status}: redirects aren't followed` : `HTTP ${status}` };
  }

  /** Delivered, or to be tried again later, or failed for good after its last attempt. */
  private async record(delivery: Due, outcome: Outcome, now: Date): Promise<void> {
    if (outcome.delivered) {
      notificationAttempts.inc({ channel: delivery.channel, result: 'delivered' });
      await this.dataSource.query(
        `UPDATE "notification_deliveries" SET "status" = 'delivered', "delivered_at" = now(), "last_error" = NULL, "response_status" = $2 WHERE "id" = $1`,
        [delivery.id, outcome.status ?? null],
      );
      return;
    }
    const next = outcome.final ? null : nextAttempt(delivery.attempts, now);
    notificationAttempts.inc({ channel: delivery.channel, result: next ? 'retry' : 'failed' });
    await this.dataSource.query(
      `UPDATE "notification_deliveries" SET "status" = $2, "next_attempt_at" = coalesce($3, "next_attempt_at"), "last_error" = $4, "response_status" = $5 WHERE "id" = $1`,
      [delivery.id, next ? 'pending' : 'failed', next, outcome.error, outcome.status ?? null],
    );
    if (!next) this.logger.warn(`Notification delivery ${delivery.id} (${delivery.channel} to ${delivery.target}) failed for good: ${outcome.error}`);
  }
}

import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { Membership } from '../accounts/entities/membership.entity';
import { AuditService } from '../audit/audit.service';
import { Language, languageOf } from '../mail/language';
import type { Mail } from '../mail/mail.service';
import { DeliveryChannel, DeliveryStatus, NotificationDelivery } from './entities/notification-delivery.entity';
import { WebhookSecret } from './entities/webhook-secret.entity';
import { testMail } from './notification-mail';
import { newSecret } from './signature';
import { webhookUrlProblem } from './webhook-target';

/** How long the previous secret still signs after a rotation, so that receivers can change over. */
export const PREVIOUS_SECRET_MS = 24 * 60 * 60 * 1000;
/** The most deliveries GET /notifications/deliveries gives. */
export const MAX_LISTED = 100;

/** A notification to send: what happened, the webhooks' data, and the owners' e-mail, each in their language. */
export interface Notification {
  accountId: string;
  kind: string;
  data: Record<string, unknown>;
  email?: (language: Language) => Omit<Mail, 'to'>;
  webhookUrls?: string[];
}

export interface DeliveryView {
  id: string;
  notificationId: string;
  kind: string;
  channel: DeliveryChannel;
  target: string;
  status: DeliveryStatus;
  attempts: number;
  lastError: string | null;
  responseStatus: number | null;
  createdAt: Date;
  deliveredAt: Date | null;
  /** When it is tried next; null once delivered or failed. */
  nextAttemptAt: Date | null;
}

export const deliveryView = (row: NotificationDelivery): DeliveryView => ({
  id: row.id,
  notificationId: row.notificationId,
  kind: row.kind,
  channel: row.channel,
  target: row.target,
  status: row.status,
  attempts: row.attempts,
  lastError: row.lastError,
  responseStatus: row.responseStatus,
  createdAt: row.createdAt,
  deliveredAt: row.deliveredAt,
  nextAttemptAt: row.status === DeliveryStatus.PENDING ? row.nextAttemptAt : null,
});

/**
 * Notifications: each one written as its deliveries, an e-mail to each owner
 * and a POST to each webhook URL, which NotificationWorker sends; the
 * account's signing secret; a test; and the account's latest deliveries.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  /** The account's signing secret, made now if it has none. */
  async secret(accountId: string, manager: EntityManager = this.dataSource.manager): Promise<WebhookSecret> {
    await manager.query(`INSERT INTO "webhook_secrets" ("account_id", "secret") VALUES ($1, $2) ON CONFLICT ("account_id") DO NOTHING`, [accountId, newSecret()]);
    return manager.getRepository(WebhookSecret).findOneByOrFail({ accountId });
  }

  /** The secrets that sign the account's webhooks now: the current one, and the previous one for a day after a rotation. */
  async signingSecrets(accountId: string, now = new Date()): Promise<string[]> {
    const { secret, previousSecret, previousExpiresAt } = await this.secret(accountId);
    return previousSecret && previousExpiresAt && previousExpiresAt > now ? [secret, previousSecret] : [secret];
  }

  /** A new secret; the previous one signs too for a day. Recorded in the account's audit log, without either secret. */
  async rotate(accountId: string, now = new Date()): Promise<WebhookSecret> {
    return this.dataSource.transaction(async (manager) => {
      const current = await this.secret(accountId, manager);
      await manager.query(
        `UPDATE "webhook_secrets" SET "previous_secret" = "secret", "previous_expires_at" = $2, "secret" = $3, "created_at" = $4 WHERE "account_id" = $1`,
        [accountId, new Date(now.getTime() + PREVIOUS_SECRET_MS), newSecret(), now],
      );
      await this.audit.record({ accountId, action: 'webhook_secret.rotate', resource: `account:${accountId}`, details: { previousCreatedAt: current.createdAt } }, manager);
      return manager.getRepository(WebhookSecret).findOneByOrFail({ accountId });
    });
  }

  /**
   * Writes a notification's deliveries, to be sent by the worker: an e-mail
   * to each owner with an address, in their language, and a POST to each
   * webhook URL, each with the same notification ID.
   */
  async notify(notification: Notification, manager: EntityManager = this.dataSource.manager): Promise<NotificationDelivery[]> {
    const notificationId = randomUUID();
    const createdAt = new Date();
    const rows: Array<Partial<NotificationDelivery>> = [];
    const base = { accountId: notification.accountId, notificationId, kind: notification.kind, status: DeliveryStatus.PENDING, createdAt, nextAttemptAt: createdAt };
    if (notification.email) {
      const owners = await manager.getRepository(Membership).find({ where: { accountId: notification.accountId, role: 'owner' }, relations: { user: true }, order: { createdAt: 'ASC' } });
      const composed = new Map<Language, Omit<Mail, 'to'>>();
      for (const { user } of owners) {
        if (!user?.email) continue;
        const language = languageOf(user.locale);
        if (!composed.has(language)) composed.set(language, notification.email(language));
        rows.push({ ...base, channel: DeliveryChannel.EMAIL, target: user.email, payload: { ...composed.get(language) } });
      }
    }
    const body = { id: notificationId, type: notification.kind, account: notification.accountId, createdAt: createdAt.toISOString(), data: notification.data };
    for (const url of notification.webhookUrls ?? []) rows.push({ ...base, channel: DeliveryChannel.WEBHOOK, target: url, payload: body });
    if (rows.length === 0) return [];
    return manager.getRepository(NotificationDelivery).save(rows);
  }

  /**
   * POST /notifications/test: a test notification to a webhook URL, to the
   * owners' e-mail, or both, sent as the alarms' will be. Recorded in the
   * account's audit log, with the URL.
   */
  async test(accountId: string, request: { webhookUrl?: string; email?: boolean }, requestedBy: string): Promise<{ notificationId: string; deliveries: DeliveryView[] }> {
    if (!request.webhookUrl && !request.email) throw new BadRequestException('Name a webhookUrl, or ask for the e-mail with email: true, or both');
    const problem = request.webhookUrl ? webhookUrlProblem(request.webhookUrl) : null;
    if (problem) throw new BadRequestException(problem);
    const { consoleUrl } = this.config.getOrThrow<{ consoleUrl: string }>('mail');
    return this.dataSource.transaction(async (manager) => {
      const account = await manager.getRepository(Account).findOneByOrFail({ id: accountId });
      const deliveries = await this.notify(
        {
          accountId,
          kind: 'test',
          data: { message: 'A test notification from FF', requestedBy },
          email: request.email ? (language) => testMail({ account, requestedBy, consoleUrl }, language) : undefined,
          webhookUrls: request.webhookUrl ? [request.webhookUrl] : [],
        },
        manager,
      );
      if (request.email && !deliveries.some((delivery) => delivery.channel === DeliveryChannel.EMAIL)) {
        throw new BadRequestException("This account has no owner with an e-mail address to send the test to: development mode's account has none");
      }
      await this.audit.record(
        { accountId, action: 'notification.test', resource: `notification:${deliveries[0].notificationId}`, details: { webhookUrl: request.webhookUrl ?? null, email: !!request.email } },
        manager,
      );
      return { notificationId: deliveries[0].notificationId, deliveries: deliveries.map(deliveryView) };
    });
  }

  /** GET /notifications/deliveries: the account's latest, newest first. */
  async deliveries(accountId: string, limit = 50): Promise<DeliveryView[]> {
    const rows = await this.dataSource.getRepository(NotificationDelivery).find({
      where: { accountId },
      order: { createdAt: 'DESC', id: 'ASC' },
      take: Math.min(Math.max(limit, 1), MAX_LISTED),
    });
    return rows.map(deliveryView);
  }
}

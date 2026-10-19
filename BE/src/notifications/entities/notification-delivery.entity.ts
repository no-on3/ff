import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Account } from '../../accounts/entities/account.entity';

export enum DeliveryChannel {
  EMAIL = 'email',
  WEBHOOK = 'webhook',
}

export enum DeliveryStatus {
  /** Not sent yet, or to be tried again at nextAttemptAt. */
  PENDING = 'pending',
  /** The SMTP server took the e-mail, or the webhook answered 2xx. */
  DELIVERED = 'delivered',
  /** Every attempt failed: lastError says how the last one did. */
  FAILED = 'failed',
}

/**
 * One delivery of a notification: an e-mail to one owner, in their language,
 * rendered when the notification was made, or a POST to one webhook URL. A
 * worker sends those due, tries a failed one again later, and records how
 * each attempt went. Kept 30 days.
 */
@Entity('notification_deliveries')
@Check(`"channel" IN ('email', 'webhook')`)
@Check(`"status" IN ('pending', 'delivered', 'failed')`)
@Check(`("status" = 'delivered') = ("delivered_at" IS NOT NULL)`)
@Index(['accountId', 'createdAt'])
@Index('IDX_notification_deliveries_due', ['nextAttemptAt'], { where: `"status" = 'pending'` })
export class NotificationDelivery {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  @ManyToOne(() => Account)
  @JoinColumn({ name: 'account_id' })
  account?: Account;

  /** The notification it delivers, the same for each of its deliveries: a webhook's FF-Event-Id. */
  @Column({ type: 'uuid' })
  notificationId: string;

  /** What happened: "test" for now; alarms add theirs. */
  @Column({ type: 'text' })
  kind: string;

  @Column({ type: 'text' })
  channel: DeliveryChannel;

  /** The e-mail address, or the webhook's URL. */
  @Column({ type: 'text' })
  target: string;

  /** The e-mail's subject and text, or the webhook's JSON body. */
  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ type: 'text', default: DeliveryStatus.PENDING })
  status: DeliveryStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  /** When it is due: its next try, or the end of the lease of the backend sending it. */
  @Column({ type: 'timestamptz', default: () => 'now()' })
  nextAttemptAt: Date;

  /** How the last failed attempt went: "HTTP 500", "timed out after 5 s"… */
  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  /** The webhook's last HTTP status. */
  @Column({ type: 'int', nullable: true })
  responseStatus: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;
}

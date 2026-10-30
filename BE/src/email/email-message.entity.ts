import { Check, Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

export enum EmailMessageStatus {
  /** Waiting for the server of customers' mail to take it. */
  QUEUED = 'QUEUED',
  /** The server took it: it delivers it, and sends back what bounces. */
  SENT = 'SENT',
  /** The server refused it for good, or took none of it for a day. */
  FAILED = 'FAILED',
}

/** What became of one recipient, as SES's events name it: delivered to the server, kept off by the suppression list, bounced, complained of. */
export type RecipientStatus = 'QUEUED' | 'SENT' | 'SUPPRESSED' | 'BOUNCED' | 'COMPLAINED' | 'FAILED';

export interface MessageRecipient {
  address: string;
  status: RecipientStatus;
  /** A bounce for good, which puts the address on the suppression list; one for now doesn't. */
  permanent?: boolean;
  /** What the receiving server said, for a bounce or a failure. */
  diagnostic?: string;
}

/**
 * A message an account sent through the SES endpoint (ADR 0012), SES's
 * MessageId its ID: queued at once, then handed to the server of customers'
 * mail, signed with its domain's DKIM key, its return path naming it
 * (b-<id>@bounces.mail.<domain>) so that its bounces say whose they are. Its
 * recipients each count against the quotas, a suppressed one too, as SES counts
 * them. The message itself is kept until the server takes it.
 */
@Entity('email_messages')
@Index(['accountId', 'createdAt'])
@Index(['status', 'nextAttemptAt'])
@Check(`"status" IN ('QUEUED', 'SENT', 'FAILED')`)
export class EmailMessage {
  @PrimaryColumn({ type: 'uuid' })
  id: string;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  /** The identity it went from, a domain or an address, whose DKIM key signs it when it has one. */
  @Column({ type: 'varchar', length: 320 })
  identity: string;

  @Column({ type: 'varchar', length: 320 })
  fromAddress: string;

  /** Its envelope's sender, where what bounces comes back. */
  @Column({ type: 'varchar', length: 400 })
  returnPath: string;

  @Column({ type: 'jsonb' })
  recipients: MessageRecipient[];

  @Column({ type: 'integer' })
  recipientCount: number;

  @Column({ type: 'integer' })
  sizeBytes: number;

  @Column({ type: 'bytea', nullable: true, select: false })
  raw: Buffer | null;

  @Column({ type: 'text', default: EmailMessageStatus.QUEUED })
  status: EmailMessageStatus;

  @Column({ type: 'integer', default: 0 })
  attempts: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  nextAttemptAt: Date;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt: Date | null;
}

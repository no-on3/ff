import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * A message an account sent, as SES bills it (ADR 0012): its recipients, each
 * one, a suppressed one too, and what its attachments weigh. Written with the
 * message, in the same transaction, never changed (a trigger refuses UPDATE
 * and DELETE), partitioned by month on when it was sent, as usage records
 * are: mail is billed from these, kept as long as the bill is, where the
 * message itself goes after 30 days. No foreign key: it outlives its identity,
 * whose name it keeps.
 */
@Entity('email_sends')
@Index(['accountId', 'sentAt'])
export class EmailSend {
  /** The message's ID, SES's MessageId. */
  @PrimaryColumn({ type: 'uuid' })
  messageId: string;

  /** When it was taken: the partition key, so part of the primary key. */
  @PrimaryColumn({ type: 'timestamptz' })
  sentAt: Date;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  /** The domain or address it went from, which the bill names. */
  @Column({ type: 'varchar', length: 320 })
  identity: string;

  @Column({ type: 'integer' })
  recipients: number;

  /** What its attachments weigh as sent, which SES bills by the GB, each recipient's copy. */
  @Column({ type: 'integer' })
  attachmentBytes: number;
}

import { Check, Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Why an address is suppressed, as SES v2's SuppressionListReason names it. */
export enum SuppressionReason {
  BOUNCE = 'BOUNCE',
  COMPLAINT = 'COMPLAINT',
}

/**
 * An address on an account's suppression list (ADR 0012), as SES v2 keeps
 * one: the account's mail never goes to it while it is there. A hard bounce or
 * a complaint puts it there; the account may put an address there itself, and
 * take one off.
 */
@Entity('email_suppressions')
@Check(`"reason" IN ('BOUNCE', 'COMPLAINT')`)
export class EmailSuppression {
  @PrimaryColumn({ type: 'char', length: 12 })
  accountId: string;

  /** The address, in lower case. */
  @PrimaryColumn({ type: 'varchar', length: 320 })
  address: string;

  @Column({ type: 'text' })
  reason: SuppressionReason;

  /** The message whose bounce or complaint put it there; null when the account did. */
  @Column({ type: 'text', nullable: true })
  messageId: string | null;

  /** What the receiving server answered, for a bounce: its status and its words. */
  @Column({ type: 'text', nullable: true })
  feedback: string | null;

  /** When it was put there last, as SES's LastUpdateTime. */
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

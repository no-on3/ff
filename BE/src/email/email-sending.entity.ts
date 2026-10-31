import { Check, Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** As SES's EnforcementStatus: reviewed past its bounce or complaint rate, then stopped. */
export type EnforcementStatus = 'HEALTHY' | 'PROBATION' | 'SHUTDOWN';

/**
 * An account's sending, as SES keeps it (ADR 0012): in the sandbox until an
 * operator lets it out; paused by one; reviewed, then stopped, past its bounce
 * or complaint rate. An account without a row is in the sandbox, sending,
 * healthy.
 */
@Entity('email_sending')
@Check(`"enforcement_status" IN ('HEALTHY', 'PROBATION', 'SHUTDOWN')`)
export class EmailSending {
  @PrimaryColumn({ type: 'char', length: 12 })
  accountId: string;

  /** Out of the sandbox: mail may go to any address. */
  @Column({ type: 'boolean', default: false })
  productionAccess: boolean;

  @Column({ type: 'boolean', default: true })
  sendingEnabled: boolean;

  @Column({ type: 'text', default: 'HEALTHY' })
  enforcementStatus: EnforcementStatus;

  /** Why it was last changed, by an operator or by its rates. */
  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

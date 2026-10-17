import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One change to an account, by whom, from where (client-readiness plan, P-17).
 * Append-only: a database trigger refuses UPDATE, DELETE and TRUNCATE. No
 * foreign key: the record outlives what it describes, even the account.
 */
@Entity('audit_log')
@Index(['accountId', 'id'])
export class AuditEntry {
  /** bigserial: TypeORM reads it as a string. */
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  /** null for an action on no account (the admin dashboard's, P-70). */
  @Column({ type: 'char', length: 12, nullable: true })
  accountId: string | null;

  /** user:<id>, key:<id>, dev, or system. */
  @Column({ type: 'text' })
  actor: string;

  /** The actor as people know it then: the user's e-mail, or the key's name. */
  @Column({ type: 'text' })
  actorLabel: string;

  /** What happened: function.create, member.role, … */
  @Column({ type: 'text' })
  action: string;

  /** What it happened to: function:<id>, api_key:<id>, user:<id>, invitation:<id>, account:<id>. */
  @Column({ type: 'text', nullable: true })
  resource: string | null;

  /** The caller's address, as the backend saw it. */
  @Column({ type: 'text', nullable: true })
  ip: string | null;

  /** The request that made the change, as in x-ff-request-id and the logs. */
  @Column({ type: 'text', nullable: true })
  requestId: string | null;

  @Column({ type: 'jsonb', nullable: true })
  details: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  at: Date;
}

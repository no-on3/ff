import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Where a database is in its life. */
export enum DatabaseStatus {
  /** Being made on the server: counted against the plan, not yet usable. */
  CREATING = 'creating',
  ACTIVE = 'active',
  /** Past its plan's storage: its new sessions start read-only, a signal rather than a wall (ADR 0008). */
  READ_ONLY = 'read_only',
  /** Its account is suspended or closed: its user can't log in. */
  SUSPENDED = 'suspended',
  /** Being dropped. */
  DELETING = 'deleting',
}

/**
 * A customer's PostgreSQL database (ADR 0008): one database and its user, both
 * named `dbName`, opaque, on a server of customers' databases. The customer's
 * own name for it is `name`, unique in its account, which the server never
 * sees. FF keeps no copy of the password, only when it was set.
 */
@Entity('databases')
@Index(['accountId', 'name'], { unique: true })
@Check(`"status" IN ('creating', 'active', 'read_only', 'suspended', 'deleting')`)
@Check(`"storage_notice" IN (80, 100)`)
export class Database {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  /** The customer's name for it: lower-case letters, digits and hyphens, as RDS names its instances. */
  @Column({ type: 'varchar', length: 63 })
  name: string;

  /** The server it lives on: "default", the one FF_DATA_DB_* names, until there are several. */
  @Column({ type: 'text', default: 'default' })
  server: string;

  /** The database's and its user's name on the server: ff_ and 24 random hexadecimal characters. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 27 })
  dbName: string;

  @Column({ type: 'text', default: DatabaseStatus.CREATING })
  status: DatabaseStatus;

  /** When its password was last made: at creation, then at each reset. */
  @Column({ type: 'timestamptz', nullable: true })
  passwordSetAt: Date | null;

  /** The share of its plan's storage its owners were last told it reached: 80, then 100; null below 80%. */
  @Column({ type: 'smallint', nullable: true })
  storageNotice: 80 | 100 | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

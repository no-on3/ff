import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Where a cache is in its life. */
export enum CacheStatus {
  /** Being made on the server: counted against the plan, not yet usable. */
  CREATING = 'creating',
  ACTIVE = 'active',
  /** Its account is suspended or closed: its user can't log in. */
  SUSPENDED = 'suspended',
  /** Being deleted. */
  DELETING = 'deleting',
}

/**
 * A customer's cache (ADR 0013): a Valkey process of its own on the server of
 * customers' caches, named there `serverName`, opaque, at its own port, with
 * the plan's memory. The customer's own name for it is `name`, unique in its
 * account, which the server never sees. FF keeps no copy of the password, only
 * its SHA-256, as the server's ACL file has it, and when it was set.
 */
@Entity('caches')
@Index(['accountId', 'name'], { unique: true })
@Check(`"status" IN ('creating', 'active', 'suspended', 'deleting')`)
export class Cache {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  /** The customer's name for it: lower-case letters, digits and hyphens, as ElastiCache names its clusters. */
  @Column({ type: 'varchar', length: 40 })
  name: string;

  /** The server it lives on: "default", the one FF_CACHE_* names, until there are several. */
  @Column({ type: 'text', default: 'default' })
  server: string;

  /** Its name on the server: fc- and 24 random hexadecimal characters. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 27 })
  serverName: string;

  /** Its port on the server, which its address names: one cache's alone. */
  @Index({ unique: true })
  @Column({ type: 'integer' })
  port: number;

  /** Its memory, as Valkey's maxmemory: the plan's when it was made. */
  @Column({ type: 'integer' })
  memoryMb: number;

  @Column({ type: 'text', default: CacheStatus.CREATING })
  status: CacheStatus;

  /** Its password's SHA-256, as the server's ACL file has it: FF never keeps the password, only this, to send again. */
  @Column({ type: 'char', length: 64 })
  passwordSha256: string;

  /** When its password was last made: at creation, then at each reset. */
  @Column({ type: 'timestamptz', nullable: true })
  passwordSetAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { FunctionUrl } from '../functions/entities/function-url.entity';

/** Where a domain stands: added, and waiting for its DNS records; or proved, and served. */
export enum DomainStatus {
  PENDING = 'pending',
  VERIFIED = 'verified',
}

/**
 * A customer's own domain for a function's URL: the URL answers there once the
 * DNS proves the account controls it, and the edge gets a certificate for it on
 * demand. A domain is in an account once at most, and verified in one account
 * at most: another account may add it too, but can't take it once proved, so
 * nobody holds a domain by adding it first. It goes with its URL, and so with
 * its function.
 */
@Entity('custom_domains')
@Index(['accountId', 'domain'], { unique: true })
@Index('UQ_custom_domains_verified_domain', ['domain'], { unique: true, where: `"status" = 'verified'` })
export class CustomDomain {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Lower case, without a final dot. */
  @Column({ type: 'varchar', length: 253 })
  domain: string;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  @Index()
  @Column('uuid')
  functionId: string;

  @ManyToOne(() => FunctionUrl, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'function_id', referencedColumnName: 'functionId' })
  url?: FunctionUrl;

  /** Random: the value of the TXT record that proves a domain apex, which can't be a CNAME. */
  @Column({ type: 'char', length: 32 })
  token: string;

  @Column({ type: 'enum', enum: DomainStatus, default: DomainStatus.PENDING })
  status: DomainStatus;

  /** The last check of its records, and what it found wrong. */
  @Column({ type: 'timestamptz', nullable: true })
  checkedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  checkError: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  verifiedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

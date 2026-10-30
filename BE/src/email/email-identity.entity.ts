import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { Sealed } from '../encryption/envelope';

/** What an identity is, as SES v2 names it. */
export enum EmailIdentityType {
  DOMAIN = 'DOMAIN',
  EMAIL_ADDRESS = 'EMAIL_ADDRESS',
}

/** Where its proof is, as SES v2's VerificationStatus names it. */
export enum EmailIdentityStatus {
  /** Its records not found yet, or its link not followed. */
  PENDING = 'PENDING',
  SUCCESS = 'SUCCESS',
  /** Its records not found within 72 hours of its making: proved no more until it is checked again. */
  FAILED = 'FAILED',
  /** Proved once, its record gone since: it sends nothing until the record is back. */
  TEMPORARY_FAILURE = 'TEMPORARY_FAILURE',
}

/**
 * A domain or an address an account may send mail from (ADR 0012), as SES v2
 * keeps an email identity. A domain is proved by its DKIM record, the public
 * half of a key FF made for it, as SES's "bring your own DKIM" takes one; FF
 * signs each message from it with the private half, which it keeps sealed. An
 * address is proved by the link FF e-mails it, whose token's SHA-256 alone is
 * kept; in the sandbox, the account sends only to the addresses it proved.
 * Each identity is its account's once, in lower case.
 */
@Entity('email_identities')
@Index(['accountId', 'identity'], { unique: true })
@Check(`"type" IN ('DOMAIN', 'EMAIL_ADDRESS')`)
@Check(`"status" IN ('PENDING', 'SUCCESS', 'FAILED', 'TEMPORARY_FAILURE')`)
export class EmailIdentity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  /** The domain, or the address, in lower case. */
  @Column({ type: 'varchar', length: 320 })
  identity: string;

  @Column({ type: 'text' })
  type: EmailIdentityType;

  @Column({ type: 'text', default: EmailIdentityStatus.PENDING })
  status: EmailIdentityStatus;

  /** A domain's DKIM selector, ff and 8 hexadecimal characters: its record is at <selector>._domainkey.<domain>. */
  @Column({ type: 'varchar', length: 63, nullable: true })
  dkimSelector: string | null;

  /** A domain's DKIM public key, as its record's p= gives it: base64 of its SubjectPublicKeyInfo. */
  @Column({ type: 'text', nullable: true })
  dkimPublicKey: string | null;

  /** A domain's DKIM private key, PKCS #8 PEM, sealed for this identity's ID. */
  @Column({ type: 'jsonb', nullable: true })
  dkimPrivateKey: Sealed | null;

  /** Whether its return-path domain, bounces.mail.<domain>, has its MX record to FF's mail server: then bounces come back there. */
  @Column({ type: 'boolean', default: false })
  mailFromVerified: boolean;

  /** An address's link's token, its SHA-256: FF keeps no copy of the token, only this, until the link is followed. */
  @Column({ type: 'char', length: 64, nullable: true })
  verificationTokenSha256: string | null;

  /** When it was proved: its record found, or its link followed. */
  @Column({ type: 'timestamptz', nullable: true })
  verifiedAt: Date | null;

  /** When a domain's records were last looked up. */
  @Column({ type: 'timestamptz', nullable: true })
  checkedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { In, LessThan, QueryFailedError, Repository } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { AuditService } from '../audit/audit.service';
import { describeError } from '../common/describe-error';
import { Actor } from '../common/request-context';
import type { EmailSettings } from '../config/configuration';
import { EncryptionService } from '../encryption/encryption.service';
import { DnsUnavailableError } from '../function-urls/domain-check';
import { MailService } from '../mail/mail.service';
import { PlansService } from '../plans/plans.service';
import { EmailIdentity, EmailIdentityStatus, EmailIdentityType } from './email-identity.entity';
import { identityKey, identityOf } from './email-names';
import { MailRecord, MailResolver, checkMailDomain, mailDomainRecords, newDkimKey } from './mail-domain';

/** Injection token for the DNS questions a domain's check asks. */
export const MAIL_RESOLVER = Symbol('MAIL_RESOLVER');

/** PostgreSQL's unique_violation: the account has the identity already. */
const UNIQUE_VIOLATION = '23505';
const MINUTE_MS = 60_000;
/** How long a domain's records are looked for before it is FAILED, as SES gives them: 72 hours. */
const PROOF_HOURS = 72;
/** A domain proved is looked at again once a day: its record gone, it sends nothing until it is back. */
const RECHECK_MS = 24 * 60 * MINUTE_MS;

/** Why an identity can't be made, as the SES endpoint and FF's API each say it. */
export class IdentityRefusal extends Error {
  constructor(
    readonly kind: 'invalid' | 'exists' | 'limit',
    message: string,
  ) {
    super(message);
  }
}

/** Who asks, for the audit log: the request's caller by default; an access key at the SES endpoint. */
export interface IdentityCaller {
  accountId: string;
  actor?: Actor;
  ip?: string;
}

/** The private key a domain's DKIM signature is made with, sealed for its identity. */
const sealedFor = (identityId: string): string => `email-dkim/${identityId}`;
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * An account's email identities (ADR 0012), as SES v2 keeps them, for the
 * SES endpoint and FF's API alike. A domain, within the plan's
 * `emailIdentities`, gets a DKIM key of its own, its records to publish, and
 * is looked up every minute until they are found, then once a day; an address
 * gets a link, e-mailed through FF's own mail, whose following proves it.
 * Each made, proved and deleted in the account's audit log.
 */
@Injectable()
export class EmailIdentitiesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmailIdentitiesService.name);
  private readonly settings: EmailSettings;
  /** The SES endpoint, which an address's link goes to. */
  private readonly sesBase: string;
  private timer?: NodeJS.Timeout;

  constructor(
    @InjectRepository(EmailIdentity) private readonly identities: Repository<EmailIdentity>,
    private readonly plans: PlansService,
    private readonly encryption: EncryptionService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    @Inject(MAIL_RESOLVER) private readonly resolver: MailResolver,
    config: ConfigService,
  ) {
    this.settings = config.getOrThrow<EmailSettings>('email');
    this.sesBase = config.getOrThrow<string>('ses.base');
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.checkDue().catch((error: unknown) => this.logger.error(`The domains' check failed: ${describeError(error)}`)), MINUTE_MS);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** The account's identities, by name. */
  list(accountId: string): Promise<EmailIdentity[]> {
    return this.identities.find({ where: { accountId }, order: { identity: 'ASC' } });
  }

  /** The account's identity of that name, in any case; null for none. */
  find(accountId: string, name: string): Promise<EmailIdentity | null> {
    return this.identities.findOneBy({ accountId, identity: identityKey(name) });
  }

  /** The account's identities among these names, by name: what a message's sender is checked against. */
  async findAll(accountId: string, names: string[]): Promise<Map<string, EmailIdentity>> {
    const rows = names.length === 0 ? [] : await this.identities.findBy({ accountId, identity: In(names.map(identityKey)) });
    return new Map(rows.map((row) => [row.identity, row]));
  }

  /** The records a domain publishes; none for an address. */
  recordsOf(identity: EmailIdentity): MailRecord[] {
    if (identity.type !== EmailIdentityType.DOMAIN || !identity.dkimSelector || !identity.dkimPublicKey) return [];
    return mailDomainRecords(identity.identity, identity.dkimSelector, identity.dkimPublicKey, this.settings.mailHost);
  }

  /** A domain's DKIM private key, PKCS #8 PEM, which signs its messages. */
  privateKeyOf(identity: EmailIdentity): string {
    if (!identity.dkimPrivateKey) throw new Error(`Identity ${identity.id} has no DKIM key`);
    return this.encryption.openJson<string>(identity.dkimPrivateKey, sealedFor(identity.id));
  }

  /**
   * A new identity: a domain, within the plan, counted under a lock on the
   * account, with its DKIM key and its first look at its records; an address,
   * its link e-mailed to it.
   */
  async create(caller: IdentityCaller, name: string): Promise<EmailIdentity> {
    const parsed = identityOf(name);
    if ('problem' in parsed) throw new IdentityRefusal('invalid', `${name.trim() || 'An empty name'} can't be an identity: ${parsed.problem}`);
    const { accountId } = caller;
    const domain = parsed.type === EmailIdentityType.DOMAIN;
    const plan = await this.plans.forAccount(accountId);
    const key = domain ? await newDkimKey() : null;
    const token = domain ? null : randomBytes(24).toString('base64url');
    let row: EmailIdentity;
    try {
      row = await this.identities.manager.transaction(async (manager) => {
        await manager.findOne(Account, { where: { id: accountId }, select: { id: true }, lock: { mode: 'pessimistic_write' } });
        if (await manager.existsBy(EmailIdentity, { accountId, identity: parsed.identity })) throw new IdentityRefusal('exists', `The account has the identity ${parsed.identity} already`);
        if (domain) {
          const count = await manager.countBy(EmailIdentity, { accountId, type: EmailIdentityType.DOMAIN });
          if (count >= plan.limits.emailIdentities) {
            const allowed = plan.limits.emailIdentities;
            throw new IdentityRefusal('limit', `The ${plan.name} plan allows ${allowed} domain${allowed === 1 ? '' : 's'} to send mail from, and the account has ${count}: delete one first`);
          }
        }
        const made = await manager.save(
          EmailIdentity,
          manager.create(EmailIdentity, {
            accountId,
            identity: parsed.identity,
            type: parsed.type,
            status: EmailIdentityStatus.PENDING,
            dkimSelector: key?.selector ?? null,
            dkimPublicKey: key?.publicKey ?? null,
            verificationTokenSha256: token ? sha256(token) : null,
          }),
        );
        if (key) await manager.update(EmailIdentity, { id: made.id }, { dkimPrivateKey: this.encryption.sealJson(key.privateKeyPem, sealedFor(made.id)) });
        return made;
      });
    } catch (error) {
      if (error instanceof QueryFailedError && (error.driverError as { code?: string })?.code === UNIQUE_VIOLATION) {
        throw new IdentityRefusal('exists', `The account has the identity ${parsed.identity} already`);
      }
      throw error;
    }
    await this.record(caller, 'email.identity.create', row, { type: row.type, ...(row.dkimSelector ? { selector: row.dkimSelector } : {}) });
    if (token) await this.sendLink(row, token);
    else row = await this.check(row);
    return row;
  }

  /** The identity gone, with its key: nothing it sent can be signed again. False when the account had none of that name. */
  async remove(caller: IdentityCaller, name: string): Promise<boolean> {
    const row = await this.find(caller.accountId, name);
    if (!row) return false;
    await this.identities.delete({ id: row.id });
    await this.record(caller, 'email.identity.delete', row, { type: row.type });
    return true;
  }

  /** A domain's records looked up now; for an address, a new link sent, its last one no longer good. */
  async checkNow(caller: IdentityCaller, identity: EmailIdentity): Promise<EmailIdentity> {
    if (identity.type === EmailIdentityType.DOMAIN) return this.check(identity, new Date(), caller);
    if (identity.status === EmailIdentityStatus.SUCCESS) return identity;
    const token = randomBytes(24).toString('base64url');
    await this.identities.update({ id: identity.id }, { verificationTokenSha256: sha256(token) });
    await this.sendLink(identity, token);
    return identity;
  }

  /** The address whose link this is, proved now; null for a token that is no link's. */
  async verifyAddress(token: string): Promise<EmailIdentity | null> {
    if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
    const row = await this.identities.findOneBy({ verificationTokenSha256: sha256(token), type: EmailIdentityType.EMAIL_ADDRESS });
    if (!row) return null;
    const verifiedAt = new Date();
    await this.identities.update({ id: row.id }, { status: EmailIdentityStatus.SUCCESS, verifiedAt, verificationTokenSha256: null });
    await this.record({ accountId: row.accountId }, 'email.identity.verify', row, { by: 'link' });
    return { ...row, status: EmailIdentityStatus.SUCCESS, verifiedAt, verificationTokenSha256: null };
  }

  /**
   * Each domain due a look at its records: one not proved, every minute for
   * 72 hours, then FAILED; one proved, once a day. Answers how many were looked
   * at.
   */
  async checkDue(now = new Date()): Promise<number> {
    const due = await this.identities
      .createQueryBuilder('i')
      .where('i.type = :domain', { domain: EmailIdentityType.DOMAIN })
      .andWhere(
        `((i.status IN (:...pending) AND i.createdAt > :since) OR (i.status IN (:...proved) AND (i.checkedAt IS NULL OR i.checkedAt < :recheck)))`,
        {
          pending: [EmailIdentityStatus.PENDING],
          since: new Date(now.getTime() - PROOF_HOURS * 60 * MINUTE_MS),
          proved: [EmailIdentityStatus.SUCCESS, EmailIdentityStatus.TEMPORARY_FAILURE],
          recheck: new Date(now.getTime() - RECHECK_MS),
        },
      )
      .orderBy('i.checkedAt', 'ASC', 'NULLS FIRST')
      .limit(100)
      .getMany();
    for (const row of due) await this.check(row, now);
    await this.identities.update(
      { type: EmailIdentityType.DOMAIN, status: EmailIdentityStatus.PENDING, createdAt: LessThan(new Date(now.getTime() - PROOF_HOURS * 60 * MINUTE_MS)) },
      { status: EmailIdentityStatus.FAILED },
    );
    return due.length;
  }

  /**
   * A domain's records looked up: its DKIM record found proves it, or proves
   * it again; gone, a proved one is TEMPORARY_FAILURE until it is back. Its
   * return path's MX record says where its bounces go. A DNS that doesn't
   * answer changes nothing.
   */
  private async check(row: EmailIdentity, now = new Date(), caller?: IdentityCaller): Promise<EmailIdentity> {
    if (row.type !== EmailIdentityType.DOMAIN || !row.dkimSelector || !row.dkimPublicKey) return row;
    let found: { dkim: boolean; mailFrom: boolean };
    try {
      found = await checkMailDomain(this.resolver, row.identity, row.dkimSelector, row.dkimPublicKey, this.settings.mailHost);
    } catch (error) {
      if (error instanceof DnsUnavailableError) {
        this.logger.warn(`Domain ${row.identity} of account ${row.accountId} wasn't checked: ${error.message}`);
        return row;
      }
      throw error;
    }
    const proved = row.status === EmailIdentityStatus.SUCCESS;
    const status = found.dkim
      ? EmailIdentityStatus.SUCCESS
      : proved || row.status === EmailIdentityStatus.TEMPORARY_FAILURE
        ? EmailIdentityStatus.TEMPORARY_FAILURE
        : row.status === EmailIdentityStatus.FAILED
          ? EmailIdentityStatus.FAILED
          : EmailIdentityStatus.PENDING;
    const verifiedAt = found.dkim && !proved ? now : row.verifiedAt;
    await this.identities.update({ id: row.id }, { status, verifiedAt, mailFromVerified: found.mailFrom, checkedAt: now });
    if (found.dkim && !proved) await this.record(caller ?? { accountId: row.accountId }, 'email.identity.verify', row, { by: 'DKIM', mailFrom: found.mailFrom });
    return { ...row, status, verifiedAt, mailFromVerified: found.mailFrom, checkedAt: now };
  }

  /** The link that proves an address, e-mailed to it through FF's own mail, in French and in English. */
  private async sendLink(row: EmailIdentity, token: string): Promise<void> {
    const link = `${this.sesBase}/verify?token=${token}`;
    await this.mail.send({
      to: row.identity,
      subject: `FF : confirmez l'adresse ${row.identity} / Confirm the address ${row.identity}`,
      text: [
        `Le compte FF ${row.accountId} veut envoyer des e-mails depuis ${row.identity}, ou vers elle. Si c'est bien vous, confirmez-le en ouvrant ce lien :`,
        link,
        "Sinon, ne faites rien : l'adresse ne sera pas confirmée.",
        '',
        `The FF account ${row.accountId} wants to send e-mail from ${row.identity}, or to it. If that is you, confirm it by opening this link:`,
        link,
        'If not, do nothing: the address will not be confirmed.',
      ].join('\n'),
    });
  }

  private record(caller: IdentityCaller, action: 'email.identity.create' | 'email.identity.verify' | 'email.identity.delete', row: EmailIdentity, details: Record<string, unknown>) {
    return this.audit.record({
      accountId: row.accountId,
      action,
      resource: `email-identity:${row.identity}`,
      details,
      ...(caller.actor ? { actor: caller.actor } : {}),
      ...(caller.ip ? { ip: caller.ip } : {}),
    });
  }
}

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import type { EmailSettings } from '../config/configuration';
import { PlansService } from '../plans/plans.service';
import { EmailAccountService } from './email-account.service';
import { EmailIdentitiesService } from './email-identities.service';
import { EmailIdentity, EmailIdentityStatus, EmailIdentityType } from './email-identity.entity';
import { EmailMessage, EmailMessageStatus, MessageRecipient } from './email-message.entity';
import { domainOf } from './email-names';
import { MAX_MESSAGE_BYTES, MAX_RECIPIENTS, addressesOf, composeSimple, headerProblem, rawParties, returnPathOf, senderOf, withoutBcc } from './email-send';
import { EmailSender } from './email-sender.service';
import { EmailSuppressionsService } from './email-suppressions.service';
import { mailFromDomain } from './mail-domain';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Why a message wasn't taken: each kind one of SES's errors at the SES endpoint, and an HTTP status in FF's API. */
export type SendRefusalKind = 'invalid' | 'rejected' | 'paused' | 'suspended' | 'daily' | 'rate' | 'unavailable';

export class SendRefusal extends Error {
  constructor(
    readonly kind: SendRefusalKind,
    message: string,
  ) {
    super(message);
  }
}

/** A message to send, as SES v2's SendEmail takes it, its names FF's. */
export interface SendRequest {
  /** The sender as written, "Ana <orders@shop.tn>"; none for a raw message whose header has it. */
  from?: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  content: { simple: { subject: string; text?: string; html?: string; headers: Array<{ name: string; value: string }> } } | { raw: Buffer };
}

/**
 * The messages an account sends (ADR 0012), each taken as SES takes it or
 * refused in its words: from an address or a domain the account proved; in
 * the sandbox, to the account's proved addresses and domains alone; within the
 * plan's quotas, each recipient one, a day and a second, counted under a lock
 * on the account; the account's suppression list's addresses kept off. Taken,
 * a message is queued, answered at once with its ID, and handed to the server
 * of customers' mail by EmailSender.
 */
@Injectable()
export class EmailMessagesService {
  private readonly settings: EmailSettings;
  /** The SES endpoint's region and host: SES's words name the first, messages' IDs the second. */
  private readonly region: string;
  private readonly messageHost: string;

  constructor(
    @InjectRepository(EmailMessage) private readonly messages: Repository<EmailMessage>,
    private readonly identities: EmailIdentitiesService,
    private readonly suppressions: EmailSuppressionsService,
    private readonly account: EmailAccountService,
    private readonly plans: PlansService,
    private readonly sender: EmailSender,
    config: ConfigService,
  ) {
    this.settings = config.getOrThrow<EmailSettings>('email');
    this.region = config.getOrThrow<string>('ses.region').toUpperCase();
    this.messageHost = new URL(config.getOrThrow<string>('ses.base')).hostname;
  }

  /** The message taken: its ID, SES's MessageId. */
  async send(accountId: string, request: SendRequest): Promise<string> {
    if (!this.settings.server) throw new SendRefusal('unavailable', "Sending is paused: FF has no server of customers' mail here, so nothing is sent.");
    const simple = 'simple' in request.content ? request.content.simple : null;
    const raw = 'raw' in request.content ? request.content.raw : null;
    const parties = raw ? rawParties(raw) : null;
    const fromText = request.from ?? parties?.from ?? null;
    if (!fromText) throw new SendRefusal('invalid', 'FromEmailAddress is required, unless the raw message has a From header');
    const from = senderOf(fromText);
    if (!from) throw new SendRefusal('invalid', `${fromText} is not one address`);
    const named = request.to.length + request.cc.length + request.bcc.length > 0;
    const given = named ? [...request.to, ...request.cc, ...request.bcc] : [...(parties?.to ?? []), ...(parties?.cc ?? []), ...(parties?.bcc ?? [])];
    const listed = given.flatMap((text) => (named ? addressesOf(text) : [text]));
    if (listed.includes(null)) throw new SendRefusal('invalid', `Illegal address: ${given.find((text) => addressesOf(text).includes(null))}`);
    const recipients = [...new Set(listed as string[])];
    if (recipients.length === 0) throw new SendRefusal('invalid', "A message needs a recipient: Destination's ToAddresses, CcAddresses or BccAddresses");
    if (recipients.length > MAX_RECIPIENTS) throw new SendRefusal('invalid', `Recipient count exceeds ${MAX_RECIPIENTS}.`);
    if (request.replyTo.flatMap(addressesOf).includes(null)) throw new SendRefusal('invalid', 'Illegal address in ReplyToAddresses');
    const problem = simple?.headers.map(({ name, value }) => headerProblem(name, value)).find((one) => one !== null);
    if (problem) throw new SendRefusal('invalid', problem);

    const sending = await this.account.sendingOf(accountId);
    if (!sending.sendingEnabled) throw new SendRefusal('paused', "Sending is paused for this account: FF's operator stopped it, and says why.");
    if (sending.enforcementStatus === 'SHUTDOWN') throw new SendRefusal('suspended', "The account's sending is stopped: its bounces or complaints went past what SES allows, and FF's operator reviews it.");
    // The sender's identity, its address or its domain, proved; in the sandbox, each recipient's too.
    const names = [from, domainOf(from), ...(sending.productionAccess ? [] : recipients.flatMap((recipient) => [recipient, domainOf(recipient)]))];
    const known = await this.identities.findAll(accountId, names);
    const proved = (name: string): EmailIdentity | null => {
      const identity = known.get(name);
      return identity?.status === EmailIdentityStatus.SUCCESS ? identity : null;
    };
    const unverified = (failed: string[]) => `Email address is not verified. The following identities failed the check in region ${this.region}: ${failed.join(', ')}`;
    const identity = proved(from) ?? proved(domainOf(from));
    if (!identity) throw new SendRefusal('rejected', unverified([from]));
    if (!sending.productionAccess) {
      const outside = recipients.filter((recipient) => !proved(recipient) && !proved(domainOf(recipient)));
      if (outside.length > 0) throw new SendRefusal('rejected', unverified(outside));
    }

    const id = randomUUID();
    const message = simple ? await composeSimple({ from: fromText, to: request.to, cc: request.cc, replyTo: request.replyTo, ...simple }, id, this.messageHost) : withoutBcc(raw as Buffer);
    if (message.length > MAX_MESSAGE_BYTES) throw new SendRefusal('rejected', `Message length is more than ${MAX_MESSAGE_BYTES} bytes long: ${message.length}.`);
    // Its bounces come back to its domain's own return path once its MX is found; until then, to FF's own.
    const domain = identity.type === EmailIdentityType.DOMAIN ? identity : proved(domainOf(from));
    const returnPath = returnPathOf(id, domain?.mailFromVerified ? mailFromDomain(domain.identity) : this.settings.bounceDomain);
    const suppressed = await this.suppressions.suppressedOf(accountId, recipients);
    const rows: MessageRecipient[] = recipients.map((address) => ({ address, status: suppressed.has(address) ? 'SUPPRESSED' : 'QUEUED' }));
    const queued = rows.some((row) => row.status === 'QUEUED');
    const { limits } = await this.plans.forAccount(accountId);

    await this.messages.manager.transaction(async (manager) => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`email-quota:${accountId}`]);
      const now = Date.now();
      const day = await this.account.sentSince(accountId, new Date(now - DAY_MS), manager);
      if (day + recipients.length > limits.emailsPerDay) throw new SendRefusal('daily', 'Daily message quota exceeded.');
      const second = await this.account.sentSince(accountId, new Date(now - 1000), manager);
      if (second >= limits.emailsPerSecond) throw new SendRefusal('rate', 'Maximum sending rate exceeded.');
      await manager.insert(EmailMessage, {
        id,
        accountId,
        identity: identity.identity,
        fromAddress: from,
        returnPath,
        recipients: rows,
        recipientCount: recipients.length,
        sizeBytes: message.length,
        raw: queued ? message : null,
        status: queued ? EmailMessageStatus.QUEUED : EmailMessageStatus.SENT,
        sentAt: queued ? null : new Date(now),
      });
    });
    if (queued) this.sender.kick();
    return id;
  }

  /** The account's latest messages, the latest first. */
  latest(accountId: string, limit: number): Promise<EmailMessage[]> {
    return this.messages.find({ where: { accountId }, order: { createdAt: 'DESC', id: 'DESC' }, take: limit });
  }
}

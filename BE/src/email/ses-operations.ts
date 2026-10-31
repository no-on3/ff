import { Injectable } from '@nestjs/common';
import { Actor } from '../common/request-context';
import { decodeEscapes } from '../storage/sigv4';
import { EmailAccountService } from './email-account.service';
import { EmailIdentitiesService, IdentityRefusal } from './email-identities.service';
import { EmailIdentity, EmailIdentityStatus, EmailIdentityType } from './email-identity.entity';
import { EmailMessagesService, SendRefusal, SendRefusalKind, SendRequest } from './email-messages.service';
import { senderOf } from './email-send';
import { addressProblem, identityKey } from './email-names';
import { EmailSuppression, SuppressionReason } from './email-suppression.entity';
import { EmailSuppressionsService } from './email-suppressions.service';
import { mailFromDomain } from './mail-domain';
import { SesError, accessDenied, accountSuspended, alreadyExists, badRequest, limitExceeded, messageRejected, notFound, notImplemented, sendingPaused, tooManyRequests } from './ses-error';

/** Who calls, as the front door admitted them: an access key of the account's, a read-only one only reading. */
export interface SesCaller {
  accountId: string;
  keyId: string;
  readOnly: boolean;
  /** Changes are the key's in the audit log. */
  actor: Actor;
  ip?: string;
  /** What the caller's key used, by SES's name for the operation: the identity it names, a message's sender, or '' for the account's. */
  used?: (operation: string, resource: string) => void;
}

/** A request, as the front door read it: its method, its path's segments decoded, its query, and its JSON body. */
export interface SesRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  input: Record<string, unknown>;
}

/** SES v2's routes FF answers: each a method and a path, a name in the path's last segment for some. */
const ROUTES: Array<{ method: string; pattern: RegExp; operation: string; writes: boolean }> = [
  { method: 'POST', pattern: /^\/v2\/email\/identities$/, operation: 'CreateEmailIdentity', writes: true },
  // Today's SDKs list with a POST and a JSON body; older ones, as SES v2's first model had it, with a GET and a query.
  { method: 'POST', pattern: /^\/v2\/email\/list-identities$/, operation: 'ListEmailIdentities', writes: false },
  { method: 'GET', pattern: /^\/v2\/email\/identities$/, operation: 'ListEmailIdentities', writes: false },
  { method: 'GET', pattern: /^\/v2\/email\/identities\/([^/]+)$/, operation: 'GetEmailIdentity', writes: false },
  { method: 'DELETE', pattern: /^\/v2\/email\/identities\/([^/]+)$/, operation: 'DeleteEmailIdentity', writes: true },
  { method: 'POST', pattern: /^\/v2\/email\/outbound-emails$/, operation: 'SendEmail', writes: true },
  { method: 'GET', pattern: /^\/v2\/email\/account$/, operation: 'GetAccount', writes: false },
  { method: 'PUT', pattern: /^\/v2\/email\/suppression\/addresses$/, operation: 'PutSuppressedDestination', writes: true },
  { method: 'GET', pattern: /^\/v2\/email\/suppression\/addresses$/, operation: 'ListSuppressedDestinations', writes: false },
  { method: 'GET', pattern: /^\/v2\/email\/suppression\/addresses\/([^/]+)$/, operation: 'GetSuppressedDestination', writes: false },
  { method: 'DELETE', pattern: /^\/v2\/email\/suppression\/addresses\/([^/]+)$/, operation: 'DeleteSuppressedDestination', writes: true },
];

/** The operation a request is, its name in the path decoded; null for a route FF doesn't answer. */
export function routeOf(method: string, rawPath: string): { operation: string; writes: boolean; name?: string } | null {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(rawPath);
    if (match) return { operation: route.operation, writes: route.writes, ...(match[1] !== undefined ? { name: decodeEscapes(match[1]) } : {}) };
  }
  return null;
}

/** Seconds since the epoch, as AWS's REST JSON protocol writes a timestamp. */
const epochSeconds = (date: Date | null): number | undefined => (date ? Math.floor(date.getTime() / 1000) : undefined);
const SUPPRESSION_REASONS = Object.values(SuppressionReason) as string[];

/** A refusal of SendEmail's, as SES's error. */
const SEND_REFUSALS: Record<SendRefusalKind, (message: string) => SesError> = {
  invalid: badRequest,
  rejected: messageRejected,
  paused: sendingPaused,
  suspended: accountSuspended,
  credit: sendingPaused,
  daily: limitExceeded,
  rate: tooManyRequests,
  unavailable: sendingPaused,
};

/** A list of strings of the request's, or none; anything else refused, naming the field. */
function strings(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((one) => typeof one !== 'string')) throw badRequest(`${name} must be a list of strings`);
  return value as string[];
}

/** A field of the request's that is an object, or none. */
function objectOf(value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw badRequest(`${name} must be an object`);
  return value as Record<string, unknown>;
}

/** A Content's text, SES's { Data, Charset }; its Charset taken as UTF-8, the only one FF writes. */
function dataOf(value: unknown, name: string): string | undefined {
  const content = objectOf(value, name);
  if (content === undefined) return undefined;
  if (typeof content.Data !== 'string') throw badRequest(`${name}.Data is required: a string`);
  return content.Data;
}

/** SendEmail's content, as FF sends it: Simple, or Raw; a template comes later. */
function contentOf(input: Record<string, unknown>): SendRequest['content'] {
  const content = objectOf(input.Content, 'Content');
  if (!content) throw badRequest('Content is required: Simple or Raw');
  if (content.Template !== undefined) throw notImplemented("FF's SES endpoint doesn't send templates: send Simple or Raw content");
  const simple = objectOf(content.Simple, 'Content.Simple');
  if (simple) {
    const subject = dataOf(simple.Subject, 'Content.Simple.Subject');
    if (subject === undefined) throw badRequest('Content.Simple.Subject is required');
    const body = objectOf(simple.Body, 'Content.Simple.Body') ?? {};
    const text = dataOf(body.Text, 'Content.Simple.Body.Text');
    const html = dataOf(body.Html, 'Content.Simple.Body.Html');
    if (text === undefined && html === undefined) throw badRequest('Content.Simple.Body needs Text, Html or both');
    const headers = (Array.isArray(simple.Headers) ? simple.Headers : simple.Headers === undefined ? [] : null)?.map((header: unknown) => {
      const { Name, Value } = (objectOf(header, 'Content.Simple.Headers[]') ?? {}) as { Name?: unknown; Value?: unknown };
      if (typeof Name !== 'string' || typeof Value !== 'string') throw badRequest('Content.Simple.Headers are each a Name and a Value');
      return { name: Name, value: Value };
    });
    if (!headers) throw badRequest('Content.Simple.Headers must be a list');
    return { simple: { subject, ...(text !== undefined ? { text } : {}), ...(html !== undefined ? { html } : {}), headers } };
  }
  const raw = objectOf(content.Raw, 'Content.Raw');
  if (raw) {
    if (typeof raw.Data !== 'string' || !/^[A-Za-z0-9+/=\s]*$/.test(raw.Data)) throw badRequest('Content.Raw.Data is required: the whole message, in base64');
    return { raw: Buffer.from(raw.Data, 'base64') };
  }
  throw badRequest('Content is Simple or Raw');
}

/** A page's size, as SES takes one: 1 to 1,000. */
function pageSize(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const size = Number(value);
  if (!Number.isInteger(size) || size < 1 || size > 1000) throw badRequest('PageSize must be a whole number from 1 to 1000');
  return size;
}

/** A token for the next page of identities: its first one's place, opaque. */
const identityToken = (offset: number): string => Buffer.from(`ff:${offset}`).toString('base64url');
function identityOffset(token: unknown): number {
  if (token === undefined || token === null || token === '') return 0;
  const match = typeof token === 'string' ? /^ff:(\d{1,9})$/.exec(Buffer.from(token, 'base64url').toString('utf8')) : null;
  if (!match) throw badRequest('The NextToken is no page of this list');
  return Number(match[1]);
}

/**
 * What a request uses of the account's mail, as IAM names SES's resources: the
 * identity it makes, reads or deletes, a message's sender; '' for the
 * account's own, its list of identities, its sending and its suppression list.
 */
function usedIdentity(operation: string, name: string, input: Record<string, unknown>): string {
  if (operation === 'SendEmail') return typeof input.FromEmailAddress === 'string' ? (senderOf(input.FromEmailAddress) ?? '') : '';
  if (operation === 'CreateEmailIdentity') return typeof input.EmailIdentity === 'string' ? identityKey(input.EmailIdentity) : '';
  if (operation === 'GetEmailIdentity' || operation === 'DeleteEmailIdentity') return identityKey(name);
  return '';
}

/** A timestamp of the query, as AWS's clients write one: ISO 8601, or seconds since the epoch. */
function queryTime(name: string, value: string | null): Date | undefined {
  if (value === null || value === '') return undefined;
  const at = /^\d+(\.\d+)?$/.test(value) ? new Date(Number(value) * 1000) : new Date(value);
  if (Number.isNaN(at.getTime())) throw badRequest(`${name} must be a time, such as 2026-10-30T00:00:00Z`);
  return at;
}

/**
 * SES v2's operations (ADR 0012), on an account's identities, its sending and
 * its suppression list, in SES's names and shapes, as AWS's SDKs and CLI read
 * them; each refusal SES's error.
 */
@Injectable()
export class SesOperations {
  constructor(
    private readonly identities: EmailIdentitiesService,
    private readonly suppressions: EmailSuppressionsService,
    private readonly account: EmailAccountService,
    private readonly messages: EmailMessagesService,
  ) {}

  async run(request: SesRequest, caller: SesCaller): Promise<unknown> {
    const route = routeOf(request.method, request.path);
    if (!route) {
      throw notImplemented(`FF's SES endpoint doesn't answer ${request.method} ${request.path}: it answers SES v2's identities, SendEmail, GetAccount and suppression list`);
    }
    if (route.writes && caller.readOnly) throw accessDenied(`The access key ${caller.keyId} only reads: ${route.operation} changes the account's mail.`);
    const name = route.name ?? '';
    caller.used?.(route.operation, usedIdentity(route.operation, name, request.input));
    switch (route.operation) {
      case 'CreateEmailIdentity':
        return this.createIdentity(request.input, caller);
      case 'ListEmailIdentities':
        return this.listIdentities(caller.accountId, request.method === 'POST' ? request.input.PageSize : request.query.get('PageSize'), request.method === 'POST' ? request.input.NextToken : request.query.get('NextToken'));
      case 'GetEmailIdentity':
        return this.identityView(await this.identityOf(caller.accountId, name));
      case 'DeleteEmailIdentity':
        if (!(await this.identities.remove(caller, name))) throw notFound(`Email identity ${name} does not exist.`);
        return {};
      case 'SendEmail':
        return this.sendEmail(request.input, caller);
      case 'GetAccount':
        return this.accountView(caller.accountId);
      case 'PutSuppressedDestination':
        return this.putSuppression(request.input, caller);
      case 'ListSuppressedDestinations':
        return this.listSuppressions(caller.accountId, request.query);
      case 'GetSuppressedDestination':
        return { SuppressedDestination: this.suppressionView(await this.suppressionOf(caller.accountId, name), true) };
      case 'DeleteSuppressedDestination':
        if (!(await this.suppressions.remove(caller, name))) throw notFound(`Email address ${identityKey(name)} does not exist on your suppression list.`);
        return {};
      default:
        throw notImplemented(`FF's SES endpoint doesn't answer ${route.operation}`);
    }
  }

  private async createIdentity(input: Record<string, unknown>, caller: SesCaller): Promise<unknown> {
    const name = input.EmailIdentity;
    if (typeof name !== 'string' || name.trim() === '') throw badRequest('EmailIdentity is required: a domain or an address');
    if (input.DkimSigningAttributes !== undefined) throw badRequest("FF makes a domain's DKIM key itself: leave DkimSigningAttributes out, and publish the record FF gives");
    let made: EmailIdentity;
    try {
      made = await this.identities.create(caller, name);
    } catch (error) {
      if (!(error instanceof IdentityRefusal)) throw error;
      if (error.kind === 'exists') throw alreadyExists(`Email identity ${identityKey(name)} already exist.`);
      throw error.kind === 'limit' ? limitExceeded(error.message) : badRequest(error.message);
    }
    const { IdentityType, VerifiedForSendingStatus, DkimAttributes } = this.identityView(made);
    return { IdentityType, VerifiedForSendingStatus, ...(DkimAttributes ? { DkimAttributes } : {}) };
  }

  private async sendEmail(input: Record<string, unknown>, caller: SesCaller): Promise<unknown> {
    if (input.ConfigurationSetName !== undefined) throw notFound(`Configuration set ${JSON.stringify(input.ConfigurationSetName)} does not exist.`);
    if (input.FromEmailAddress !== undefined && typeof input.FromEmailAddress !== 'string') throw badRequest('FromEmailAddress must be a string');
    const destination = objectOf(input.Destination, 'Destination') ?? {};
    try {
      const MessageId = await this.messages.send(caller.accountId, {
        ...(typeof input.FromEmailAddress === 'string' ? { from: input.FromEmailAddress } : {}),
        to: strings(destination.ToAddresses, 'Destination.ToAddresses'),
        cc: strings(destination.CcAddresses, 'Destination.CcAddresses'),
        bcc: strings(destination.BccAddresses, 'Destination.BccAddresses'),
        replyTo: strings(input.ReplyToAddresses, 'ReplyToAddresses'),
        content: contentOf(input),
      });
      return { MessageId };
    } catch (error) {
      if (error instanceof SendRefusal) throw SEND_REFUSALS[error.kind](error.message);
      throw error;
    }
  }

  private async listIdentities(accountId: string, size: unknown, token: unknown): Promise<unknown> {
    const limit = pageSize(size) ?? 1000;
    const offset = identityOffset(token);
    const all = await this.identities.list(accountId);
    const page = all.slice(offset, offset + limit);
    return {
      EmailIdentities: page.map((identity) => ({
        IdentityType: identity.type,
        IdentityName: identity.identity,
        SendingEnabled: identity.status === EmailIdentityStatus.SUCCESS,
        VerificationStatus: identity.status,
      })),
      ...(offset + limit < all.length ? { NextToken: identityToken(offset + limit) } : {}),
    };
  }

  private async identityOf(accountId: string, name: string): Promise<EmailIdentity> {
    const found = await this.identities.find(accountId, name);
    if (!found) throw notFound(`Email identity ${identityKey(name)} does not exist.`);
    return found;
  }

  /** An identity as GetEmailIdentity answers it: a domain's DKIM key FF's, its own, as SES's "bring your own DKIM" names it. */
  private identityView(identity: EmailIdentity) {
    const domain = identity.type === EmailIdentityType.DOMAIN;
    return {
      IdentityType: identity.type,
      FeedbackForwardingStatus: true,
      VerifiedForSendingStatus: identity.status === EmailIdentityStatus.SUCCESS,
      VerificationStatus: identity.status,
      ...(domain
        ? {
            DkimAttributes: {
              SigningEnabled: true,
              Status: identity.status,
              Tokens: identity.dkimSelector ? [identity.dkimSelector] : [],
              SigningAttributesOrigin: 'EXTERNAL',
              CurrentSigningKeyLength: 'RSA_2048_BIT',
              LastKeyGenerationTimestamp: epochSeconds(identity.createdAt),
            },
            MailFromAttributes: {
              MailFromDomain: mailFromDomain(identity.identity),
              MailFromDomainStatus: identity.mailFromVerified ? 'SUCCESS' : 'PENDING',
              BehaviorOnMxFailure: 'USE_DEFAULT_VALUE',
            },
          }
        : {}),
      Policies: {},
      Tags: [],
    };
  }

  private async accountView(accountId: string): Promise<unknown> {
    const state = await this.account.state(accountId);
    return {
      DedicatedIpAutoWarmupEnabled: false,
      EnforcementStatus: state.enforcementStatus,
      ProductionAccessEnabled: !state.sandbox,
      SendQuota: { Max24HourSend: state.max24HourSend, MaxSendRate: state.maxSendRate, SentLast24Hours: state.sentLast24Hours },
      SendingEnabled: state.sendingEnabled,
      SuppressionAttributes: { SuppressedReasons: SUPPRESSION_REASONS },
    };
  }

  private async putSuppression(input: Record<string, unknown>, caller: SesCaller): Promise<unknown> {
    const address = input.EmailAddress;
    if (typeof address !== 'string' || addressProblem(identityKey(address)) !== null) throw badRequest('EmailAddress must be an e-mail address, such as orders@example.tn');
    if (typeof input.Reason !== 'string' || !SUPPRESSION_REASONS.includes(input.Reason)) throw badRequest('Reason must be BOUNCE or COMPLAINT');
    await this.suppressions.put(caller, caller.accountId, address, input.Reason as SuppressionReason);
    return {};
  }

  private async listSuppressions(accountId: string, query: URLSearchParams): Promise<unknown> {
    const reasons = query.getAll('Reason').flatMap((reason) => reason.split(','));
    const unknown = reasons.find((reason) => !SUPPRESSION_REASONS.includes(reason));
    if (unknown !== undefined) throw badRequest(`Reason must be BOUNCE or COMPLAINT, not ${unknown}`);
    const page = await this.suppressions.list(accountId, {
      reasons: reasons as SuppressionReason[],
      start: queryTime('StartDate', query.get('StartDate')),
      end: queryTime('EndDate', query.get('EndDate')),
      pageSize: pageSize(query.get('PageSize')),
      next: query.get('NextToken') ?? undefined,
    });
    if (!page) throw badRequest('The NextToken is no page of this list');
    return { SuppressedDestinationSummaries: page.suppressions.map((row) => this.suppressionView(row, false)), ...(page.next ? { NextToken: page.next } : {}) };
  }

  private async suppressionOf(accountId: string, address: string): Promise<EmailSuppression> {
    const found = await this.suppressions.find(accountId, address);
    if (!found) throw notFound(`Email address ${identityKey(address)} does not exist on your suppression list.`);
    return found;
  }

  /** As SES's SuppressedDestination, with what put it there; or its summary in a list. */
  private suppressionView(row: EmailSuppression, whole: boolean) {
    return {
      EmailAddress: row.address,
      Reason: row.reason,
      LastUpdateTime: epochSeconds(row.updatedAt),
      ...(whole && row.messageId ? { Attributes: { MessageId: row.messageId, FeedbackId: row.messageId } } : {}),
    };
  }
}

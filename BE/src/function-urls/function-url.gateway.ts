import { HttpStatus, Injectable, Logger, NotFoundException, OnModuleDestroy, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectThrottlerStorage, ThrottlerStorage } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import { AddressInfo, isIPv4 } from 'node:net';
import proxyAddr from 'proxy-addr';
import { Repository } from 'typeorm';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { Principal } from '../auth/principal';
import { WRITERS } from '../auth/route-rules';
import { InsufficientCreditException } from '../billing/credit-policy';
import { CreditService } from '../billing/credit.service';
import { describeError } from '../common/describe-error';
import { closeHttp, listenHttp } from '../common/http-server';
import { withRequestContext } from '../common/request-context';
import { InvocationSource } from '../functions/entities/function-invocation.entity';
import { FunctionUrl, UrlAuthType, UrlCors } from '../functions/entities/function-url.entity';
import { EventFormat, Function, FunctionStatus } from '../functions/entities/function.entity';
import { FunctionsService } from '../functions/functions.service';
import { RefusedInvocationsService } from '../metrics/refused-invocations.service';
import { S3FrontDoor } from '../storage/front-door';
import { WebsiteServer } from '../storage/website-server';
import { refusals, statusClass, urlResponses } from '../monitoring/operator-metrics';
import { FunctionThrottledError } from '../orchestrator/orchestrator.errors';
import { PlansService } from '../plans/plans.service';
import { countInvocation } from '../plans/rate-limits';
import { CustomDomainsService } from './custom-domains.service';
import { FunctionUrlsService } from './function-urls.service';
import { functionDomain, hostName, urlIdOf } from './url-address';
import { isCorsHeader, isPreflight, preflightHeaders, responseCorsHeaders } from './url-cors';
import { eventForHistory, urlEvent } from './url-event';
import { InvalidUrlResponseError, UrlAnswer, urlAnswer } from './url-response';

/** AWS Lambda's limit on an invocation's event, and on its answer: 6 MB. */
export const URL_PAYLOAD_LIMIT = 6 * 1024 * 1024;

/** Where the edge asks whether a host may have a certificate: ?domain=<host>. */
export const TLS_ALLOWED_PATH = '/tls/allowed';

/** The header that names each answer's request, as AWS's function URLs name it: the invocation's ID. */
export const URL_REQUEST_ID_HEADER = 'x-amzn-RequestId';

/** An answer the gateway gives itself rather than the function's, as AWS's function URLs do: a status, and a JSON body with a Message. */
class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Array<[string, string]> = [],
  ) {
    super(message);
  }
}

/** What a request's host names: a function's URL, or a bucket's site, by a customer's own domain. */
type HostTarget = { url: FunctionUrl } | { site: string };

const EMPTY = Buffer.alloc(0);

function jsonAnswer(status: number, message: string, headers: Array<[string, string]> = []): UrlAnswer {
  return { status, headers: [['content-type', 'application/json'], ...headers], body: Buffer.from(JSON.stringify({ Message: message })) };
}

/** A header's value, the first when it came more than once. */
const single = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/** The CORS configuration's headers on an answer, in place of any the function sent. */
function withCors(answer: UrlAnswer, cors: UrlCors, origin: string | undefined): UrlAnswer {
  return { ...answer, headers: [...answer.headers.filter(([name]) => !isCorsHeader(name)), ...responseCorsHeaders(cors, origin)] };
}

/** An IPv4 caller as AWS names it, without the IPv6 prefix a dual-stack socket gives it. */
function plainAddress(address: string): string {
  const mapped = /^::ffff:(.+)$/i.exec(address);
  return mapped && isIPv4(mapped[1]) ? mapped[1] : address;
}

/** The request's path alone. */
const pathOf = (target: string | undefined): string => originForm(target).split('?')[0];

/** The request's path and query: an absolute target, as a proxy may send one, without its scheme and host; "*" is the root. */
function originForm(target: string | undefined): string {
  if (target?.startsWith('/')) return target;
  try {
    const url = new URL(target ?? '');
    return `${url.pathname}${url.search}`;
  } catch {
    return '/';
  }
}

/**
 * The request's body, whole; a refusal, 413, past the limit, which then closes
 * the connection rather than read the rest.
 */
function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const tooLarge = () => new Refusal(HttpStatus.PAYLOAD_TOO_LARGE, 'Request Entity Too Large', [['connection', 'close']]);
  if (Number(request.headers['content-length']) > limit) return Promise.reject(tooLarge());
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) {
        chunks.push(chunk);
        return;
      }
      request.off('data', onData);
      request.resume();
      reject(tooLarge());
    };
    request.on('data', onData);
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
    request.on('close', () => {
      if (!request.complete) reject(new Error('The caller closed the connection before sending its whole request'));
    });
  });
}

/**
 * The function URL gateway: a server of its own, on FF_FUNCTION_URL_PORT, that
 * answers nothing but function URLs, by host: <url-id>.<the function domain>.
 * None of the API's middleware applies here. Each request calls its function
 * as the API's invoke does (the account's state, the plan's rate, its credit,
 * the record of the call, its bill) with AWS Lambda's event for function URLs,
 * and the function's answer is the response, by Lambda's rules. The gateway
 * answers itself, with a JSON Message, when it doesn't call: 404 for a host
 * that is no URL, 403 for a caller without the account's credentials, 429 over
 * the plan's rate, 402 without credit, 503 for a function that can't take
 * calls, 413 for a request over 6 MB; and 502 for a call that failed or an
 * answer that can't be sent.
 */
@Injectable()
export class FunctionUrlGateway implements OnModuleDestroy {
  private readonly logger = new Logger(FunctionUrlGateway.name);
  private readonly domain: string;
  private readonly trusted: (address: string, hop: number) => boolean;
  private server?: Server;

  constructor(
    config: ConfigService,
    private readonly urls: FunctionUrlsService,
    private readonly domains: CustomDomainsService,
    private readonly functions: FunctionsService,
    private readonly apiKeys: ApiKeysService,
    private readonly credit: CreditService,
    private readonly plans: PlansService,
    private readonly refused: RefusedInvocationsService,
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
    @InjectThrottlerStorage() private readonly throttler: ThrottlerStorage,
    private readonly frontDoor: S3FrontDoor,
    private readonly websites: WebsiteServer,
  ) {
    this.domain = functionDomain(config.getOrThrow<string>('functionUrls.base'));
    // Behind the edge, the caller is in X-Forwarded-For, which only the proxies the API trusts may set.
    this.trusted = proxyAddr.compile(config.getOrThrow<string[]>('http.trustProxy'));
  }

  /** Starts answering on the port; main.ts calls it once the API listens. Port 0 takes any free one, as the tests do. */
  async listen(port: number, host?: string): Promise<AddressInfo> {
    const server = createServer((request, response) => void this.serve(request, response));
    const address = await listenHttp(server, port, host);
    this.server = server;
    return address;
  }

  /** Stops taking requests, and waits for the calls under way. */
  async onModuleDestroy(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) await closeHttp(server);
  }

  /** Answers one request; never throws, as nothing would catch it. */
  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // The request's ID is the invocation's, chosen first: the event names it, and so does every answer, a refusal too.
    const requestId = randomUUID();
    const time = new Date();
    let answer: UrlAnswer | null;
    try {
      const sourceIp = plainAddress(proxyAddr(request, this.trusted) ?? '');
      answer = await withRequestContext({ requestId, ip: sourceIp }, () => this.answer(request, response, { requestId, sourceIp, time }));
    } catch (error) {
      // Not a refusal: the gateway itself failed. The details go to the log, under the request's ID.
      this.logger.error(`A function URL's request failed (request ${requestId}): ${describeError(error)}`, error instanceof Error ? error.stack : undefined);
      answer = jsonAnswer(HttpStatus.INTERNAL_SERVER_ERROR, 'Internal Server Error');
    }
    // A site's answer, which the website server sent itself.
    if (answer === null) return;
    try {
      this.send(request, response, answer, requestId);
    } catch (error) {
      this.logger.error(`Could not answer a function URL's request (request ${requestId}): ${describeError(error)}`);
      response.destroy();
    }
  }

  /** The answer to send; null once the website server has answered a site's request itself. */
  private async answer(request: IncomingMessage, response: ServerResponse, context: { requestId: string; sourceIp: string; time: Date }): Promise<UrlAnswer | null> {
    const target = await this.targetOf(request.headers.host);
    // A customer's own domain for a bucket's site: the website server answers it, as it answers the site's own host.
    if (target && 'site' in target) {
      await this.websites.serve(request, response, target.site);
      return null;
    }
    const url = target?.url ?? null;
    // A host that is neither a URL nor a customer's domain is the edge itself, asking before a certificate.
    if (!url && pathOf(request.url) === TLS_ALLOWED_PATH) return this.tlsAllowed(request.url as string);
    if (!url) return jsonAnswer(HttpStatus.NOT_FOUND, 'Not Found');
    const origin = single(request.headers.origin);
    // With CORS set, the URL answers browsers' preflights itself, before any credentials: browsers send none with them.
    if (url.cors && isPreflight(request.method ?? '', request.headers)) {
      return { status: HttpStatus.NO_CONTENT, headers: preflightHeaders(url.cors, origin), body: EMPTY };
    }
    let answer: UrlAnswer;
    try {
      answer = await this.call(url, request, context);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      answer = jsonAnswer(error.status, error.message, error.headers);
    }
    // A browser reads a refusal too only with the CORS headers.
    return url.cors ? withCors(answer, url.cors, origin) : answer;
  }

  /**
   * What a host names: a URL by its ID under the function domain, or a
   * customer's verified domain, for a URL or for a bucket's site, while the
   * bucket is one; null for any other host.
   */
  private async targetOf(host: string | undefined): Promise<HostTarget | null> {
    const urlId = urlIdOf(host, this.domain);
    const name = hostName(host);
    const domain = urlId || !name ? null : await this.domains.forHost(name);
    if (domain?.bucketId) return domain.bucket?.website ? { site: domain.bucket.name } : null;
    const url = urlId ? await this.urls.forUrlId(urlId) : domain?.functionId ? await this.urls.forFunction(domain.functionId) : null;
    return url ? { url } : null;
  }

  /**
   * The edge's question before it gets a certificate on demand, for a host it
   * hasn't one for (Caddy's on_demand_tls ask, one address for all its hosts):
   * 200 for a function URL's host, a customer's verified domain for a URL or a
   * site, buckets' S3 endpoint and a bucket's host under it, or a site's host;
   * 404 for any other, so that nobody makes it ask a certificate authority for
   * names of their choosing. Only the edge reaches this port in a cluster.
   */
  private async tlsAllowed(target: string): Promise<UrlAnswer> {
    const domain = new URL(target, 'http://edge').searchParams.get('domain') ?? undefined;
    const known =
      (await this.targetOf(domain)) !== null ||
      (domain !== undefined && ((await this.frontDoor.allowsCertificate(domain)) || (await this.websites.allowsCertificate(domain))));
    return known ? { status: HttpStatus.OK, headers: [['content-type', 'text/plain']], body: Buffer.from('allowed') } : jsonAnswer(HttpStatus.NOT_FOUND, 'Not Found');
  }

  /** One call of the URL's function, as the API's invoke makes it; a Refusal when it can't be made. */
  private async call(url: FunctionUrl, request: IncomingMessage, context: { requestId: string; sourceIp: string; time: Date }): Promise<UrlAnswer> {
    const caller = url.authType === UrlAuthType.AWS_IAM ? await this.callerOf(request, url) : undefined;
    const account = caller ? { status: caller.accountStatus, planId: caller.planId } : await this.accountOf(url);
    if (account.status !== AccountStatus.ACTIVE) throw new Refusal(HttpStatus.FORBIDDEN, 'Forbidden');
    await this.count(url, account.planId);
    const function_ = await this.functionOf(url);
    await this.admit(url);

    const body = await readBody(request, URL_PAYLOAD_LIMIT);
    // On a customer's domain, the event names it, and its first label, as API Gateway names a custom domain's.
    const domainName = hostName(request.headers.host) as string;
    const event = urlEvent({
      method: request.method ?? 'GET',
      target: originForm(request.url),
      rawHeaders: request.rawHeaders,
      body,
      sourceIp: context.sourceIp,
      protocol: `HTTP/${request.httpVersion}`,
      domainName,
      domainPrefix: urlIdOf(domainName, this.domain) ?? domainName.split('.')[0],
      urlId: url.urlId,
      requestId: context.requestId,
      time: context.time,
      accountId: caller ? url.accountId : 'anonymous',
      ...(caller ? { caller: { accessKey: caller.keyId as string, accountId: caller.accountId, userId: caller.userId as string } } : {}),
      // The API key that let the caller in is the account's secret: never the function's to see.
      ...(caller ? { withoutHeaders: ['authorization'] } : {}),
    });
    if (Buffer.byteLength(JSON.stringify(event)) > URL_PAYLOAD_LIMIT) {
      throw new Refusal(HttpStatus.PAYLOAD_TOO_LARGE, 'Request Entity Too Large', [['connection', 'close']]);
    }

    const outcome = await this.functions.call(function_, event, { source: InvocationSource.URL, requestId: context.requestId, history: eventForHistory(event) });
    if (!outcome.ok) {
      // No instance free in time: the caller may try again. The function's own error is its account's to read, in the history.
      if (outcome.error instanceof FunctionThrottledError) throw new Refusal(HttpStatus.TOO_MANY_REQUESTS, 'Too Many Requests');
      throw new Refusal(HttpStatus.BAD_GATEWAY, 'Internal Server Error');
    }
    return this.answerOf(function_, outcome.output, context.requestId);
  }

  /** The caller of a URL that takes the account's credentials: an API key of the account that may invoke. */
  private async callerOf(request: IncomingMessage, url: FunctionUrl): Promise<Principal> {
    const match = /^Bearer\s+(ffk_\S+)$/i.exec(single(request.headers.authorization)?.trim() ?? '');
    if (!match) throw new Refusal(HttpStatus.FORBIDDEN, 'Forbidden: this URL takes an API key of its account, as "Authorization: Bearer ffk_…"');
    let principal: Principal;
    try {
      principal = await this.apiKeys.authenticate(match[1]);
    } catch (error) {
      if (error instanceof UnauthorizedException) throw new Refusal(HttpStatus.FORBIDDEN, 'Forbidden');
      throw error;
    }
    // Another account's key is as good as none: the answer says nothing of whose the URL is.
    if (principal.accountId !== url.accountId) throw new Refusal(HttpStatus.FORBIDDEN, 'Forbidden');
    if (!principal.scopes?.includes('functions:invoke')) throw new Refusal(HttpStatus.FORBIDDEN, 'Forbidden: the API key lacks the scope functions:invoke');
    if (!WRITERS.includes(principal.role)) throw new Refusal(HttpStatus.FORBIDDEN, `Forbidden: the API key's creator has the ${principal.role} role, which can't invoke`);
    return principal;
  }

  private async accountOf(url: FunctionUrl): Promise<{ status: AccountStatus; planId: string }> {
    const account = await this.accounts.findOne({ where: { id: url.accountId }, select: { id: true, status: true, planId: true } });
    if (!account) throw new Refusal(HttpStatus.NOT_FOUND, 'Not Found');
    return account;
  }

  /** The call counts against the plan's invocations per second, with the API's invokes. */
  private async count(url: FunctionUrl, planId: string): Promise<void> {
    const plan = await this.plans.get(planId);
    const wait = await countInvocation(this.throttler, url.accountId, plan.limits.invokesPerSecond);
    if (wait === undefined) return;
    // A refused call reached no function and has no usage record: the Throttles metric counts it here, as the API's.
    this.refused.count(url.accountId, url.functionId);
    refusals.inc({ reason: 'rate_limit' });
    throw new Refusal(HttpStatus.TOO_MANY_REQUESTS, 'Too Many Requests', [['retry-after', String(wait)]]);
  }

  private async functionOf(url: FunctionUrl): Promise<Function> {
    let function_: Function;
    try {
      function_ = await this.functions.findOne(url.accountId, url.functionId);
    } catch (error) {
      // Deleted meanwhile: its URL went with it.
      if (error instanceof NotFoundException) throw new Refusal(HttpStatus.NOT_FOUND, 'Not Found');
      throw error;
    }
    if (function_.status !== FunctionStatus.ACTIVE) throw new Refusal(HttpStatus.SERVICE_UNAVAILABLE, 'Service Unavailable');
    if (function_.eventFormat !== EventFormat.LAMBDA) {
      // The API refuses a URL to such a function, and the format to a function with a URL: only a race gets here.
      this.logger.warn(`Function ${function_.id} has a URL but takes the wrapped event: its URL can't call it`);
      throw new Refusal(HttpStatus.SERVICE_UNAVAILABLE, 'Service Unavailable');
    }
    return function_;
  }

  /** The account's credit, as the API's invoke checks it; the caller learns nothing of the account's balance. */
  private async admit(url: FunctionUrl): Promise<void> {
    try {
      await this.credit.admit(url.accountId);
    } catch (error) {
      if (error instanceof InsufficientCreditException) throw new Refusal(HttpStatus.PAYMENT_REQUIRED, 'Payment Required');
      throw error;
    }
  }

  /** The function's return value as the response; 502 when it can't be one, the reason in the log. */
  private answerOf(function_: Function, output: unknown, requestId: string): UrlAnswer {
    let answer: UrlAnswer;
    try {
      answer = urlAnswer(output);
    } catch (error) {
      if (!(error instanceof InvalidUrlResponseError)) throw error;
      this.logger.warn(`Function ${function_.id} answered its URL with a response that can't be sent (request ${requestId}): ${error.message}`);
      throw new Refusal(HttpStatus.BAD_GATEWAY, 'Internal Server Error');
    }
    if (answer.body.length > URL_PAYLOAD_LIMIT) {
      this.logger.warn(`Function ${function_.id} answered its URL with ${answer.body.length} bytes, over the 6 MB limit (request ${requestId})`);
      throw new Refusal(HttpStatus.BAD_GATEWAY, 'Internal Server Error');
    }
    return answer;
  }

  private send(request: IncomingMessage, response: ServerResponse, answer: UrlAnswer, requestId: string): void {
    // No Content and Not Modified have no body, and say no length.
    const bodiless = [204, 304].includes(answer.status);
    const headers: Array<[string, string]> = [
      [URL_REQUEST_ID_HEADER, requestId],
      ...answer.headers,
      ...(bodiless ? [] : [['content-length', String(answer.body.length)] as [string, string]]),
    ];
    response.writeHead(answer.status, headers.flat());
    response.end(bodiless || request.method === 'HEAD' ? undefined : answer.body);
    urlResponses.inc({ class: statusClass(answer.status) });
  }
}

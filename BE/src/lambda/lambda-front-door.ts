import { HttpException, Injectable, Logger, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectThrottlerStorage, ThrottlerStorage } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { AccountStatus } from '../accounts/entities/account.entity';
import { describeError } from '../common/describe-error';
import { BodyRefusals, readBody, requestTarget } from '../common/http-request';
import { closeHttp, listenHttp } from '../common/http-server';
import { withRequestContext } from '../common/request-context';
import { FunctionNamed, parseFunctionName, qualifiedFunctionArn } from '../functions/arns';
import { FunctionsService } from '../functions/functions.service';
import { PlansService } from '../plans/plans.service';
import { countWrite } from '../plans/rate-limits';
import { functionAccessOf, keyLabel, mayUse, reachesAnyFunction } from '../storage/key-reach';
import { ActiveKey, EXPIRED, StorageDirectory } from '../storage/storage-directory.service';
import { FunctionAccess } from '../storage/storage-key.entity';
import {
  LambdaError,
  accessDenied,
  expiredToken,
  invalidParameterValue,
  invalidRequestContent,
  lambdaErrorOf,
  missingAuthenticationToken,
  notOffered,
  requestEntityTooLarge,
  resourceNotFound,
  serviceException,
  tooManyRequests,
  unknownOperation,
  unrecognizedClient,
} from './lambda-error';
import { CODE_LINK_PATH, LambdaCodeLinks } from './lambda-code-links';
import { LambdaAnswer, LambdaCall, LambdaCaller, LambdaOperation, LambdaOperations, PAYLOAD_BYTES, laterOperationOf, operationOf } from './lambda-operations';
import { checkLambdaSignature, readLambdaSignature } from './lambda-signature';

/** What a level lets a key do with a function, as a refusal says it. */
const DOES: Record<FunctionAccess, string> = { read: 'read', invoke: 'invoke', write: 'change' };

/** A body past its operation's limit, or a client gone before it ended: Lambda's words, the operation's limit named. */
const bodyRefusals = (operation: string | undefined): BodyRefusals => ({
  tooLarge: (limit) => requestEntityTooLarge(limit, operation ?? 'requested'),
  incomplete: () => invalidRequestContent('The client went before its request ended.'),
});

/**
 * Lambda's endpoint (ADR 0014): a server of its own, on FF_LAMBDA_PORT, which
 * answers AWS's SDKs, CLI and Terraform's provider as AWS Lambda does, in its
 * REST API and JSON at its dated paths, with only the endpoint changed
 * (AWS_ENDPOINT_URL_LAMBDA): signed with Signature Version 4 for the service
 * lambda, the path escaped twice, by one of FF's access keys that reaches the
 * function at the level the operation needs (read, invoke, write), or a
 * function's own key, which invokes alone. Its account must be active. A
 * function is named by its name, its ARN or its partial ARN, with a version
 * or an alias after it; another account's answers as one that doesn't exist.
 * Changes count against the plan's changes a minute, with FF's API's. Each
 * answer carries its request ID, x-amzn-RequestId; each error its name in
 * x-amzn-ErrorType. At /code/{token} it answers, unsigned, the code that a
 * link GetFunction gave names, for its 10 minutes.
 */
@Injectable()
export class LambdaFrontDoor implements OnModuleDestroy {
  private readonly logger = new Logger(LambdaFrontDoor.name);
  private readonly region: string;
  private server?: Server;
  /** Once the server stops, each answer closes its connection: a client kept alive doesn't hold the stop up. */
  private stopping = false;

  constructor(
    config: ConfigService,
    private readonly directory: StorageDirectory,
    private readonly functions: FunctionsService,
    private readonly operations: LambdaOperations,
    private readonly links: LambdaCodeLinks,
    private readonly plans: PlansService,
    @InjectThrottlerStorage() private readonly throttler: ThrottlerStorage,
  ) {
    this.region = config.getOrThrow<string>('lambda.region');
  }

  /** Starts answering on the port; main.ts calls it once the API listens. Port 0 takes any free one, as the tests do. */
  async listen(port: number, host?: string): Promise<AddressInfo> {
    const server = createServer((request, response) => void this.serve(request, response));
    const address = await listenHttp(server, port, host);
    this.server = server;
    return address;
  }

  /** Stops taking requests, and waits for those under way. */
  async onModuleDestroy(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.stopping = true;
    if (server) await closeHttp(server);
  }

  /** Answers one request; never throws, as nothing would catch it. */
  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const id = randomUUID();
    try {
      this.reply(request, response, id, await this.answer(request, id));
    } catch (error) {
      // FF's services refuse as FF's API answers: the same refusal, under Lambda's name.
      const known = error instanceof LambdaError ? error : error instanceof HttpException ? lambdaErrorOf(error, this.region) : undefined;
      if (!known) this.logger.error(`A Lambda request failed (request ${id}): ${describeError(error)}`, error instanceof Error ? error.stack : undefined);
      const refusal = known ?? serviceException();
      this.reply(request, response, id, { status: refusal.status, document: refusal.document(), headers: { 'x-amzn-errortype': refusal.type, ...refusal.headers } });
    }
  }

  /** The answer, its JSON or its body as is, unless the client went; a body not read is not waited for. */
  private reply(request: IncomingMessage, response: ServerResponse, id: string, answer: LambdaAnswer): void {
    if (response.headersSent || response.destroyed) return;
    const body = answer.body ?? (answer.document === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(answer.document)));
    response.writeHead(answer.status, {
      'content-type': 'application/json',
      'content-length': body.length,
      'x-amzn-requestid': id,
      ...(request.complete && !this.stopping ? {} : { connection: 'close' }),
      ...answer.headers,
    });
    response.end(body);
  }

  /** The operation's answer, once the request is signed by a key that may make it with what it names. */
  private async answer(request: IncomingMessage, requestId: string): Promise<LambdaAnswer> {
    const method = request.method ?? 'GET';
    const { rawPath, rawQuery } = requestTarget(request.url);
    const route = operationOf(method, rawPath);
    // One of Lambda's other operations is named in its refusal, its body read to Lambda's own limit for it.
    const later = route ? null : laterOperationOf(method, rawPath, rawQuery);
    const limited = route?.operation ?? later;
    const body = await readBody(request, limited?.maxBodyBytes ?? PAYLOAD_BYTES, bodyRefusals(limited?.name));
    // A link to a function's code, which GetFunction gave: unsigned, its token the proof.
    const link = method === 'GET' ? CODE_LINK_PATH.exec(rawPath) : null;
    if (link) return this.code(link[1]);
    const signature = readLambdaSignature(request.headers);
    if (!signature) throw missingAuthenticationToken();
    const key = await this.directory.key(signature.accessKeyId);
    if (key === EXPIRED) throw expiredToken();
    if (!key) throw unrecognizedClient();
    checkLambdaSignature({ method, rawPath, rawQuery, rawHeaders: request.rawHeaders }, body, signature, key.secret, new Date());
    this.directory.touch(key.id);
    const account = await this.directory.account(key.accountId);
    if (!account || account.status !== AccountStatus.ACTIVE) throw accessDenied(`The account is ${account?.status ?? 'gone'}: its functions answer no key.`);
    // What FF doesn't offer, named as asked, once the key is known to be good: an unsigned request learns nothing.
    if (later) throw notOffered(later.name, later.instead);
    if (!route) throw unknownOperation(`FF doesn't offer this operation of Lambda's API yet: ${method} ${rawPath}.`);
    const { operation, groups } = route;
    const query = new URLSearchParams(rawQuery);
    const call: LambdaCall = { operation, groups, query, input: operation.payload ? {} : inputOf(body), body, headers: request.headers };
    const caller: LambdaCaller = {
      accountId: key.accountId,
      region: this.region,
      key,
      plan: await this.plans.get(account.planId),
      mayUse: (name, needed) => mayUse(key, name, needed),
      // Changes are the key's in the audit log, which a request here doesn't name otherwise.
      actor: { id: `access_key:${key.id}`, label: `access key ${key.id}` },
      ip: request.socket.remoteAddress,
    };
    await this.admit(call, caller);
    if (operation.access === 'write') {
      const wait = await countWrite(this.throttler, key.accountId, caller.plan.limits.writesPerMinute);
      if (wait !== undefined) throw tooManyRequests(`Rate exceeded: the ${caller.plan.name} plan allows ${caller.plan.limits.writesPerMinute} changes per minute.`, wait);
    }
    const handler = this.operations.handler(operation.name);
    if (!handler) throw notOffered(operation.name);
    // What FF's services record of the change names the key, its address and the request, as FF's API's do.
    return withRequestContext({ requestId, actor: caller.actor, ...(caller.ip ? { ip: caller.ip } : {}) }, () => handler(call, caller));
  }

  /**
   * The code a link names, as a zip; refused as S3 refuses a link, Lambda's
   * being S3's: one FF didn't make, one past its 10 minutes, or one of an
   * account that is no longer active; and a function or a version gone since.
   */
  private async code(token: string): Promise<LambdaAnswer> {
    const target = this.links.open(token);
    if (target === 'expired') return s3Refusal(403, 'AccessDenied', 'Request has expired');
    if (!target) return s3Refusal(403, 'AccessDenied', "The link isn't one that GetFunction gave.");
    const account = await this.directory.account(target.accountId);
    if (!account || account.status !== AccountStatus.ACTIVE) return s3Refusal(403, 'AccessDenied', `The account is ${account?.status ?? 'gone'}: its code answers no link.`);
    try {
      const { zip } = await this.functions.code(target.accountId, target.functionId, target.version === undefined ? {} : { version: target.version });
      return { status: 200, body: zip, headers: { 'content-type': 'application/zip' } };
    } catch (error) {
      if (error instanceof NotFoundException) return s3Refusal(404, 'NoSuchKey', 'The function, or its version, is gone since the link was given.');
      throw error;
    }
  }

  /**
   * What the operation names, and whether the key may make it with that: a
   * function, by its name, at the operation's level, then found in the key's
   * account, where a path or a tag names it; the account, for a key that
   * names functions. A mapping's operations check its function once they
   * have read it.
   */
  private async admit(call: LambdaCall, caller: LambdaCaller): Promise<void> {
    const { operation } = call;
    const named = namedBy(call);
    if (!named) {
      if (!reachesAnyFunction(caller.key)) throw cannot(caller.key, operation);
      return;
    }
    if (!caller.mayUse(named.name, operation.access)) throw cannot(caller.key, operation, named.name);
    caller.named = { name: named.name, ...(named.qualifier ? { qualifier: named.qualifier } : {}) };
    if (operation.namedIn !== 'path' && operation.namedIn !== 'resource') return;
    const missing = () => resourceNotFound(`Function not found: ${qualifiedFunctionArn(named.region ?? this.region, named.accountId ?? caller.accountId, named.name, named.qualifier)}`);
    // Another account's function, or another region's, is one this account doesn't have.
    if ((named.accountId && named.accountId !== caller.accountId) || (named.region && named.region !== this.region)) throw missing();
    const [function_] = await this.functions.findAll(caller.accountId, named.name);
    if (!function_) throw missing();
    caller.function_ = function_;
  }
}

/** A refusal of a code link, in S3's XML, as Lambda's links are S3's. */
function s3Refusal(status: number, code: string, message: string): LambdaAnswer {
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${message}</Message></Error>`;
  return { status, body: Buffer.from(body, 'utf8'), headers: { 'content-type': 'application/xml' } };
}

/** The request's JSON body, an object; {} for none. */
function inputOf(body: Buffer): Record<string, unknown> {
  if (body.length === 0) return {};
  let input: unknown;
  try {
    input = JSON.parse(body.toString('utf8'));
  } catch (error) {
    throw invalidRequestContent(`Could not parse request body into json: ${describeError(error)}`);
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalidRequestContent('The request body must be a JSON object.');
  return input as Record<string, unknown>;
}

/** The function a request names, and where it says so: none for the account's operations and a mapping's, and a list naming none. */
function namedBy({ operation, groups, query, input }: LambdaCall): FunctionNamed | null {
  let value: unknown;
  switch (operation.namedIn) {
    case 'account':
    case 'mapping':
      return null;
    case 'query':
      value = query.get('FunctionName') ?? undefined;
      if (value === undefined) return null;
      break;
    case 'body':
      value = input.FunctionName;
      if (value === undefined) throw invalidParameterValue('FunctionName is required.');
      break;
    case 'path':
    case 'resource':
      value = groups[0];
      break;
  }
  const named = typeof value === 'string' ? parseFunctionName(value) : undefined;
  if (!named || (operation.namedIn === 'resource' && !named.region)) {
    throw invalidParameterValue(
      operation.namedIn === 'resource'
        ? `The resource must be a function's ARN, arn:aws:lambda:<region>:<account>:function:<name>, not ${String(value)}.`
        : `FunctionName must be a function's name, its ARN or its partial ARN, a version or an alias after it if any, not ${String(value)}.`,
    );
  }
  const asked = query.get('Qualifier') ?? undefined;
  if (asked !== undefined && named.qualifier !== undefined && asked !== named.qualifier) {
    throw invalidParameterValue('The derived qualifier from the function name does not match the specified qualifier.');
  }
  const qualifier = named.qualifier ?? (asked && asked !== '$LATEST' ? asked : undefined);
  return { ...named, ...(qualifier ? { qualifier } : {}) };
}

/** The key may not make the operation: with that function, at that level, or with the account's functions at all. */
function cannot(key: ActiveKey, operation: LambdaOperation, name?: string): LambdaError {
  const label = keyLabel(key);
  if (key.functionId !== null) {
    return accessDenied(`A function's own key invokes its account's functions and does nothing else with them: ${operation.name} needs an access key that may ${DOES[operation.access]} them.`);
  }
  if (name === undefined) return accessDenied(`The access key ${label} reaches no function: ${operation.name} needs a key that does.`);
  const access = functionAccessOf(key, name);
  if (!access) return accessDenied(`The access key ${label} doesn't reach the function ${name}.`);
  return accessDenied(`The access key ${label} may ${DOES[access]} the function ${name}, not ${DOES[operation.access]} it.`);
}

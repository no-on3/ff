import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectThrottlerStorage, ThrottlerStorage } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { AccountStatus } from '../accounts/entities/account.entity';
import { InsufficientCreditException } from '../billing/credit-policy';
import { CreditService } from '../billing/credit.service';
import { describeError } from '../common/describe-error';
import { PlansService } from '../plans/plans.service';
import { countQueueRequest } from '../plans/rate-limits';
import { originForm } from '../storage/front-door';
import { StorageDirectory } from '../storage/storage-directory.service';
import { SqsError, accessDenied, internalError, invalidClientTokenId, invalidParameter, missingAuthenticationToken, requestThrottled } from './sqs-error';
import { Caller, SENDING_OPERATIONS, SqsOperations } from './sqs-operations';
import { checkSqsSignature, readSqsSignature } from './sqs-signature';

/** The most a request's body holds: a batch of messages of 1 MiB together, in JSON, binary attributes in base64. */
const MAX_BODY_BYTES = 3 * 1024 * 1024;

const CONTENT_TYPE = 'application/x-amz-json-1.0';
const TARGET_PREFIX = 'AmazonSQS.';

const single = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

const tooLarge = (limit: number) => new SqsError(413, 'RequestEntityTooLarge', `The request is over ${limit} bytes.`);

/**
 * The request's body, whole, `limit` bytes at most: past it, what is left
 * isn't read, and the answer closes the connection.
 */
function bodyOf(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (Number(single(request.headers['content-length']) ?? 0) > limit) return reject(tooLarge(limit));
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) return void chunks.push(chunk);
      request.off('data', onData);
      request.pause();
      reject(tooLarge(limit));
    };
    request.on('data', onData);
    request.once('end', () => resolve(Buffer.concat(chunks)));
    request.once('error', reject);
    // A client gone before its request ended: no one to answer.
    request.once('close', () => request.complete || reject(new SqsError(400, 'IncompleteRequest', 'The client went before its request ended.')));
  });
}

/**
 * The SQS endpoint (ADR 0010): a server of its own, on FF_SQS_PORT, which
 * answers AWS's SDKs and CLI as Amazon SQS does, in its JSON protocol, with
 * only the endpoint changed: POST /, the operation in X-Amz-Target, signed
 * with Signature Version 4 for the service sqs by one of FF's access keys,
 * which reach the account's queues, or those they name, a read-only one only
 * reading them. Every key is checked the same way as at the S3 front door:
 * its account active, its databases, buckets and queues on, the plan's queue
 * requests per second; sending, the account's credit too, while receiving
 * and deleting go on.
 * Each answer carries its request ID, x-amzn-RequestId; each error SQS's two
 * names for it, the body's __type and the x-amzn-query-error header.
 */
@Injectable()
export class SqsFrontDoor implements OnModuleDestroy {
  private readonly logger = new Logger(SqsFrontDoor.name);
  private server?: Server;
  /** Each request under way's way to end a long poll, should the server stop. */
  private readonly polls = new Set<AbortController>();
  /** Once the server stops, each answer closes its connection: a client kept alive doesn't hold the stop up. */
  private stopping = false;
  /** The endpoint customers give AWS's SDKs and CLI, and the one functions reach inside the cluster ('' for none), with its host. */
  private readonly base: string;
  private readonly functionEndpoint: { url: string; host: string };

  constructor(
    config: ConfigService,
    private readonly directory: StorageDirectory,
    private readonly operations: SqsOperations,
    private readonly plans: PlansService,
    private readonly credit: CreditService,
    @InjectThrottlerStorage() private readonly throttler: ThrottlerStorage,
  ) {
    const sqs = config.getOrThrow<{ base: string; functionEndpoint?: string }>('sqs');
    this.base = sqs.base;
    this.functionEndpoint = { url: sqs.functionEndpoint ?? '', host: sqs.functionEndpoint ? new URL(sqs.functionEndpoint).host : '' };
  }

  /** Starts answering on the port; main.ts calls it once the API listens. Port 0 takes any free one, as the tests do. */
  async listen(port: number, host?: string): Promise<AddressInfo> {
    const server = createServer((request, response) => void this.serve(request, response));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    return server.address() as AddressInfo;
  }

  /** Stops taking requests, ends the long polls, and waits for those under way. */
  async onModuleDestroy(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.stopping = true;
    for (const poll of this.polls) poll.abort();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Answers one request; never throws, as nothing would catch it. */
  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const id = randomUUID();
    const poll = new AbortController();
    this.polls.add(poll);
    response.on('close', () => poll.abort());
    try {
      this.reply(request, response, id, 200, await this.answer(request, poll.signal));
    } catch (error) {
      if (!(error instanceof SqsError)) this.logger.error(`An SQS request failed (request ${id}): ${describeError(error)}`, error instanceof Error ? error.stack : undefined);
      const refusal = error instanceof SqsError ? error : internalError();
      this.reply(request, response, id, refusal.status, refusal.document(), { 'x-amzn-query-error': refusal.queryError() });
    } finally {
      this.polls.delete(poll);
    }
  }

  /** The answer, as JSON, unless the client went; a body not read is not waited for. */
  private reply(request: IncomingMessage, response: ServerResponse, id: string, status: number, document: unknown, headers: Record<string, string> = {}): void {
    if (response.headersSent || response.destroyed) return;
    const body = JSON.stringify(document);
    response.writeHead(status, {
      'content-type': CONTENT_TYPE,
      'content-length': Buffer.byteLength(body),
      'x-amzn-requestid': id,
      ...(request.complete && !this.stopping ? {} : { connection: 'close' }),
      ...headers,
    });
    response.end(body);
  }

  /** The operation's answer, once the request is signed by a key that reaches its account's queues. */
  private async answer(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
    const target = single(request.headers['x-amz-target']) ?? '';
    const contentType = single(request.headers['content-type']) ?? '';
    if (request.method !== 'POST' || !target.startsWith(TARGET_PREFIX) || !contentType.startsWith(CONTENT_TYPE)) {
      throw new SqsError(400, 'UnsupportedOperation', "FF's SQS endpoint speaks SQS's JSON protocol: POST / with X-Amz-Target AmazonSQS.<operation>, as AWS's SDKs and CLI send it.", 'AWS.SimpleQueueService.UnsupportedOperation');
    }
    const body = await bodyOf(request, MAX_BODY_BYTES);
    const signature = readSqsSignature(request.headers);
    if (!signature) throw missingAuthenticationToken();
    const key = await this.directory.key(signature.accessKeyId);
    if (!key) throw invalidClientTokenId();
    const url = originForm(request.url);
    const at = url.indexOf('?');
    checkSqsSignature(
      { method: 'POST', rawPath: at < 0 ? url : url.slice(0, at), rawQuery: at < 0 ? '' : url.slice(at + 1), rawHeaders: request.rawHeaders },
      body,
      signature,
      key.secret,
      new Date(),
    );
    this.directory.touch(key.id);
    let input: Record<string, unknown>;
    try {
      input = body.length ? (JSON.parse(body.toString('utf8')) as Record<string, unknown>) : {};
    } catch {
      throw invalidParameter('The request body is not JSON.');
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalidParameter('The request body must be a JSON object.');
    const operation = target.slice(TARGET_PREFIX.length);
    const caller = await this.admit(key.accountId, key.id, key.readOnly, SENDING_OPERATIONS.has(operation), signal);
    return this.operations.run(operation, input, {
      ...caller,
      endpoint: this.endpointOf(request),
      reach: { buckets: key.buckets, queues: key.queues },
      // Changes are the key's in the audit log, which a request here doesn't name otherwise.
      actor: { id: `access_key:${key.id}`, label: `access key ${key.id}` },
      ip: request.socket.remoteAddress,
    });
  }

  /**
   * The endpoint a request reached, which the queues' URLs answered to it
   * begin with: functions' own, inside the cluster, for a request to its host,
   * so that a URL a function is given keeps it there, as AWS's SDK for
   * JavaScript sends a queue's requests to its URL's host; FF_SQS_BASE for
   * any other.
   */
  private endpointOf(request: IncomingMessage): string {
    const host = single(request.headers.host)?.toLowerCase();
    return this.functionEndpoint.host && host === this.functionEndpoint.host ? this.functionEndpoint.url : this.base;
  }

  /**
   * The key's account, as every key is checked: active, its databases, buckets
   * and queues on, within the plan's queue requests per second; for a send, its
   * credit too.
   */
  private async admit(accountId: string, keyId: string, readOnly: boolean, sends: boolean, signal: AbortSignal): Promise<Caller> {
    const account = await this.directory.account(accountId);
    if (!account || account.status !== AccountStatus.ACTIVE) throw accessDenied(`The account is ${account?.status ?? 'gone'}: its queues answer no key.`);
    if (account.storageDisabledAt) throw accessDenied(`FF turned the account's databases, buckets and queues off: ${account.storageDisabledReason}`);
    const plan = await this.plans.get(account.planId);
    if ((await countQueueRequest(this.throttler, account.id, plan.limits.queueRequestsPerSecond)) !== undefined) {
      throw requestThrottled(`Rate exceeded: the ${plan.name} plan allows ${plan.limits.queueRequestsPerSecond} requests to the queues a second.`);
    }
    if (sends) {
      try {
        await this.credit.admit(accountId);
      } catch (error) {
        if (error instanceof InsufficientCreditException) throw accessDenied("The account is out of credit: its messages are received and deleted, and sending waits for credit.");
        throw error;
      }
    }
    return { accountId, keyId, readOnly, plan, signal };
  }
}

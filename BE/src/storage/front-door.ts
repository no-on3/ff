import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectThrottlerStorage, ThrottlerStorage } from '@nestjs/throttler';
import { createHash, randomBytes } from 'node:crypto';
import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AccountStatus } from '../accounts/entities/account.entity';
import { InsufficientCreditException } from '../billing/credit-policy';
import { CreditService } from '../billing/credit.service';
import { describeError } from '../common/describe-error';
import { AwsEndpoint } from '../common/aws-endpoint';
import { closeHttp, listenHttp } from '../common/http-server';
import { PlanView } from '../plans/plan-limits';
import { PlansService } from '../plans/plans.service';
import { countStorageRequest } from '../plans/rate-limits';
import { ChunkedBodyReader, ExpectedChecksum, PlainBodyChecker, STREAMING_SIGNED, STREAMING_SIGNED_TRAILER, STREAMING_UNSIGNED_TRAILER, isStreaming } from './aws-chunked';
import { BucketEvents } from './bucket-events';
import { nextSequencer, ruleFor, rulesFromXml, rulesXml, s3EventRecord } from './bucket-notifications';
import { BucketNotificationsService, ChangedBy } from './bucket-notifications.service';
import { BucketWebsitesService } from './bucket-websites.service';
import { Bucket } from './bucket.entity';
import { CHECKSUM_ALGORITHMS, isChecksumAlgorithm } from './checksums';
import { fullBuckets } from './bucket-storage';
import { S3Error, accessDenied, accountProblem, errorDocument, internalError, invalidAccessKeyId, invalidRequest, noSuchBucket, notImplemented } from './s3-error';
import { S3Address, S3Operation, addressOf, operationOf } from './s3-requests';
import { RequestSignature, SigningChain, UNSIGNED_PAYLOAD, checkSignature, decodeEscapes, readSignature } from './sigv4';
import { StoreClient } from './store-client';
import { reachesBucket } from './key-reach';
import { KeyUses } from './key-uses.service';
import { ActiveKey, StorageDirectory } from './storage-directory.service';
import { StorageRequestCountsService } from './storage-request-counts.service';
import { noSuchWebsiteConfiguration, websiteFromXml, websiteXml } from './website';
import { listBucketsDocument, locationDocument, replacing } from './xml';
import { MalformedXml, childText, childrenNamed, readXml } from './xml-reader';

/** S3's limit on an object sent in one PUT, and on a part of a multipart upload: 5 GiB. */
export const MAX_UPLOAD_BYTES = 5 * 1024 ** 3;

const MB = 1024 * 1024;

/** The XML bodies read whole before they go to the store: a batch of deletes, a multipart upload's completion. */
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

/** The request's headers the store gets: the object's own, and the conditions. Never the client's signature, nor its checksums, which the front door checks. */
const FORWARDED =
  /^(content-type|content-md5|content-language|content-disposition|cache-control|expires|range|if-match|if-none-match|if-modified-since|if-unmodified-since|x-amz-meta-[!-~]+|x-amz-copy-source-range|x-amz-copy-source-if-(match|none-match|modified-since|unmodified-since)|x-amz-metadata-directive)$/;

/** The writes that make an object of the request's own type: a copy only when it replaces the source's metadata. */
const TYPED_WRITES = new Set(['PutObject', 'CreateMultipartUpload', 'CopyObject']);

/** What S3 stores an object as, when its upload gives no type; the store would guess one from its bytes instead. */
const S3_DEFAULT_TYPE = 'binary/octet-stream';

/** The store's answer headers the client gets. */
const ANSWERED = /^(content-type|content-length|content-range|content-encoding|content-language|content-disposition|cache-control|expires|etag|last-modified|accept-ranges|x-amz-meta-[!-~]+|x-amz-mp-parts-count)$/;

/** Operations whose small XML body is read whole, then sent with its MD5, which some stores require of a batch of deletes. */
const DOCUMENT_BODIES = new Set(['DeleteObjects', 'CompleteMultipartUpload']);

/** Operations whose object or part is limited to 5 GiB; PutObject's object, to the plan's maxObjectMb too. */
const UPLOADS = new Set(['PutObject', 'UploadPart']);

const single = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

type Stage = NodeJS.ReadableStream | NodeJS.WritableStream | NodeJS.ReadWriteStream;

/** The request's path and query: an absolute target, as a proxy may send one, without its scheme and host. */
export function originForm(target: string | undefined): string {
  if (target?.startsWith('/')) return target;
  try {
    const url = new URL(target ?? '');
    return `${url.pathname}${url.search}`;
  } catch {
    return '/';
  }
}

/** The query that goes to the store: without the signature's parameters, the checksum a presigned URL signs, nor the SDKs' x-id. */
export function queryForStore(rawQuery: string): string {
  return rawQuery
    .split('&')
    .filter((pair) => {
      const name = decodeEscapes(pair.split('=')[0]);
      return pair && !/^x-amz-/i.test(name) && name !== 'x-id';
    })
    .join('&');
}

/** Counts the bytes that stream past. */
function counter(count: (bytes: number) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      count(chunk.length);
      done(null, chunk);
    },
  });
}

/** A whole body, at most `limit` bytes, through these checks. */
async function readWhole(stages: Stage[], limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      if (size > limit) {
        done(new S3Error(400, 'MaxMessageLengthExceeded', 'Your request was too big.'));
        return;
      }
      chunks.push(chunk);
      done();
    },
  });
  await pipeline([...stages, sink]);
  return Buffer.concat(chunks);
}

/** One request and its answer, as the front door learns of them. */
interface Exchange {
  id: string;
  request: IncomingMessage;
  response: ServerResponse;
  method: string;
  rawPath: string;
  rawQuery: string;
  query: URLSearchParams;
  address: S3Address;
  /** The bucket it counts in, once the key's account owns it. */
  bucket?: Bucket;
  operation?: S3Operation;
  bytesIn: number;
  bytesOut: number;
  /** The client waits for "100 Continue" before it sends its body: sent only once the request is let in. */
  expectsContinue: boolean;
  /** The keys a DeleteObjects deleted, as the store's answer names them, for the bucket's notifications. */
  deletedKeys?: string[];
}

/** S3's event for each write that creates an object, by the operation, without its s3: prefix. */
const CREATED_EVENTS: Record<string, string> = {
  PutObject: 'ObjectCreated:Put',
  CopyObject: 'ObjectCreated:Copy',
  CompleteMultipartUpload: 'ObjectCreated:CompleteMultipartUpload',
};

/** The keys DeleteObjects' answer says it deleted; none when the answer can't be read. */
function deletedKeysOf(document: string): string[] {
  try {
    return childrenNamed(readXml(document), 'Deleted').map((deleted) => childText(deleted, 'Key') ?? '');
  } catch (error) {
    if (error instanceof MalformedXml) return [];
    throw error;
  }
}

/** The checksum an upload carries in a header, at most one, or announces for its trailer. */
function expectedChecksum(request: IncomingMessage): { checksum?: ExpectedChecksum; trailerName?: string } {
  const trailer = single(request.headers['x-amz-trailer'])?.trim().toLowerCase();
  const inHeaders = CHECKSUM_ALGORITHMS.filter((algorithm) => request.headers[`x-amz-checksum-${algorithm}`] !== undefined);
  if (inHeaders.length > 1) throw invalidRequest('Expecting a single x-amz-checksum- header. Multiple checksum Types are not allowed.');
  if (trailer) {
    const algorithm = trailer.replace(/^x-amz-checksum-/, '');
    if (!trailer.startsWith('x-amz-checksum-') || !isChecksumAlgorithm(algorithm)) throw invalidRequest(`The trailer ${trailer} is not a checksum S3 knows`);
    return { checksum: { algorithm }, trailerName: trailer };
  }
  if (inHeaders.length === 1) {
    const algorithm = inHeaders[0];
    return { checksum: { algorithm, value: single(request.headers[`x-amz-checksum-${algorithm}`]) } };
  }
  return {};
}

/**
 * The S3 front door (ADR 0009): a server of its own, on FF_STORAGE_PORT, in
 * front of the store, which answers AWS's SDKs and CLI as S3 does, with only
 * the endpoint changed. Each request is signed with Signature Version 4, in its
 * Authorization header or as a presigned URL, with one of FF's access keys; it
 * reaches a bucket of the key's account only, one of those the key names, and
 * writes only with a read-write key. A body is checked as it streams to the
 * store (its signed SHA-256, each chunk's signature, its checksum, its length)
 * and cut before its end when it fails, so the store never keeps it. The store
 * gets FF's own signature, the bucket's name there, and no checksum header;
 * its answers come back as they come, naming the customer's bucket. Each
 * request let into a bucket counts in its minute, by AWS's classes. Every key
 * is checked the same way: its account active, its storage on, the plan's
 * requests per second; an upload, the account's credit and the plan's largest
 * object; deletes and reads go on without credit.
 */
@Injectable()
export class S3FrontDoor implements OnModuleDestroy {
  private readonly logger = new Logger(S3FrontDoor.name);
  /** The events of answered writes still being sent. */
  private readonly notifying = new Set<Promise<void>>();
  /** The host customers reach it at: path-style there, and virtual-hosted under it. */
  private readonly host: string;
  private readonly protocol: string;
  private readonly region: string;
  private readonly store: StoreClient;
  private server?: Server;

  constructor(
    config: ConfigService,
    private readonly directory: StorageDirectory,
    private readonly counts: StorageRequestCountsService,
    private readonly plans: PlansService,
    private readonly credit: CreditService,
    @InjectThrottlerStorage() private readonly throttler: ThrottlerStorage,
    private readonly notifications: BucketNotificationsService,
    private readonly bucketEvents: BucketEvents,
    private readonly websites: BucketWebsitesService,
    private readonly keyUses: KeyUses,
  ) {
    const base = new URL(config.getOrThrow<string>('storage.base'));
    this.host = base.hostname;
    this.protocol = base.protocol;
    this.region = config.getOrThrow<string>('storage.region');
    const objectStore = config.getOrThrow<{ endPoint: string; port: number; useSSL: boolean; accessKey: string; secretKey: string }>('objectStore');
    this.store = new StoreClient({
      endpoint: `${objectStore.useSSL ? 'https' : 'http'}://${objectStore.endPoint}:${objectStore.port}`,
      accessKeyId: objectStore.accessKey,
      secretAccessKey: objectStore.secretKey,
    });
  }

  /** Starts answering on the port; main.ts calls it once the API listens. Port 0 takes any free one, as the tests do. */
  async listen(port: number, host?: string): Promise<AddressInfo> {
    const server = createServer();
    server.on('request', (request: IncomingMessage, response: ServerResponse) => void this.serve(request, response, false));
    server.on('checkContinue', (request: IncomingMessage, response: ServerResponse) => void this.serve(request, response, true));
    // Uploads of gigabytes take longer than Node.js's default 5 minutes; a connection silent for 2 minutes goes.
    server.requestTimeout = 0;
    server.setTimeout(120_000);
    const address = await listenHttp(server, port, host);
    this.server = server;
    return address;
  }

  /** Stops taking requests, and waits for those under way. */
  async onModuleDestroy(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) await closeHttp(server);
    // Events of writes the store took, still being sent: a stop waits for them rather than lose them.
    await this.notified();
    this.store.close();
  }

  /** Waits for the events being sent of the writes answered so far. */
  async notified(): Promise<void> {
    while (this.notifying.size > 0) await Promise.all([...this.notifying]);
  }

  /** Answers one request; never throws, as nothing would catch it. */
  private async serve(request: IncomingMessage, response: ServerResponse, expectsContinue: boolean): Promise<void> {
    const target = originForm(request.url);
    const at = target.indexOf('?');
    const rawPath = at < 0 ? target : target.slice(0, at);
    const rawQuery = at < 0 ? '' : target.slice(at + 1);
    const exchange: Exchange = {
      id: randomBytes(8).toString('hex').toUpperCase(),
      request,
      response,
      method: request.method ?? 'GET',
      rawPath,
      rawQuery,
      query: new URLSearchParams(rawQuery),
      address: addressOf(single(request.headers.host), rawPath, this.host),
      bytesIn: 0,
      bytesOut: 0,
      expectsContinue,
    };
    const started = new Date();
    let status = 500;
    try {
      status = await this.answer(exchange);
    } catch (error) {
      const refusal = error instanceof S3Error ? error : internalError();
      if (!(error instanceof S3Error) && response.headersSent) {
        // The answer had begun: the client went, or the store's answer broke off.
        this.logger.warn(`An S3 answer was cut short (request ${exchange.id}): ${describeError(error)}`);
      } else if (!(error instanceof S3Error)) {
        this.logger.error(`An S3 request failed (request ${exchange.id}): ${describeError(error)}`, error instanceof Error ? error.stack : undefined);
      }
      status = refusal.status;
      this.refuse(exchange, refusal);
    } finally {
      if (exchange.bucket && exchange.operation) {
        this.counts.count({
          bucketId: exchange.bucket.id,
          accountId: exchange.bucket.accountId,
          bucketName: exchange.bucket.name,
          class: exchange.operation.class,
          method: exchange.method,
          status,
          bytesIn: exchange.bytesIn,
          bytesOut: exchange.bytesOut,
          at: started,
        });
      }
    }
  }

  /** The error's document, unless the answer has begun, when the connection is cut instead; a body not read is not waited for. */
  private refuse({ id, request, response, method, address, rawPath }: Exchange, error: S3Error): void {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const body = method === 'HEAD' ? '' : errorDocument(error, id, address.bucket ? decodeEscapes(rawPath) : undefined);
    const headers: Record<string, string | number> = { 'content-type': 'application/xml', 'content-length': Buffer.byteLength(body), 'x-amz-request-id': id };
    if (!request.complete) headers.connection = 'close';
    response.writeHead(error.status, headers);
    response.end(body);
  }

  /** The answer, sent; its status. */
  private async answer(exchange: Exchange): Promise<number> {
    const { request, method, rawPath, rawQuery, query, address } = exchange;
    const signature = readSignature(request.headers, query);
    if (!signature) throw accessDenied();
    const key = await this.directory.key(signature.accessKeyId);
    if (!key) throw invalidAccessKeyId();
    const chain = checkSignature({ method, rawPath, rawQuery, rawHeaders: request.rawHeaders }, signature, key.secret, new Date());
    this.directory.touch(key.id);
    const { plan, bucketsFull } = await this.admitAccount(key.accountId);

    const operation = operationOf(method, address, query, request.headers);
    if (operation.name === 'NotImplemented') throw notImplemented();
    if (operation.name === 'ListBuckets') {
      this.used(key, operation.name, '');
      const buckets = (await this.directory.bucketsOf(key.accountId)).filter((bucket) => reachesBucket(key, bucket.name));
      return this.document(exchange, 200, listBucketsDocument(key.accountId, buckets, this.region));
    }
    const bucket = await this.bucketFor(address.bucket, key);
    exchange.bucket = bucket;
    exchange.operation = operation;
    if (operation.writes && key.readOnly) throw accessDenied();
    this.used(key, operation.name, bucket.name);
    // A bucket's notifications are set whatever its room or the account's credit, as other settings are.
    if (operation.name === 'GetBucketNotificationConfiguration') return this.document(exchange, 200, rulesXml(bucket.notifications ?? []));
    if (operation.name === 'PutBucketNotificationConfiguration') return this.putNotifications(exchange, signature, chain, key, bucket, operation, plan);
    // So is its website configuration, which makes it a site.
    if (operation.name === 'GetBucketWebsite') {
      if (!bucket.website) throw noSuchWebsiteConfiguration();
      return this.document(exchange, 200, websiteXml(bucket.website));
    }
    if (operation.name === 'PutBucketWebsite') return this.putWebsite(exchange, signature, chain, key, bucket, operation, plan);
    if (operation.name === 'DeleteBucketWebsite') {
      if (bucket.website) await this.websites.keep(bucket, null, this.changedBy(exchange, key));
      exchange.response.writeHead(204, { 'x-amz-request-id': exchange.id });
      exchange.response.end();
      return 204;
    }
    // Full buckets, or no credit, and uploads wait for room or for credit; reads, and deletes that make room and lower the bill, go on.
    if (operation.writes && operation.class === 'tier1') {
      if (bucketsFull) throw accountProblem(fullBuckets(plan.limits.bucketStorageMb, plan.name));
      await this.admitUpload(key.accountId);
    }
    if (operation.name === 'GetBucketLocation') return this.document(exchange, 200, locationDocument(this.region));
    if (operation.name === 'HeadBucket') {
      exchange.response.writeHead(200, { 'x-amz-request-id': exchange.id, 'x-amz-bucket-region': this.region, 'content-length': 0 });
      exchange.response.end();
      return 200;
    }
    return this.forward(exchange, signature, chain, key, bucket, operation, plan);
  }

  /**
   * The key's account, as every key is checked: active, its storage on, within
   * the plan's requests per second. Answers its plan, and whether its buckets
   * hold all of the plan's storage at their last measure.
   */
  private async admitAccount(accountId: string): Promise<{ plan: PlanView; bucketsFull: boolean }> {
    const account = await this.directory.account(accountId);
    if (!account || account.status !== AccountStatus.ACTIVE) throw accountProblem(`it is ${account?.status ?? 'gone'}`);
    if (account.storageDisabledAt) throw accountProblem(`FF turned its databases, buckets and queues off: ${account.storageDisabledReason}`);
    const plan = await this.plans.get(account.planId);
    if ((await countStorageRequest(this.throttler, account.id, plan.limits.storageRequestsPerSecond)) !== undefined) {
      throw new S3Error(503, 'SlowDown', `Please reduce your request rate: the ${plan.name} plan allows ${plan.limits.storageRequestsPerSecond} requests a second.`);
    }
    return { plan, bucketsFull: account.bucketStorageNotice === 100 };
  }

  private async admitUpload(accountId: string): Promise<void> {
    try {
      await this.credit.admit(accountId);
    } catch (error) {
      if (error instanceof InsufficientCreditException) throw accountProblem('it is out of credit: its files are read and deleted, and uploads wait for credit');
      throw error;
    }
  }

  /** The bucket of that name, if the key reaches it: none answers NoSuchBucket; another account's, or one the key doesn't reach, AccessDenied, as S3 answers. */
  private async bucketFor(name: string, key: ActiveKey): Promise<Bucket> {
    const bucket = name ? await this.directory.bucket(name) : null;
    if (!bucket) throw noSuchBucket();
    if (bucket.accountId !== key.accountId || !reachesBucket(key, bucket.name)) throw accessDenied();
    return bucket;
  }

  /** A copy's source, `[/]<bucket>/<key>`, as the store names it: a bucket the key reaches, as a read of it. */
  private async copySource(value: string, key: ActiveKey): Promise<string> {
    const [source, versioned] = value.split('?');
    if (versioned && /(^|&)versionId=/.test(versioned)) throw notImplemented();
    const path = source.replace(/^\//, '');
    const slash = path.indexOf('/');
    if (slash <= 0 || slash === path.length - 1) throw invalidRequest('The x-amz-copy-source header is not <bucket>/<key>');
    const bucket = await this.bucketFor(decodeEscapes(path.slice(0, slash)), key);
    // A copy reads its source, as IAM's s3:GetObject on it.
    this.used(key, 'GetObject', bucket.name);
    return `/${bucket.storeName}/${path.slice(slash + 1)}`;
  }

  /** What the key used, by S3's name for the operation, noted for the export's roles: a bucket, or '' for the account's. */
  private used(key: ActiveKey, operation: string, bucket: string): void {
    this.keyUses.note({ key, service: AwsEndpoint.S3, resource: bucket, operation });
  }

  /** The request to the store, its body checked on the way, and the store's answer back. */
  private async forward(exchange: Exchange, signature: RequestSignature, chain: SigningChain, key: ActiveKey, bucket: Bucket, operation: S3Operation, plan: PlanView): Promise<number> {
    const { request, response, method } = exchange;
    const headers: Record<string, string> = {};
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const name = request.rawHeaders[i].toLowerCase();
      if (FORWARDED.test(name)) headers[name] = headers[name] === undefined ? request.rawHeaders[i + 1] : `${headers[name]},${request.rawHeaders[i + 1]}`;
    }
    // The body's own encoding, without aws-chunked: the store keeps what the client meant.
    const encodings = (single(request.headers['content-encoding']) ?? '')
      .split(',')
      .map((encoding) => encoding.trim())
      .filter((encoding) => encoding && encoding !== 'aws-chunked');
    if (encodings.length) headers['content-encoding'] = encodings.join(',');
    const copySource = single(request.headers['x-amz-copy-source']);
    if (copySource !== undefined) headers['x-amz-copy-source'] = await this.copySource(copySource, key);
    // An object sent without a type is S3's default, as on S3: a site's server then types it by its name.
    const keepsSourceType = operation.name === 'CopyObject' && headers['x-amz-metadata-directive']?.toUpperCase() !== 'REPLACE';
    if (TYPED_WRITES.has(operation.name) && headers['content-type'] === undefined && !keepsSourceType) headers['content-type'] = S3_DEFAULT_TYPE;

    const body = method === 'PUT' || method === 'POST' ? this.body(exchange, signature, chain, operation, headers, plan) : null;
    // Let in: now the client may send its body.
    if (exchange.expectsContinue) response.writeContinue();
    let whole: Buffer | undefined;
    if (body && DOCUMENT_BODIES.has(operation.name)) {
      whole = await readWhole(body, MAX_DOCUMENT_BYTES);
      headers['content-length'] = String(whole.length);
      headers['content-md5'] = createHash('md5').update(whole).digest('base64');
    }

    const storePath = `/${bucket.storeName}${exchange.address.rawKey ? `/${exchange.address.rawKey}` : ''}`;
    const upstream = this.store.send(method, storePath, queryForStore(exchange.rawQuery), headers);
    const sent: Promise<void> = whole
      ? new Promise<void>((resolve, reject) => upstream.request.end(whole, () => resolve()).once('error', reject))
      : body
        ? pipeline([...body, upstream.request])
        : new Promise<void>((resolve) => upstream.request.end(() => resolve()));
    const [delivered, answered] = await Promise.allSettled([sent, upstream.response]);
    // A body that failed its checks is the client's error, whatever the store made of the cut request.
    if (delivered.status === 'rejected' && delivered.reason instanceof S3Error) throw delivered.reason;
    if (answered.status === 'rejected') {
      throw new Error(`The store did not answer: ${describeError(delivered.status === 'rejected' ? delivered.reason : answered.reason)}`);
    }
    const status = await this.relay(exchange, answered.value, bucket, operation);
    if (status >= 200 && status < 300 && bucket.notifications?.length) {
      // The client has its answer already: the event follows, as S3's do.
      const sending = this.notify(exchange, key, bucket, operation, storePath).finally(() => this.notifying.delete(sending));
      this.notifying.add(sending);
      await sending;
    }
    return status;
  }

  /** PutBucketNotificationConfiguration: its document read whole, the body's checks on the way, and kept as S3 keeps one, under the key. */
  private async putNotifications(exchange: Exchange, signature: RequestSignature, chain: SigningChain, key: ActiveKey, bucket: Bucket, operation: S3Operation, plan: PlanView): Promise<number> {
    const stages = this.body(exchange, signature, chain, operation, {}, plan);
    if (exchange.expectsContinue) exchange.response.writeContinue();
    const document = await readWhole(stages, MAX_DOCUMENT_BYTES);
    await this.notifications.keep(bucket, rulesFromXml(document.toString('utf8')), {
      skipDestinationValidation: single(exchange.request.headers['x-amz-skip-destination-validation'])?.toLowerCase() === 'true',
      changedBy: this.changedBy(exchange, key),
    });
    exchange.response.writeHead(200, { 'x-amz-request-id': exchange.id, 'content-length': 0 });
    exchange.response.end();
    return 200;
  }

  /** PutBucketWebsite: its document read whole, the body's checks on the way, and kept as S3 keeps one, under the key. */
  private async putWebsite(exchange: Exchange, signature: RequestSignature, chain: SigningChain, key: ActiveKey, bucket: Bucket, operation: S3Operation, plan: PlanView): Promise<number> {
    const stages = this.body(exchange, signature, chain, operation, {}, plan);
    if (exchange.expectsContinue) exchange.response.writeContinue();
    const document = await readWhole(stages, MAX_DOCUMENT_BYTES);
    await this.websites.keep(bucket, websiteFromXml(document.toString('utf8'), bucket.website), this.changedBy(exchange, key));
    exchange.response.writeHead(200, { 'x-amz-request-id': exchange.id, 'content-length': 0 });
    exchange.response.end();
    return 200;
  }

  /** Who changed a bucket's settings through the front door: the access key, from the caller's address. */
  private changedBy(exchange: Exchange, key: ActiveKey): ChangedBy {
    return { actor: { id: `access_key:${key.id}`, label: `access key ${key.id}` }, ip: exchange.request.socket.remoteAddress, requestId: exchange.id };
  }

  /**
   * The event S3 sends for a write that ended well, to the destination of the
   * bucket's rule for it, if one names it: a created object's with its size
   * and ETag, as the store has them now. It is sent after the store answered,
   * so a backend that stops between the two loses it.
   */
  private async notify(exchange: Exchange, key: ActiveKey, bucket: Bucket, operation: S3Operation, storePath: string): Promise<void> {
    const created = CREATED_EVENTS[operation.name];
    const removed = operation.name === 'DeleteObject' || operation.name === 'DeleteObjects';
    if (!created && !removed) return;
    const eventName = created ?? 'ObjectRemoved:Delete';
    const keys = operation.name === 'DeleteObjects' ? (exchange.deletedKeys ?? []) : [decodeEscapes(exchange.address.rawKey)];
    for (const objectKey of keys) {
      const rule = ruleFor(bucket.notifications ?? [], eventName, objectKey);
      if (!rule) continue;
      try {
        const object = created ? { key: objectKey, ...(await this.measure(storePath)) } : { key: objectKey };
        const record = s3EventRecord({
          region: this.region,
          eventName,
          time: new Date(),
          principalId: key.id,
          sourceIp: exchange.request.socket.remoteAddress ?? '',
          requestId: exchange.id,
          bucket: { name: bucket.name, accountId: bucket.accountId },
          object,
          configurationId: rule.id,
          sequencer: nextSequencer(),
        });
        await this.bucketEvents.publish({ kind: 'record', accountId: bucket.accountId, bucket: bucket.name, rule, record });
      } catch (error) {
        this.logger.error(`The event ${eventName} of ${bucket.name}/${objectKey} was not sent: ${describeError(error)}`);
      }
    }
  }

  /** A created object's size and ETag, without its quotes, as the store has them now; nothing it can't say. */
  private async measure(storePath: string): Promise<{ size?: number; eTag?: string }> {
    const head = this.store.send('HEAD', storePath, '', {});
    head.request.end();
    const answer = await head.response;
    answer.resume();
    if (answer.statusCode !== 200) return {};
    const size = Number(single(answer.headers['content-length']));
    const eTag = single(answer.headers.etag)?.replace(/"/g, '');
    return { ...(Number.isSafeInteger(size) ? { size } : {}), ...(eTag ? { eTag } : {}) };
  }

  /**
   * The body's checks, in order, from the request: aws-chunked's reader, or a
   * plain body's SHA-256 and checksum. A presigned URL signs no body, and its
   * checksum parameters are signed, then ignored, as S3 does.
   */
  private body(exchange: Exchange, signature: RequestSignature, chain: SigningChain, operation: S3Operation, headers: Record<string, string>, plan: PlanView): Stage[] {
    const { request } = exchange;
    // The bytes uploaded are the body's own, as CloudWatch counts them: after aws-chunked's framing.
    const counted = counter((bytes) => (exchange.bytesIn += bytes));
    const stages: Stage[] = [request];
    const payload = signature.payload;
    if (isStreaming(payload)) {
      if (![STREAMING_SIGNED, STREAMING_SIGNED_TRAILER, STREAMING_UNSIGNED_TRAILER].includes(payload)) throw notImplemented();
      const decodedLength = Number(single(request.headers['x-amz-decoded-content-length']));
      if (!Number.isSafeInteger(decodedLength) || decodedLength < 0) throw new S3Error(411, 'MissingContentLength', 'You must provide the x-amz-decoded-content-length HTTP header.');
      this.limit(operation, decodedLength, plan);
      headers['content-length'] = String(decodedLength);
      const { checksum, trailerName } = expectedChecksum(request);
      stages.push(
        new ChunkedBodyReader({
          signed: payload !== STREAMING_UNSIGNED_TRAILER,
          trailer: payload.endsWith('-TRAILER'),
          chain,
          decodedLength,
          checksum,
          trailerName,
        }),
        counted,
      );
      return stages;
    }
    const length = Number(single(request.headers['content-length']));
    if (request.headers['content-length'] === undefined || !Number.isSafeInteger(length)) {
      throw new S3Error(411, 'MissingContentLength', 'You must provide the Content-Length HTTP header.');
    }
    this.limit(operation, length, plan);
    headers['content-length'] = String(length);
    if (signature.kind === 'presigned') return [...stages, counted];
    const { checksum } = expectedChecksum(request);
    const sha256 = payload === UNSIGNED_PAYLOAD ? undefined : payload;
    if (sha256 !== undefined && !/^[0-9a-f]{64}$/.test(sha256)) throw invalidRequest('x-amz-content-sha256 must be UNSIGNED-PAYLOAD, a STREAMING- payload, or a SHA-256 in hexadecimal');
    if (sha256 || checksum) stages.push(new PlainBodyChecker({ sha256, checksum }));
    return [...stages, counted];
  }

  private limit(operation: S3Operation, bytes: number, plan: PlanView): void {
    if (UPLOADS.has(operation.name) && bytes > MAX_UPLOAD_BYTES) throw new S3Error(400, 'EntityTooLarge', 'Your proposed upload exceeds the maximum allowed size');
    if (operation.name === 'PutObject' && bytes > plan.limits.maxObjectMb * MB) {
      throw new S3Error(400, 'EntityTooLarge', `Your proposed upload exceeds the maximum allowed size: the ${plan.name} plan takes ${plan.limits.maxObjectMb} MB in one PutObject; a multipart upload sends more`);
    }
  }

  /** The store's answer to the client, as it comes: an XML one naming the customer's bucket rather than the store's. */
  private async relay(exchange: Exchange, answer: IncomingMessage, bucket: Bucket, operation: S3Operation): Promise<number> {
    const { response, method } = exchange;
    const status = answer.statusCode ?? 502;
    const headers: Record<string, string | string[]> = { 'x-amz-request-id': exchange.id };
    for (const [name, value] of Object.entries(answer.headers)) if (value !== undefined && ANSWERED.test(name)) headers[name] = value;
    const xml = /xml/i.test(single(answer.headers['content-type']) ?? '');
    if (method === 'HEAD') {
      response.writeHead(status, headers);
      response.end();
      answer.resume();
      return status;
    }
    if (xml && operation.name === 'DeleteObjects' && bucket.notifications?.length) {
      // Read whole, for the keys it deleted, which the bucket's notifications name.
      const document = (await readWhole([answer], MAX_DOCUMENT_BYTES)).toString('utf8').split(bucket.storeName).join(bucket.name);
      exchange.deletedKeys = deletedKeysOf(document);
      headers['content-length'] = String(Buffer.byteLength(document));
      response.writeHead(status, headers);
      response.end(document);
      exchange.bytesOut = Buffer.byteLength(document);
      return status;
    }
    if (xml && operation.name === 'CompleteMultipartUpload') {
      // Small, and naming the object's address: read whole, the address made the customer's.
      const document = (await readWhole([answer], MAX_DOCUMENT_BYTES))
        .toString('utf8')
        .split(bucket.storeName)
        .join(bucket.name)
        .replace(/<Location>[^<]*<\/Location>/, `<Location>${this.objectUrl(exchange, bucket)}</Location>`);
      headers['content-length'] = String(Buffer.byteLength(document));
      response.writeHead(status, headers);
      response.end(document);
      exchange.bytesOut = Buffer.byteLength(document);
      return status;
    }
    if (xml) delete headers['content-length'];
    response.writeHead(status, headers);
    const stages: Stage[] = [answer];
    if (xml) stages.push(replacing(bucket.storeName, bucket.name));
    stages.push(counter((bytes) => (exchange.bytesOut += bytes)), response);
    await pipeline(stages);
    return status;
  }

  /** An object's address as the client reached it: its own host, virtual-hosted or path-style. */
  private objectUrl({ request, address }: Exchange, bucket: Bucket): string {
    const host = single(request.headers.host) ?? this.host;
    return address.style === 'virtual-hosted' ? `${this.protocol}//${host}/${address.rawKey}` : `${this.protocol}//${host}/${bucket.name}/${address.rawKey}`;
  }

  /** A small XML document of the front door's own. */
  private document({ id, response, method }: Exchange, status: number, document: string): number {
    response.writeHead(status, { 'content-type': 'application/xml', 'content-length': Buffer.byteLength(document), 'x-amz-request-id': id });
    response.end(method === 'HEAD' ? undefined : document);
    return status;
  }

  /**
   * Whether the edge may get a certificate on demand for a host: the front
   * door's own, and a bucket's under it, virtual-hosted; no other, so that
   * nobody makes the edge ask a certificate authority for names of their
   * choosing. The edge asks the function URL gateway, which asks here.
   */
  async allowsCertificate(domain: string): Promise<boolean> {
    const host = domain.toLowerCase();
    const suffix = `.${this.host}`;
    if (host === this.host) return true;
    const bucketName = host.endsWith(suffix) ? host.slice(0, -suffix.length) : '';
    return bucketName !== '' && !bucketName.includes('.') && (await this.directory.bucket(bucketName)) !== null;
  }
}

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
import { PlanView } from '../plans/plan-limits';
import { PlansService } from '../plans/plans.service';
import { countStorageRequest } from '../plans/rate-limits';
import { ChunkedBodyReader, ExpectedChecksum, PlainBodyChecker, STREAMING_SIGNED, STREAMING_SIGNED_TRAILER, STREAMING_UNSIGNED_TRAILER, isStreaming } from './aws-chunked';
import { Bucket } from './bucket.entity';
import { CHECKSUM_ALGORITHMS, isChecksumAlgorithm } from './checksums';
import { fullBuckets } from './bucket-storage';
import { S3Error, accessDenied, accountProblem, errorDocument, internalError, invalidAccessKeyId, invalidRequest, noSuchBucket, notImplemented } from './s3-error';
import { S3Address, S3Operation, addressOf, operationOf } from './s3-requests';
import { RequestSignature, SigningChain, UNSIGNED_PAYLOAD, checkSignature, decodeEscapes, readSignature } from './sigv4';
import { StoreClient } from './store-client';
import { ActiveKey, StorageDirectory } from './storage-directory.service';
import { StorageRequestCountsService } from './storage-request-counts.service';
import { listBucketsDocument, locationDocument, replacing } from './xml';

/** S3's limit on an object sent in one PUT, and on a part of a multipart upload: 5 GiB. */
export const MAX_UPLOAD_BYTES = 5 * 1024 ** 3;

const MB = 1024 * 1024;

/** The XML bodies read whole before they go to the store: a batch of deletes, a multipart upload's completion. */
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

/** The request's headers the store gets: the object's own, and the conditions. Never the client's signature, nor its checksums, which the front door checks. */
const FORWARDED =
  /^(content-type|content-md5|content-language|content-disposition|cache-control|expires|range|if-match|if-none-match|if-modified-since|if-unmodified-since|x-amz-meta-[!-~]+|x-amz-copy-source-range|x-amz-copy-source-if-(match|none-match|modified-since|unmodified-since)|x-amz-metadata-directive)$/;

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

  /** Stops taking requests, and waits for those under way. */
  async onModuleDestroy(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    this.store.close();
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
      const buckets = (await this.directory.bucketsOf(key.accountId)).filter((bucket) => !key.buckets || key.buckets.includes(bucket.name));
      return this.document(exchange, 200, listBucketsDocument(key.accountId, buckets, this.region));
    }
    const bucket = await this.bucketFor(address.bucket, key);
    exchange.bucket = bucket;
    exchange.operation = operation;
    if (operation.writes && key.readOnly) throw accessDenied();
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
    if (account.storageDisabledAt) throw accountProblem(`FF turned its databases and buckets off: ${account.storageDisabledReason}`);
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

  /** The bucket of that name, if the key reaches it: none answers NoSuchBucket; another account's, or one the key doesn't name, AccessDenied, as S3 answers. */
  private async bucketFor(name: string, key: ActiveKey): Promise<Bucket> {
    const bucket = name ? await this.directory.bucket(name) : null;
    if (!bucket) throw noSuchBucket();
    if (bucket.accountId !== key.accountId || (key.buckets && !key.buckets.includes(bucket.name))) throw accessDenied();
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
    return `/${bucket.storeName}/${path.slice(slash + 1)}`;
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
    return this.relay(exchange, answered.value, bucket, operation);
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

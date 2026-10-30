import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AccountStatus } from '../accounts/entities/account.entity';
import { describeError } from '../common/describe-error';
import { PlansService } from '../plans/plans.service';
import { Bucket } from './bucket.entity';
import { servedContentType } from './content-types';
import { uriEncode } from './sigv4';
import { SiteTransfer } from './site-transfer.service';
import { StorageDirectory } from './storage-directory.service';
import { StorageRequestCountsService } from './storage-request-counts.service';
import { StoreClient } from './store-client';
import { escapeXml } from './xml';

const GB = 1024 ** 3;

/** The browser's headers the store gets: the conditions and the range, which it answers as S3 does. */
const PASSED = ['if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since', 'range'] as const;

/** The store's answer headers a browser gets: the object's own, its validators and its range. */
const ANSWERED = /^(content-length|content-range|content-encoding|content-language|content-disposition|cache-control|expires|etag|last-modified|accept-ranges)$/;

const single = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/** A site's answer of its own, as S3's website endpoint writes its errors: a small HTML page naming the code. */
class SiteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly key?: string,
  ) {
    super(message);
  }
}

const TITLES: Record<number, string> = { 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 500: 'Internal Server Error', 502: 'Bad Gateway' };

/** The HTML page of a site's error, as S3's website endpoint writes one. */
export function errorPage(error: SiteError, requestId: string): string {
  const title = `${error.status} ${TITLES[error.status] ?? 'Error'}`;
  const items = [`Code: ${error.code}`, `Message: ${error.message}`, ...(error.key === undefined ? [] : [`Key: ${error.key}`]), `RequestId: ${requestId}`];
  return `<html>\n<head><title>${title}</title></head>\n<body>\n<h1>${title}</h1>\n<ul>\n${items.map((item) => `<li>${escapeXml(item)}</li>`).join('\n')}\n</ul>\n<hr/>\n</body>\n</html>\n`;
}

/**
 * The key a site's path names, as S3's website endpoint reads one: its escapes
 * decoded, a folder's path (one ending in "/") its index document. A path that
 * climbs out of the site ("." or ".." as a segment) or names a control
 * character is refused: no browser sends one, and the store must never be
 * asked for a key outside the bucket.
 */
export function keyOf(rawPath: string, indexDocument: string): string {
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    throw new SiteError(400, 'InvalidURI', "Couldn't parse the specified URI.");
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..') || [...path].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) {
    throw new SiteError(400, 'InvalidURI', "Couldn't parse the specified URI.");
  }
  return `${path.replace(/^\//, '')}${path.endsWith('/') ? indexDocument : ''}`;
}

/** One request to a site and its answer, as the server learns of them. */
interface Visit {
  id: string;
  request: IncomingMessage;
  response: ServerResponse;
  method: string;
  rawPath: string;
  rawQuery: string;
  bucket?: Bucket;
  bytesOut: number;
}

/**
 * Buckets' sites: a server of its own, on FF_WEBSITE_PORT, behind the edge,
 * which answers a bucket's files to browsers as S3's website endpoint does, at
 * `<bucket>.<the sites' host>` or at a customer's own domain the function URL
 * gateway hands over. A bucket is a site once its website configuration is set;
 * nothing is signed, and GET and HEAD alone are answered. A folder's path
 * answers its index document, and a folder named without its slash is
 * redirected to it; a path with no file answers the error document with 404,
 * or, for a single-page app, the index document with 200. The store answers
 * the browser's conditions and ranges itself, its ETag and Last-Modified
 * passed on; a file uploaded without a type gets one by its name; no answer
 * may be sniffed. Each request counts in its bucket's minute, as a GET of S3's
 * second class, in a class of its own, so that the plan's monthly limit on
 * what sites send out reads them: past it, the account's sites answer 403
 * until the month's end. A suspended account's sites, and those whose
 * storage FF turned off, answer 403; without credit they still answer, as
 * reads do.
 */
@Injectable()
export class WebsiteServer implements OnModuleDestroy {
  private readonly logger = new Logger(WebsiteServer.name);
  /** The host sites live under: each at <bucket>.<host>. */
  private readonly host: string;
  private readonly store: StoreClient;
  private server?: Server;

  constructor(
    config: ConfigService,
    private readonly directory: StorageDirectory,
    private readonly counts: StorageRequestCountsService,
    private readonly plans: PlansService,
    private readonly transfer: SiteTransfer,
  ) {
    this.host = new URL(config.getOrThrow<string>('website.base')).hostname;
    const objectStore = config.getOrThrow<{ endPoint: string; port: number; useSSL: boolean; accessKey: string; secretKey: string }>('objectStore');
    this.store = new StoreClient({
      endpoint: `${objectStore.useSSL ? 'https' : 'http'}://${objectStore.endPoint}:${objectStore.port}`,
      accessKeyId: objectStore.accessKey,
      secretAccessKey: objectStore.secretKey,
    });
  }

  /** Starts answering on the port; main.ts calls it once the API listens. Port 0 takes any free one, as the tests do. */
  async listen(port: number, host?: string): Promise<AddressInfo> {
    const server = createServer((request, response) => void this.serve(request, response));
    // A visitor's connection idle for 2 minutes goes; a large file may take longer to send than Node.js's default.
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

  /**
   * Answers one request to a site; never throws, as nothing would catch it.
   * The bucket is the host's, under the sites' host, unless the caller names
   * it: a customer's own domain, which the function URL gateway proved.
   */
  async serve(request: IncomingMessage, response: ServerResponse, bucketName?: string): Promise<void> {
    const target = request.url?.startsWith('/') ? request.url : '/';
    const at = target.indexOf('?');
    const visit: Visit = {
      id: randomBytes(8).toString('hex').toUpperCase(),
      request,
      response,
      method: request.method ?? 'GET',
      rawPath: at < 0 ? target : target.slice(0, at),
      rawQuery: at < 0 ? '' : target.slice(at + 1),
      bytesOut: 0,
    };
    const started = new Date();
    let status = 500;
    try {
      status = await this.answer(visit, bucketName ?? this.bucketNameOf(single(request.headers.host)));
    } catch (error) {
      const refusal = error instanceof SiteError ? error : new SiteError(500, 'InternalError', 'We encountered an internal error. Please try again.');
      if (!(error instanceof SiteError)) this.logger.error(`A site's request failed (request ${visit.id}): ${describeError(error)}`, error instanceof Error ? error.stack : undefined);
      status = refusal.status;
      this.refuse(visit, refusal);
    } finally {
      if (visit.bucket) {
        this.transfer.add(visit.bucket.accountId, visit.bytesOut);
        this.counts.count({
          bucketId: visit.bucket.id,
          accountId: visit.bucket.accountId,
          bucketName: visit.bucket.name,
          class: 'website',
          method: visit.method,
          status,
          bytesIn: 0,
          bytesOut: visit.bytesOut,
          at: started,
        });
      }
    }
  }

  /**
   * Whether the edge may get a certificate on demand for a host: a site's,
   * under the sites' host, its bucket one with a website configuration; no
   * other, so that nobody makes the edge ask a certificate authority for names
   * of their choosing. The edge asks the function URL gateway, which asks here.
   */
  async allowsCertificate(domain: string): Promise<boolean> {
    const name = this.bucketNameOf(domain);
    return name !== '' && Boolean((await this.directory.bucket(name))?.website);
  }

  /** The bucket a host names: the label before the sites' host; '' for any other host. */
  private bucketNameOf(host: string | undefined): string {
    const name = (host ?? '').replace(/:\d+$/, '').replace(/\.$/, '').toLowerCase();
    const suffix = `.${this.host}`;
    const bucket = name.endsWith(suffix) ? name.slice(0, -suffix.length) : '';
    return bucket.includes('.') ? '' : bucket;
  }

  /** The error's page, unless the answer has begun, when the connection is cut instead. */
  private refuse({ id, response, method }: Visit, error: SiteError): void {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const body = method === 'HEAD' ? '' : errorPage(error, id);
    const headers: Record<string, string | number> = {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'x-content-type-options': 'nosniff',
      'x-amz-request-id': id,
    };
    if (error.status === 405) headers.allow = 'GET, HEAD';
    response.writeHead(error.status, headers);
    response.end(body);
  }

  /** The answer, sent; its status. */
  private async answer(visit: Visit, bucketName: string): Promise<number> {
    if (visit.method !== 'GET' && visit.method !== 'HEAD') throw new SiteError(405, 'MethodNotAllowed', `The specified method is not allowed against this resource: a site answers GET and HEAD`);
    const bucket = bucketName ? await this.directory.bucket(bucketName) : null;
    if (!bucket) throw new SiteError(404, 'NoSuchBucket', 'The specified bucket does not exist');
    if (!bucket.website) throw new SiteError(404, 'NoSuchWebsiteConfiguration', 'The specified bucket does not have a website configuration');
    visit.bucket = bucket;
    await this.admit(bucket);
    const website = bucket.website;
    const key = keyOf(visit.rawPath, website.indexDocument);
    const found = await this.fromStore(visit.method, bucket, key, visit.request);
    if (found.statusCode !== 404) return this.relay(visit, found, key);
    found.resume();
    // A folder named without its slash, as S3's website endpoint answers it: redirected to the folder, when it has an index document.
    if (!visit.rawPath.endsWith('/')) {
      const folder = await this.fromStore('HEAD', bucket, `${key}/${website.indexDocument}`);
      folder.resume();
      if (folder.statusCode === 200) {
        const location = `${visit.rawPath}/${visit.rawQuery ? `?${visit.rawQuery}` : ''}`;
        visit.response.writeHead(302, { location, 'content-length': 0, 'x-amz-request-id': visit.id });
        visit.response.end();
        return 302;
      }
    }
    if (website.singlePageApp) {
      const index = await this.fromStore(visit.method, bucket, website.indexDocument, visit.request);
      if (index.statusCode !== 404) return this.relay(visit, index, website.indexDocument);
      index.resume();
    } else if (website.errorDocument !== null) {
      const page = await this.fromStore(visit.method, bucket, website.errorDocument);
      if (page.statusCode === 200) return this.relay(visit, page, website.errorDocument, 404);
      page.resume();
    }
    throw new SiteError(404, 'NoSuchKey', 'The specified key does not exist.', key);
  }

  /** The site's account, as every visit checks it: active, its storage on, within the plan's monthly transfer. */
  private async admit(bucket: Bucket): Promise<void> {
    const account = await this.directory.account(bucket.accountId);
    if (!account || account.status !== AccountStatus.ACTIVE) throw new SiteError(403, 'AccessDenied', 'Access Denied');
    if (account.storageDisabledAt) throw new SiteError(403, 'AccessDenied', 'Access Denied');
    const plan = await this.plans.get(account.planId);
    if ((await this.transfer.sentThisMonth(account.id)) >= BigInt(plan.limits.siteTransferGbPerMonth) * BigInt(GB)) {
      throw new SiteError(403, 'AccessDenied', `The site's account has sent the ${plan.name} plan's ${plan.limits.siteTransferGbPerMonth} GB from its sites this month: they answer again next month`);
    }
  }

  /** The store's answer for one of the bucket's objects: the browser's conditions and range passed on, when given. */
  private async fromStore(method: string, bucket: Bucket, key: string, browser?: IncomingMessage): Promise<IncomingMessage> {
    const headers: Record<string, string> = {};
    for (const name of PASSED) {
      const value = single(browser?.headers[name]);
      if (value !== undefined) headers[name] = value;
    }
    const sent = this.store.send(method, `/${bucket.storeName}/${uriEncode(key, true)}`, '', headers);
    sent.request.end();
    return sent.response;
  }

  /** The store's answer to the browser, as it comes, with the status given or its own; a store's error is the site's 502. */
  private async relay(visit: Visit, answer: IncomingMessage, key: string, status = answer.statusCode ?? 502): Promise<number> {
    const { response, method } = visit;
    const own = answer.statusCode ?? 502;
    if (own !== 200 && own !== 206 && own !== 304 && own !== 412 && own !== 416) {
      answer.resume();
      this.logger.warn(`The store answered ${own} for a site's file (request ${visit.id})`);
      throw new SiteError(502, 'BadGateway', "The site's file couldn't be read: try again in a moment");
    }
    const headers: Record<string, string | string[]> = { 'x-content-type-options': 'nosniff', 'x-amz-request-id': visit.id };
    for (const [name, value] of Object.entries(answer.headers)) if (value !== undefined && ANSWERED.test(name)) headers[name] = value;
    if (own === 200 || own === 206) headers['content-type'] = servedContentType(single(answer.headers['content-type']), key);
    response.writeHead(status, headers);
    if (method === 'HEAD' || own === 304 || own === 412 || own === 416) {
      answer.resume();
      response.end();
      return status;
    }
    const counted = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        visit.bytesOut += chunk.length;
        done(null, chunk);
      },
    });
    await pipeline(answer, counted, response);
    return status;
  }
}

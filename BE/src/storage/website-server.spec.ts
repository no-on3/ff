import { ConfigService } from '@nestjs/config';
import { IncomingMessage, Server, ServerResponse, createServer, request as httpRequest } from 'node:http';
import { AddressInfo } from 'node:net';
import { AccountStatus } from '../accounts/entities/account.entity';
import { PlanView } from '../plans/plan-limits';
import { PlansService } from '../plans/plans.service';
import { plan } from '../plans/test-fixtures';
import { Bucket, BucketStatus } from './bucket.entity';
import { CountedRequest } from './request-tally';
import { SiteTransfer } from './site-transfer.service';
import { StorageDirectory } from './storage-directory.service';
import { StorageRequestCountsService } from './storage-request-counts.service';
import { WebsiteConfiguration } from './website';
import { WebsiteServer, keyOf } from './website-server';

const ACCOUNT = '000000000001';
const STORE_NAME = 'ff-000000000000000000000001';

/** The objects in the store, under the bucket's store name: each with its type, as uploaded. */
const OBJECTS: Record<string, { body: string; type?: string }> = {
  'index.html': { body: '<title>index</title>', type: 'text/html' },
  'docs/index.html': { body: '<title>docs</title>', type: 'text/html' },
  '404.html': { body: '<title>error page</title>', type: 'text/html' },
  'assets/app.js': { body: 'console.log("app")', type: 'text/javascript' },
  'untyped.css': { body: 'body { color: navy }', type: 'binary/octet-stream' },
  'a b/c.txt': { body: 'spaced', type: 'text/plain' },
};

/** A store as SeaweedFS answers: GET and HEAD of an object, its ETag, If-None-Match and a byte range; what it was asked, kept. */
function fakeStore(asked: string[]): Server {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = decodeURIComponent((request.url ?? '').split('?')[0]);
    asked.push(`${request.method} ${path}`);
    const object = path.startsWith(`/${STORE_NAME}/`) ? OBJECTS[path.slice(STORE_NAME.length + 2)] : undefined;
    if (!object) {
      response.writeHead(404, { 'content-type': 'application/xml' }).end(request.method === 'HEAD' ? undefined : '<Error><Code>NoSuchKey</Code></Error>');
      return;
    }
    const etag = `"${Buffer.from(object.body).toString('hex').slice(0, 16)}"`;
    const common = { etag, 'last-modified': 'Thu, 29 Oct 2026 08:00:00 GMT', 'accept-ranges': 'bytes', 'cache-control': 'no-cache', ...(object.type ? { 'content-type': object.type } : {}) };
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304, { etag }).end();
      return;
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
    const body = range ? Buffer.from(object.body).subarray(Number(range[1]), Number(range[2]) + 1) : Buffer.from(object.body);
    const headers = { ...common, 'content-length': body.length, ...(range ? { 'content-range': `bytes ${range[1]}-${range[2]}/${object.body.length}` } : {}) };
    response.writeHead(range ? 206 : 200, headers).end(request.method === 'HEAD' ? undefined : body);
  });
}

const listening = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return (server.address() as AddressInfo).port;
};

describe("a bucket's site, as S3's website endpoint answers it", () => {
  let store: Server;
  let server: WebsiteServer;
  let port: number;
  const asked: string[] = [];
  const counted: CountedRequest[] = [];
  const sent: Array<[string, number]> = [];
  let site: Bucket;
  const buckets = new Map<string, Bucket>();
  const account = { id: ACCOUNT, status: AccountStatus.ACTIVE, planId: 'beta', storageDisabledAt: null as Date | null, storageDisabledReason: null as string | null };
  let currentPlan: PlanView = plan();
  let sentThisMonth = 0n;
  const directory = {
    bucket: async (name: string) => buckets.get(name) ?? null,
    account: async () => account,
  } as unknown as StorageDirectory;
  const counts = { count: (request: CountedRequest) => counted.push(request) } as unknown as StorageRequestCountsService;
  const plans = { get: async () => currentPlan } as unknown as PlansService;
  const transfer = { sentThisMonth: async () => sentThisMonth, add: (accountId: string, bytes: number) => sent.push([accountId, bytes]) } as unknown as SiteTransfer;

  /** A request to the server: its status, headers and body. */
  const visit = (path: string, options: { host?: string; method?: string; headers?: Record<string, string> } = {}) =>
    new Promise<{ status: number; headers: IncomingMessage['headers']; body: string }>((resolve, reject) => {
      const request = httpRequest(
        { hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { host: options.host ?? 'shop.site.example.test:3004', ...options.headers } },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      request.on('error', reject);
      request.end();
    });
  const configure = (website: WebsiteConfiguration | null) => (site.website = website);

  beforeAll(async () => {
    store = fakeStore(asked);
    const storePort = await listening(store);
    const config = new ConfigService({
      website: { base: 'http://site.example.test:3004' },
      objectStore: { endPoint: '127.0.0.1', port: storePort, useSSL: false, accessKey: 'storekey', secretKey: 'store-secret' },
    });
    server = new WebsiteServer(config, directory, counts, plans, transfer);
    port = (await server.listen(0, '127.0.0.1')).port;
  });

  afterAll(async () => {
    await server.onModuleDestroy();
    await new Promise<void>((resolve) => store.close(() => resolve()));
  });

  beforeEach(() => {
    site = Object.assign(new Bucket(), { id: 'id-shop', accountId: ACCOUNT, name: 'shop', storeName: STORE_NAME, status: BucketStatus.ACTIVE, notifications: null });
    configure({ indexDocument: 'index.html', errorDocument: '404.html', singlePageApp: false });
    buckets.clear();
    buckets.set('shop', site);
    buckets.set('private', Object.assign(new Bucket(), { ...site, id: 'id-private', name: 'private', website: null }));
    Object.assign(account, { status: AccountStatus.ACTIVE, storageDisabledAt: null });
    currentPlan = plan();
    sentThisMonth = 0n;
    asked.length = 0;
    counted.length = 0;
    sent.length = 0;
  });

  it("answers the index document at the site's root, its type as stored, never to be sniffed, counted as the site's with what it sent", async () => {
    const answer = await visit('/');

    expect([answer.status, answer.body, answer.headers['content-type']]).toEqual([200, '<title>index</title>', 'text/html']);
    expect(answer.headers['x-content-type-options']).toBe('nosniff');
    expect([answer.headers.etag, answer.headers['last-modified'], answer.headers['cache-control']]).toEqual(['"3c7469746c653e69"', 'Thu, 29 Oct 2026 08:00:00 GMT', 'no-cache']);
    expect(answer.headers['set-cookie']).toBeUndefined();
    expect(asked).toEqual([`GET /${STORE_NAME}/index.html`]);
    expect(counted.map((request) => [request.bucketName, request.class, request.method, request.status, request.bytesOut])).toEqual([['shop', 'website', 'GET', 200, 20]]);
    expect(sent).toEqual([[ACCOUNT, 20]]);
  });

  it("answers a folder's index document, and redirects a folder named without its slash to it, its query kept, as S3 does", async () => {
    expect((await visit('/docs/')).body).toBe('<title>docs</title>');

    const redirect = await visit('/docs?from=nav');
    expect([redirect.status, redirect.headers.location]).toEqual([302, '/docs/?from=nav']);
    expect(asked.slice(-2)).toEqual([`GET /${STORE_NAME}/docs`, `HEAD /${STORE_NAME}/docs/index.html`]);
  });

  it('reads escapes in the path, as a browser sends a name with a space', async () => {
    expect((await visit('/a%20b/c.txt')).body).toBe('spaced');
  });

  it('answers a path with no file with the error document and 404; without one, a page of its own naming the key', async () => {
    const missing = await visit('/no/such/page.html');
    expect([missing.status, missing.body]).toEqual([404, '<title>error page</title>']);

    configure({ indexDocument: 'index.html', errorDocument: null, singlePageApp: false });
    const own = await visit('/no/such/page.html');
    expect(own.status).toBe(404);
    expect(own.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(own.body).toContain('<li>Code: NoSuchKey</li>');
    expect(own.body).toContain('<li>Key: no/such/page.html</li>');
  });

  it("answers a single-page app's routes with its index document and 200, and the files it has as they are", async () => {
    configure({ indexDocument: 'index.html', errorDocument: '404.html', singlePageApp: true });

    const route = await visit('/orders/42');
    expect([route.status, route.body]).toEqual([200, '<title>index</title>']);
    expect((await visit('/assets/app.js')).body).toBe('console.log("app")');
  });

  it("gives a file stored without a type one by its name, and passes the browser's conditions and ranges to the store", async () => {
    expect((await visit('/untyped.css')).headers['content-type']).toBe('text/css; charset=utf-8');

    const first = await visit('/assets/app.js');
    const again = await visit('/assets/app.js', { headers: { 'if-none-match': first.headers.etag as string } });
    expect([again.status, again.body, again.headers['content-type'], again.headers.etag]).toEqual([304, '', undefined, first.headers.etag]);

    const part = await visit('/assets/app.js', { headers: { range: 'bytes=0-6' } });
    expect([part.status, part.body, part.headers['content-range']]).toEqual([206, 'console', 'bytes 0-6/18']);
  });

  it('answers HEAD without a body, and every other method 405, naming the two it takes', async () => {
    const head = await visit('/assets/app.js', { method: 'HEAD' });
    expect([head.status, head.headers['content-length'], head.body]).toEqual([200, '18', '']);

    const post = await visit('/', { method: 'POST' });
    expect([post.status, post.headers.allow]).toEqual([405, 'GET, HEAD']);
    expect(post.body).toContain('Code: MethodNotAllowed');
  });

  it('refuses a path that climbs out of the site, however it is escaped, without asking the store', async () => {
    for (const path of ['/../private/index.html', '/%2e%2e/private/index.html', '/docs/%2E%2E/%2E%2E/x', '/./index.html', '/a%00b', '/%zz']) {
      const answer = await visit(path);
      expect([path, answer.status, answer.body.includes('Code: InvalidURI')]).toEqual([path, 400, true]);
    }
    expect(asked).toEqual([]);
    expect(keyOf('/a/b/', 'index.html')).toBe('a/b/index.html');
    expect(keyOf('/a..b/c', 'index.html')).toBe('a..b/c');
  });

  it("answers S3's errors for a host that is no site: no such bucket, or a bucket without a website configuration", async () => {
    expect((await visit('/', { host: 'nowhere.site.example.test' })).body).toContain('Code: NoSuchBucket');
    expect((await visit('/', { host: 'private.site.example.test' })).body).toContain('Code: NoSuchWebsiteConfiguration');
    expect((await visit('/', { host: 'a.shop.site.example.test' })).body).toContain('Code: NoSuchBucket');
    expect((await visit('/', { host: 'example.test' })).status).toBe(404);
    expect(asked).toEqual([]);
  });

  it("answers a customer's own domain for the bucket the gateway names, whatever its host", async () => {
    const answer = await new Promise<number>((resolve, reject) => {
      const local = createServer((request, response) => void server.serve(request, response, 'shop'));
      local.listen(0, '127.0.0.1', () => {
        const request = httpRequest({ hostname: '127.0.0.1', port: (local.address() as AddressInfo).port, path: '/docs/', headers: { host: 'www.boutique.tn' } }, (response) => {
          response.resume();
          response.on('end', () => local.close(() => resolve(response.statusCode ?? 0)));
        });
        request.on('error', reject);
        request.end();
      });
    });
    expect(answer).toBe(200);
  });

  it("answers 403 for a suspended account's sites, those FF turned off, and past the plan's monthly transfer, saying which", async () => {
    account.status = AccountStatus.SUSPENDED;
    expect((await visit('/')).status).toBe(403);

    Object.assign(account, { status: AccountStatus.ACTIVE, storageDisabledAt: new Date() });
    expect((await visit('/')).status).toBe(403);

    account.storageDisabledAt = null;
    currentPlan = plan({ siteTransferGbPerMonth: 2 });
    sentThisMonth = 2n * 1024n ** 3n;
    const over = await visit('/');
    expect(over.status).toBe(403);
    expect(over.body).toContain("sent the Beta plan&#39;s 2 GB from its sites this month");
    expect(asked).toEqual([]);

    sentThisMonth -= 1n;
    expect((await visit('/')).status).toBe(200);
  });

  it("lets the edge get certificates for sites' hosts alone: a bucket with a website configuration, under the sites' host", async () => {
    const asked = ['shop.site.example.test', 'Shop.Site.Example.Test', 'private.site.example.test', 'nowhere.site.example.test', 'site.example.test', 'shop.example.test'];

    expect(await Promise.all(asked.map((domain) => server.allowsCertificate(domain)))).toEqual([true, true, false, false, false, false]);
  });
});

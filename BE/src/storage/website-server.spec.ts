/**
 * The site server's tests. The objects, the visits and their answers, as
 * S3's website endpoint gives them, are website-examples.json's, which ff
 * local's sites read too; what only FF has, the counts, the plan's limit, the
 * account's state, a customer's domain and the certificates, stays here.
 */
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { IncomingMessage, Server, ServerResponse, createServer, request as httpRequest } from 'node:http';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';
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
/** The sites' host, which a visit's {sites} names. */
const SITES = 'site.example.test';

/** A visit of the table's, and what its answer has. */
interface SiteVisit {
  name: string;
  host?: string;
  method?: string;
  path: string;
  request?: Record<string, string>;
  revisit?: boolean;
  website?: Partial<WebsiteConfiguration>;
  status: number;
  body?: string;
  includes?: string[];
  headers?: Record<string, string>;
  present?: string[];
  absent?: string[];
  asked?: string[];
}

const table = JSON.parse(readFileSync(join(__dirname, 'website-examples.json'), 'utf8')) as {
  objects: Record<string, { body: string; type?: string }>;
  website: WebsiteConfiguration;
  visits: Array<{ group: string; visits: SiteVisit[] }>;
  keys: Array<{ path: string; key: string }>;
};

/** The objects in the store, under the bucket's store name: each with its type, as uploaded. */
const OBJECTS = table.objects;

/**
 * A store as SeaweedFS answers: GET and HEAD of an object, its ETag, If-None-Match, If-Match and a byte range, a refusal
 * with its XML error and that error's length; what it was asked, kept.
 */
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
    const refuse = (status: number, code: string) => {
      const error = `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Resource>${path}</Resource></Error>`;
      response.writeHead(status, { 'content-type': 'application/xml', 'content-length': Buffer.byteLength(error) }).end(error);
    };
    if (request.headers['if-match'] !== undefined && request.headers['if-match'] !== etag) {
      refuse(412, 'PreconditionFailed');
      return;
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
    if (range && Number(range[1]) >= object.body.length) {
      refuse(416, 'InvalidRange');
      return;
    }
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
        { hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { host: options.host ?? `shop.${SITES}:3004`, ...options.headers } },
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

  /** A group of the table's visits, each made and its answer compared with the table's; the answers. */
  const play = async (group: string) => {
    const visits = table.visits.find((candidate) => candidate.group === group)?.visits;
    if (!visits) throw new Error(`website-examples.json has no group ${group}`);
    const answers: Array<Awaited<ReturnType<typeof visit>>> = [];
    for (const example of visits) {
      configure({ ...table.website, ...example.website });
      const headers = { ...example.request };
      if (example.revisit) headers['if-none-match'] = (await visit(example.path)).headers.etag as string;
      asked.length = 0;
      const answer = await visit(example.path, { host: example.host?.replace('{sites}', SITES), method: example.method, headers });
      const seen = (names: string[] | undefined, there: boolean) => (names ?? []).filter((name) => (answer.headers[name] !== undefined) === there);
      expect({
        name: example.name,
        status: answer.status,
        ...(example.body === undefined ? {} : { body: answer.body }),
        includes: (example.includes ?? []).filter((text) => answer.body.includes(text)),
        headers: Object.fromEntries(Object.keys(example.headers ?? {}).map((name) => [name, answer.headers[name]])),
        present: seen(example.present, true),
        absent: seen(example.absent, false),
        ...(example.asked === undefined ? {} : { asked: [...asked] }),
      }).toEqual({
        name: example.name,
        status: example.status,
        ...(example.body === undefined ? {} : { body: example.body }),
        includes: example.includes ?? [],
        headers: example.headers ?? {},
        present: example.present ?? [],
        absent: example.absent ?? [],
        ...(example.asked === undefined ? {} : { asked: example.asked.map((request) => request.replace(' ', ` /${STORE_NAME}/`)) }),
      });
      answers.push(answer);
    }
    return answers;
  };

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
    const [answer] = await play('the index document');

    expect([answer.headers.etag, answer.headers['last-modified'], answer.headers['cache-control']]).toEqual(['"3c7469746c653e69"', 'Thu, 29 Oct 2026 08:00:00 GMT', 'no-cache']);
    expect(counted.map((request) => [request.bucketName, request.class, request.method, request.status, request.bytesOut])).toEqual([['shop', 'website', 'GET', 200, 20]]);
    expect(sent).toEqual([[ACCOUNT, 20]]);
  });

  it("answers a folder's index document, and redirects a folder named without its slash to it, its query kept, as S3 does", async () => {
    await play('a folder');
  });

  it('reads escapes in the path, as a browser sends a name with a space', async () => {
    await play('escapes');
  });

  it('answers a path with no file with the error document and 404; without one, a page of its own naming the key', async () => {
    await play('a path with no file');
  });

  it("answers a single-page app's routes with its index document and 200, and the files it has as they are", async () => {
    await play('a single-page app');
  });

  it("gives a file stored without a type one by its name, and passes the browser's conditions and ranges to the store", async () => {
    const [, again] = await play('types, conditions and ranges');

    expect(again.headers.etag).toBe('"636f6e736f6c652e"');
  });

  it('answers HEAD without a body, and every other method 405, naming the two it takes', async () => {
    await play('methods');
  });

  it('refuses a path that climbs out of the site, however it is escaped, without asking the store', async () => {
    await play('paths out of the site');

    expect(table.keys.map(({ path }) => keyOf(path, 'index.html'))).toEqual(table.keys.map(({ key }) => key));
  });

  it("answers S3's errors for a host that is no site: no such bucket, or a bucket without a website configuration", async () => {
    await play('hosts that are no site');
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

/**
 * L2: buckets' sites, on a real PostgreSQL and a real store: a site's files
 * uploaded through the S3 front door as AWS's SDK sends them, its website
 * configuration put the same way and through FF's API, then each path a
 * browser asks answered by the website server from the store: the index and
 * error documents, a single-page app's routes, the store's own ETag and 304,
 * ranges, a path that would climb into another bucket; each visit counted in
 * the site's minutes, which the plan's monthly transfer reads once written.
 * Each run works in a scratch database, dropped afterwards, and buckets of its
 * own in the store.
 *   docker compose up -d --wait postgres s3 && npm run test:db
 */
import 'dotenv/config';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetBucketWebsiteCommand,
  ListObjectsV2Command,
  PutBucketWebsiteCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { IncomingMessage, request as httpRequest } from 'node:http';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import { CreditService } from '../billing/credit.service';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { EncryptionService } from '../encryption/encryption.service';
import { onePlan } from '../plans/test-fixtures';
import { BucketEvents } from './bucket-events';
import { BucketNotificationsService } from './bucket-notifications.service';
import { BucketWebsitesService } from './bucket-websites.service';
import { Bucket } from './bucket.entity';
import { S3FrontDoor } from './front-door';
import { SiteTransfer } from './site-transfer.service';
import { StorageDirectory } from './storage-directory.service';
import { StorageKey } from './storage-key.entity';
import { newAccessKeyId, newSecretAccessKey, newStoreName } from './storage-names';
import { StorageRequestCount } from './storage-request-count.entity';
import { StorageRequestCountsService } from './storage-request-counts.service';
import { WebsiteServer } from './website-server';
import { testObjectStore, testStoreClient } from '../object-store/test-fixtures';
import { notedUses } from './test-fixtures';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '730000000001';

run("buckets' sites, from the S3 front door to a browser (L2)", () => {
  const objectStore = testObjectStore();
  const store = testStoreClient();
  const encryption = new EncryptionService({ getOrThrow: () => [{ id: 'test', key: randomBytes(32) }] } as unknown as ConfigService);
  let db: ScratchDatabase;
  let frontDoor: S3FrontDoor;
  let websiteServer: WebsiteServer;
  let websites: BucketWebsitesService;
  let counts: StorageRequestCountsService;
  let transfer: SiteTransfer;
  let sitePort: number;
  const shop = { name: `shop-${randomBytes(4).toString('hex')}`, storeName: newStoreName() };
  // Another bucket, whose file no path of the site's may reach.
  const vault = { name: `vault-${randomBytes(4).toString('hex')}`, storeName: newStoreName() };
  const key = { id: newAccessKeyId(), secret: newSecretAccessKey() };
  let client: S3Client;

  /** A browser's request to the site: its status, headers and body. */
  const visit = (path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: IncomingMessage['headers']; body: string }>((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port: sitePort, path, headers: { host: `${shop.name}.site.localhost`, ...headers } }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      request.on('error', reject);
      request.end();
    });

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    const ds = db.dataSource;
    await ds.getRepository(Account).save({ id: ACCOUNT, name: 'Shop', planId: 'beta', status: AccountStatus.ACTIVE });
    // A store just started answers before it can keep anything: the buckets wait for it, 30 s at most.
    for (let tries = 0; ; tries++) {
      try {
        await store.send(new CreateBucketCommand({ Bucket: shop.storeName }));
        break;
      } catch (error) {
        if (tries >= 30) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    await store.send(new CreateBucketCommand({ Bucket: vault.storeName }));
    await store.send(new PutObjectCommand({ Bucket: vault.storeName, Key: 'secret.txt', Body: 'the vault' }));
    const buckets = ds.getRepository(Bucket);
    await buckets.save([
      { accountId: ACCOUNT, name: shop.name, storeName: shop.storeName },
      { accountId: ACCOUNT, name: vault.name, storeName: vault.storeName },
    ]);
    const directory = new StorageDirectory(buckets, ds.getRepository(StorageKey), encryption);
    await ds.getRepository(StorageKey).save({ id: key.id, accountId: ACCOUNT, secret: directory.sealSecret(key.id, key.secret) });
    const config = new ConfigService({ storage: { base: 'http://s3.localhost:3002', region: 'tn-tunis-1' }, website: { base: 'http://site.localhost:3004' }, objectStore });
    counts = new StorageRequestCountsService(ds.getRepository(StorageRequestCount));
    websites = new BucketWebsitesService(buckets, new AuditService(ds.getRepository(AuditEntry)), config);
    frontDoor = new S3FrontDoor(
      config,
      directory,
      counts,
      onePlan(),
      { admit: async () => undefined } as unknown as CreditService,
      { increment: async () => ({ totalHits: 1, timeToExpire: 1, isBlocked: false, timeToBlockExpire: 0 }) },
      // The buckets have no notifications: their own suite has them.
      {} as BucketNotificationsService,
      new BucketEvents(),
      websites,
      // Nor are its keys' uses: the front door's own suite has them.
      notedUses(),
    );
    const endpoint = `http://127.0.0.1:${(await frontDoor.listen(0, '127.0.0.1')).port}`;
    client = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: key.id, secretAccessKey: key.secret }, maxAttempts: 1 });
    transfer = new SiteTransfer(ds.getRepository(StorageRequestCount));
    websiteServer = new WebsiteServer(config, directory, counts, onePlan(), transfer);
    sitePort = (await websiteServer.listen(0, '127.0.0.1')).port;

    // The site, as a build makes it, uploaded as `aws s3 sync` would: each file with its type, but one.
    const files: Array<[string, string, string | undefined]> = [
      ['index.html', '<!doctype html><title>shop</title>', 'text/html'],
      ['docs/index.html', '<!doctype html><title>docs</title>', 'text/html'],
      ['404.html', '<!doctype html><title>not here</title>', 'text/html'],
      ['assets/app-1f2e.js', 'console.log("shop")', 'text/javascript'],
      ['assets/site.css', 'body { color: navy }', undefined],
    ];
    for (const [name, body, type] of files) await client.send(new PutObjectCommand({ Bucket: shop.name, Key: name, Body: body, ...(type ? { ContentType: type } : {}) }));
  });

  afterAll(async () => {
    await websiteServer?.onModuleDestroy();
    await frontDoor?.onModuleDestroy();
    for (const bucket of [shop, vault]) {
      const listed = await store.send(new ListObjectsV2Command({ Bucket: bucket.storeName })).catch(() => ({ Contents: [] }));
      for (const object of listed.Contents ?? []) await store.send(new DeleteObjectCommand({ Bucket: bucket.storeName, Key: object.Key }));
      await store.send(new DeleteBucketCommand({ Bucket: bucket.storeName })).catch(() => undefined);
    }
    store.destroy();
    client?.destroy();
    await db?.drop();
  });

  it('is no site until its website configuration is set through the S3 front door, which then reads it back', async () => {
    expect((await visit('/')).body).toContain('Code: NoSuchWebsiteConfiguration');

    await client.send(new PutBucketWebsiteCommand({ Bucket: shop.name, WebsiteConfiguration: { IndexDocument: { Suffix: 'index.html' }, ErrorDocument: { Key: '404.html' } } }));

    const got = await client.send(new GetBucketWebsiteCommand({ Bucket: shop.name }));
    expect([got.IndexDocument?.Suffix, got.ErrorDocument?.Key]).toEqual(['index.html', '404.html']);
    const [entry] = await db.dataSource.getRepository(AuditEntry).find({ where: { accountId: ACCOUNT, action: 'bucket.website' }, order: { id: 'DESC' }, take: 1 });
    expect([entry.actor, entry.resource]).toEqual([`access_key:${key.id}`, `bucket:${shop.name}`]);
  });

  it("answers the store's files as S3's website endpoint does: index, folders, the error document, types, the store's ETag and ranges", async () => {
    const index = await visit('/');
    expect([index.status, index.body, index.headers['content-type'], index.headers['x-content-type-options']]).toEqual([200, '<!doctype html><title>shop</title>', 'text/html', 'nosniff']);
    expect((await visit('/docs/')).body).toBe('<!doctype html><title>docs</title>');
    expect([(await visit('/docs')).status, (await visit('/docs')).headers.location]).toEqual([302, '/docs/']);
    const missing = await visit('/nothing/here');
    expect([missing.status, missing.body]).toEqual([404, '<!doctype html><title>not here</title>']);
    expect((await visit('/assets/site.css')).headers['content-type']).toBe('text/css; charset=utf-8');

    const asset = await visit('/assets/app-1f2e.js');
    expect(asset.headers.etag).toMatch(/^"[0-9a-f]+"$/);
    expect((await visit('/assets/app-1f2e.js', { 'if-none-match': asset.headers.etag as string })).status).toBe(304);
    const part = await visit('/assets/app-1f2e.js', { range: 'bytes=0-6' });
    expect([part.status, part.body]).toEqual([206, 'console']);
  });

  it("never reaches another bucket's file, whatever the path names", async () => {
    for (const path of [`/../${vault.storeName}/secret.txt`, `/%2e%2e/${vault.storeName}/secret.txt`, `/docs/../../${vault.storeName}/secret.txt`]) {
      const answer = await visit(path);
      expect([path, answer.status, answer.body.includes('the vault')]).toEqual([path, 400, false]);
    }
  });

  it("answers a single-page app's routes with its index once FF's API says it is one, keeping the documents S3's XML set", async () => {
    await websites.put(ACCOUNT, shop.name, { indexDocument: { suffix: 'index.html' }, errorDocument: { key: '404.html' }, singlePageApp: true });

    const route = await visit('/orders/42');
    expect([route.status, route.body]).toEqual([200, '<!doctype html><title>shop</title>']);
    // S3's XML says nothing of it: putting the documents again keeps it.
    await client.send(new PutBucketWebsiteCommand({ Bucket: shop.name, WebsiteConfiguration: { IndexDocument: { Suffix: 'index.html' } } }));
    expect((await websites.get(ACCOUNT, shop.name)).singlePageApp).toBe(true);
  });

  it("counts each visit in the site's minutes, which the plan's monthly transfer reads once they are written, and bills as S3's GETs", async () => {
    await counts.flush();
    const [row] = await db.dataSource.query<Array<{ requests: number; bytes: string; gets: number; errors: number }>>(
      `SELECT sum(requests)::int AS requests, sum(bytes_out)::text AS bytes, sum(gets)::int AS gets, sum(errors4xx)::int AS errors
         FROM storage_request_counts WHERE account_id = $1 AND class = 'website'`,
      [ACCOUNT],
    );
    // The visits since it became a site, 13; of them, the missing page and the three paths that climb. A visit before is no site's.
    expect(row.requests).toBe(13);
    expect(row.gets).toBe(row.requests);
    expect(row.errors).toBe(4);
    expect(await transfer.sentThisMonth(ACCOUNT)).toBe(BigInt(row.bytes));
  });

  it('is no site again once DeleteBucketWebsite removes it, its files kept', async () => {
    await websites.remove(ACCOUNT, shop.name);

    expect((await visit('/')).body).toContain('Code: NoSuchWebsiteConfiguration');
    expect((await store.send(new ListObjectsV2Command({ Bucket: shop.storeName }))).KeyCount).toBe(5);
  });
});

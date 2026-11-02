/**
 * L2: functions' URLs on a real PostgreSQL: a URL's ID names one URL, a
 * function has one URL at most for $LATEST and one for each alias, takes them
 * along when deleted, an alias its own, and a call through a URL is kept under
 * the ID the gateway chose, with its source. Each run works in a scratch
 * database, dropped afterwards.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { FunctionAlias } from '../functions/entities/function-alias.entity';
import { FunctionInvocation, InvocationSource, InvocationStatus } from '../functions/entities/function-invocation.entity';
import { FunctionUrl, UrlAuthType } from '../functions/entities/function-url.entity';
import { Function, FunctionStatus, Runtime } from '../functions/entities/function.entity';
import { FunctionsService } from '../functions/functions.service';
import { memoryEnvironments, noFunctionKeys, noPackages } from '../functions/test-fixtures';
import { Orchestrator } from '../orchestrator/orchestrator.types';
import { onePlan } from '../plans/test-fixtures';
import { UsageRecord } from '../usage/usage-record.entity';
import { FunctionUrlsService } from './function-urls.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '400000000021';

run("functions' URLs, in the database (L2)", () => {
  let db: ScratchDatabase;
  let functions: FunctionsService;
  let urls: FunctionUrlsService;
  const usageRecords: UsageRecord[] = [];

  const newFunction = (name: string) =>
    db.dataSource.getRepository(Function).save({
      accountId: ACCOUNT,
      name,
      runtime: Runtime.NODEJS,
      code: 'exports.handler = async (event) => ({ statusCode: 200, body: event.rawPath });',
      memory: 128,
      timeout: 5,
      status: FunctionStatus.ACTIVE,
    });

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    await db.dataSource.getRepository(Account).save({ id: ACCOUNT, name: 'URLs', planId: 'beta', status: AccountStatus.ACTIVE });
    const orchestrator = { invoke: async () => ({ output: { statusCode: 200, body: '/' }, durationMs: 4, memoryUsedMb: 20 }) };
    const audit = { record: async () => undefined };
    functions = new FunctionsService(
      db.dataSource.getRepository(Function),
      db.dataSource.getRepository(FunctionInvocation),
      {} as never, // no code to archive here
      orchestrator as unknown as Orchestrator,
      { get: (_key: string, fallback?: unknown) => fallback } as unknown as ConfigService,
      { recordMetric: () => undefined, invocationStarted: () => undefined, invocationFinished: () => undefined } as never,
      onePlan(),
      audit as never,
      // The usage record is written in the transaction that ends the call; here it is only kept.
      { record: async (record: UsageRecord) => usageRecords.push(record) } as never,
      { admit: async () => undefined } as never,
      memoryEnvironments(),
      ...noPackages(),
      noFunctionKeys(),
    );
    urls = new FunctionUrlsService(
      db.dataSource.getRepository(FunctionUrl),
      functions,
      audit as never,
      { getOrThrow: () => 'https://fn.example.tn' } as unknown as ConfigService,
    );
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('gives a function one URL, its times from the database, and refuses a second', async () => {
    const fn = await newFunction('one-url');

    const url = await urls.create(ACCOUNT, fn.id, { authType: UrlAuthType.NONE, cors: { allowOrigins: ['*'] } });

    expect(url).toMatchObject({ functionId: fn.id, cors: { allowOrigins: ['*'] }, createdAt: expect.any(Date), updatedAt: expect.any(Date) });
    expect(await urls.get(ACCOUNT, fn.id)).toEqual(url);
    await expect(urls.create(ACCOUNT, fn.id, { authType: UrlAuthType.NONE })).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses a second URL for $LATEST to two requests at once: the database keeps one", async () => {
    const fn = await newFunction('raced');

    const results = await Promise.allSettled([1, 2, 3].map(() => urls.create(ACCOUNT, fn.id, { authType: UrlAuthType.NONE })));

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason)).toEqual([
      expect.any(ConflictException),
      expect.any(ConflictException),
    ]);
  });

  it("keeps a URL's ID to one URL", async () => {
    const [a, b] = [await newFunction('first'), await newFunction('second')];
    const { functionUrl } = await urls.create(ACCOUNT, a.id, { authType: UrlAuthType.NONE });
    const urlId = new URL(functionUrl).hostname.split('.')[0];

    await expect(
      db.dataSource.getRepository(FunctionUrl).insert({ functionId: b.id, accountId: ACCOUNT, urlId, authType: UrlAuthType.NONE }),
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
    expect((await urls.forUrlId(urlId))?.functionId).toBe(a.id);
  });

  it("gives each alias a URL of its own, beside $LATEST's, one at most to two requests at once; lists them $LATEST's first", async () => {
    const fn = await newFunction('aliased');
    await db.dataSource.getRepository(FunctionAlias).insert([
      { functionId: fn.id, accountId: ACCOUNT, name: 'live', version: null },
      { functionId: fn.id, accountId: ACCOUNT, name: 'canary', version: null },
    ]);
    const latest = await urls.create(ACCOUNT, fn.id, { authType: UrlAuthType.NONE });

    const results = await Promise.allSettled([1, 2, 3].map(() => urls.create(ACCOUNT, fn.id, { authType: UrlAuthType.NONE }, 'live')));
    const canary = await urls.create(ACCOUNT, fn.id, { authType: UrlAuthType.AWS_IAM }, 'canary');

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected', 'rejected']);
    expect(results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason)).toEqual([
      expect.any(ConflictException),
      expect.any(ConflictException),
    ]);
    expect((await urls.list(ACCOUNT, fn.id)).map((url) => url.alias)).toEqual([null, 'canary', 'live']);
    expect((await urls.get(ACCOUNT, fn.id, 'canary')).functionUrl).toBe(canary.functionUrl);
    expect((await urls.get(ACCOUNT, fn.id)).functionUrl).toBe(latest.functionUrl);
    // The database keeps one for $LATEST, as for each alias, whatever the service does.
    await expect(db.dataSource.getRepository(FunctionUrl).insert({ functionId: fn.id, accountId: ACCOUNT, urlId: 'l'.repeat(32), authType: UrlAuthType.NONE })).rejects.toThrow(
      /duplicate key value violates unique constraint "UQ_function_urls_latest"/,
    );
    // Nor for an alias the function hasn't.
    await expect(
      db.dataSource.getRepository(FunctionUrl).insert({ functionId: fn.id, accountId: ACCOUNT, urlId: 'm'.repeat(32), alias: 'gone', authType: UrlAuthType.NONE }),
    ).rejects.toThrow(/foreign key constraint/);
  });

  it("deletes an alias's URL with the alias, $LATEST's and the other aliases' staying", async () => {
    const fn = await newFunction('unaliased');
    await db.dataSource.getRepository(FunctionAlias).insert([
      { functionId: fn.id, accountId: ACCOUNT, name: 'live', version: null },
      { functionId: fn.id, accountId: ACCOUNT, name: 'dev', version: null },
    ]);
    for (const alias of [undefined, 'live', 'dev']) await urls.create(ACCOUNT, fn.id, { authType: UrlAuthType.NONE }, alias);

    await db.dataSource.getRepository(FunctionAlias).delete({ functionId: fn.id, name: 'live' });

    expect((await urls.list(ACCOUNT, fn.id)).map((url) => url.alias)).toEqual([null, 'dev']);
  });

  it('deletes the URL with its function', async () => {
    const fn = await newFunction('going');
    const { functionUrl } = await urls.create(ACCOUNT, fn.id, { authType: UrlAuthType.AWS_IAM });

    await db.dataSource.getRepository(Function).delete({ id: fn.id });

    expect(await urls.forUrlId(new URL(functionUrl).hostname.split('.')[0])).toBeNull();
  });

  it("keeps a URL's call under the ID the gateway chose, with its source, and bills it under that ID", async () => {
    const fn = await newFunction('called');
    const requestId = randomUUID();

    const outcome = await functions.call(fn, { rawPath: '/', headers: { authorization: 'Bearer x' } }, {
      source: InvocationSource.URL,
      requestId,
      history: { rawPath: '/', headers: { authorization: '***' } },
    });

    const kept = await db.dataSource.getRepository(FunctionInvocation).findOneByOrFail({ id: requestId });
    expect(outcome).toMatchObject({ ok: true, output: { statusCode: 200, body: '/' } });
    expect(kept).toMatchObject({ source: InvocationSource.URL, status: InvocationStatus.COMPLETED, input: { rawPath: '/', headers: { authorization: '***' } } });
    expect(usageRecords.at(-1)).toMatchObject({ requestId, startedAt: kept.createdAt });
    // The API's calls say so, as every call did before URLs.
    await functions.invoke(ACCOUNT, fn.id, {});
    const [latest] = await db.dataSource.getRepository(FunctionInvocation).find({ where: { functionId: fn.id }, order: { createdAt: 'DESC' }, take: 1 });
    expect(latest.source).toBe(InvocationSource.API);
  });
});

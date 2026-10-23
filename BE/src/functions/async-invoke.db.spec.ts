/**
 * L2: asynchronous calls on a real PostgreSQL (ADR 0010): an event kept in its
 * function's queue, which its first call makes, its size on the queue; two
 * workers never running an event at once; a stopped worker's event back once
 * its lease ends, its attempt counted as failed; a failing call retried a
 * minute, then two minutes later, then dropped, each attempt in the history
 * under the event's request ID, with a usage record each, through the real
 * call path (the orchestrator is a stand-in); an event past its age dropped;
 * messages gone with their function, or past their expiry; a lost attempt
 * marked under its request. Each run works in a scratch database, dropped
 * afterwards.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { FunctionRuntimeError } from '../orchestrator/orchestrator.errors';
import { InvokeResult, Orchestrator } from '../orchestrator/orchestrator.types';
import { QueueStore } from '../queues/queue-store';
import { UsageRecord } from '../usage/usage-record.entity';
import { UsageService } from '../usage/usage.service';
import { AsyncInvokeWorker } from './async-invoke.worker';
import { FunctionInvocation, InvocationSource, InvocationStatus } from './entities/function-invocation.entity';
import { Function, FunctionStatus, Runtime } from './entities/function.entity';
import { FunctionsService } from './functions.service';
import { memoryEnvironments, noFunctionKeys, noPackages } from './test-fixtures';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '400000000051';
const HOUR = 3600_000;

run('asynchronous calls, in the database (L2)', () => {
  let db: ScratchDatabase;
  let queues: QueueStore;
  let functions: FunctionsService;
  let usage: UsageService;
  const invoke = jest.fn<Promise<InvokeResult>, Parameters<Orchestrator['invoke']>>();
  const config = {
    getOrThrow: () => ({ intervalSeconds: 0, concurrency: 10 }),
    get: (_key: string, fallback?: unknown) => fallback,
  } as unknown as ConfigService;
  let n = 0;

  /** A worker of its own, as each backend runs one; `calls` stands in for the real call path when given. */
  const worker = (calls?: Pick<FunctionsService, 'call'>) =>
    new AsyncInvokeWorker(
      config,
      queues,
      calls ? ({ findOne: (accountId: string, id: string) => functions.findOne(accountId, id), call: calls.call } as unknown as FunctionsService) : functions,
      { admit: async () => undefined } as never,
      db.dataSource.getRepository(Account),
    );
  const send = (fn: Function, requestId: string, body = '{"order":1}', expiresAt = new Date(Date.now() + 7 * HOUR)) => queues.sendEvent(fn, requestId, body, expiresAt);
  const message = async (requestId: string) =>
    (
      await db.dataSource.query<Array<{ visible_at: Date; receive_count: number; attributes: Record<string, number> | null }>>(
        'SELECT visible_at, receive_count, attributes FROM queue_messages WHERE message_id = $1',
        [requestId],
      )
    )[0];
  const uuid = (k: number) => `00000000-0000-4000-8000-${String(k).padStart(12, '0')}`;

  async function newFunction(timeout = 5): Promise<Function> {
    return db.dataSource.getRepository(Function).save({
      name: `fn-${++n}`,
      accountId: ACCOUNT,
      runtime: Runtime.NODEJS,
      code: 'export const handler = async () => 1;',
      memory: 128,
      timeout,
      status: FunctionStatus.ACTIVE,
    });
  }

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    await db.dataSource.getRepository(Account).save({ id: ACCOUNT, name: 'Async', planId: 'beta', status: AccountStatus.ACTIVE });
    queues = new QueueStore(db.dataSource);
    usage = new UsageService(db.dataSource.getRepository(UsageRecord), db.dataSource, config);
    await usage.ensurePartitions();
    functions = new FunctionsService(
      db.dataSource.getRepository(Function),
      db.dataSource.getRepository(FunctionInvocation),
      {} as never, // calls only: no code storage
      { invoke } as unknown as Orchestrator,
      config,
      { invocationStarted: () => undefined, invocationFinished: () => undefined, recordMetric: () => undefined } as never,
      {} as never, // no plans: calls only
      { record: async () => undefined } as never,
      usage,
      { admit: async () => undefined } as never, // every call admitted
      memoryEnvironments(),
      ...noPackages(),
      noFunctionKeys(),
    );
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await db?.drop();
  });

  beforeEach(async () => {
    invoke.mockReset();
    await db.dataSource.query('DELETE FROM queue_messages');
  });

  it("keeps each event in its function's own queue, made at its first call, and counts what the account's messages hold", async () => {
    const fn = await newFunction();

    await send(fn, uuid(1), '{"order":1}');
    await send(fn, uuid(2), '{"order":22}');

    const rows = await db.dataSource.query(`SELECT account_id, name, kind, function_id, size_bytes FROM queues WHERE function_id = $1`, [fn.id]);
    expect(rows).toEqual([{ account_id: ACCOUNT, name: fn.id, kind: 'function', function_id: fn.id, size_bytes: '23' }]);
    expect(await db.dataSource.query(`SELECT message_id, body, function_id, receive_count FROM queue_messages ORDER BY id`)).toEqual([
      { message_id: uuid(1), body: '{"order":1}', function_id: fn.id, receive_count: 0 },
      { message_id: uuid(2), body: '{"order":22}', function_id: fn.id, receive_count: 0 },
    ]);
    expect(await queues.accountBytes(ACCOUNT)).toBe(23);
  });

  it('never runs an event twice, though two workers tick at once', async () => {
    const fn = await newFunction();
    for (let k = 0; k < 20; k++) await send(fn, uuid(100 + k));
    const ran: string[] = [];
    const call = async (_fn: unknown, _payload: unknown, options: { requestId?: string }) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      ran.push(options.requestId as string);
      return { ok: true, output: null, invocation: {} };
    };
    const [a, b] = [worker({ call } as never), worker({ call } as never)];

    const now = new Date(Date.now() + 1000);
    const taken = await Promise.all([a.tick(now), b.tick(now)]);
    await Promise.all([a.settled(), b.settled()]);
    taken.push(await a.tick(now), await b.tick(now));
    await Promise.all([a.settled(), b.settled()]);

    expect(taken.reduce((sum, k) => sum + k, 0)).toBe(20);
    expect(new Set(ran).size).toBe(20);
    expect(ran).toHaveLength(20);
    expect(await db.dataSource.query('SELECT count(*)::int AS n FROM queue_messages')).toEqual([{ n: 0 }]);
    expect(await queues.accountBytes(ACCOUNT)).toBe(0);
  });

  it("brings a stopped worker's event back once its lease ends, the lost attempt counted as failed; the stopped one's late outcome changes nothing", async () => {
    const fn = await newFunction(5);
    await send(fn, uuid(200));
    let finishLate!: () => void;
    const stopped = worker({ call: () => new Promise((resolve) => (finishLate = () => resolve({ ok: true, output: null, invocation: {} }))) } as never);
    const attempts: number[] = [];
    const next = worker({
      call: async (_fn: unknown, _payload: unknown, options: { attempt?: number }) => {
        attempts.push(options.attempt as number);
        return { ok: false, error: new FunctionRuntimeError('Error', 'boom'), invocation: {} } as never;
      },
    });

    const claimedAt = new Date(Date.now() + 1000);
    expect(await stopped.tick(claimedAt)).toBe(1);
    // Its lease: twice the timeout, a cold start of 90 s, and a minute.
    expect((await message(uuid(200))).visible_at.getTime() - claimedAt.getTime()).toBe((2 * 5 + 90 + 60) * 1000);
    expect(await next.tick(new Date(claimedAt.getTime() + 159_000))).toBe(0);

    const afterLease = new Date(claimedAt.getTime() + 161_000);
    expect(await next.tick(afterLease)).toBe(1);
    await next.settled();
    finishLate();
    await stopped.settled();

    expect(attempts).toEqual([2]);
    const kept = await message(uuid(200));
    // Its second failure, the lost one first: retried two minutes after.
    expect([kept.receive_count, kept.attributes, kept.visible_at.getTime() - afterLease.getTime()]).toEqual([
      2,
      { failures: 2, throttles: 0, settled: 2 },
      expect.any(Number),
    ]);
    expect(Math.round((kept.visible_at.getTime() - afterLease.getTime()) / 1000)).toBe(120);
  });

  it("retries a failing call a minute, then two minutes later, then drops it, each attempt in the history under the event's request ID with a usage record", async () => {
    const fn = await newFunction();
    const requestId = uuid(300);
    await send(fn, requestId, '{"order":3}');
    invoke.mockRejectedValue(new FunctionRuntimeError('Error', 'boom', { durationMs: 12 }));
    const w = worker();

    let now = new Date(Date.now() + 1000);
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await w.tick(now)).toBe(1);
      await w.settled();
      const kept = await message(requestId);
      if (!kept) break;
      delays.push(Math.round((kept.visible_at.getTime() - now.getTime()) / 1000));
      now = new Date(kept.visible_at.getTime() + 1000);
    }

    expect(delays).toEqual([60, 120]);
    expect(await message(requestId)).toBeUndefined();
    expect(invoke.mock.calls.map(([, payload, id]) => [payload, id])).toEqual([
      [{ order: 3 }, requestId],
      [{ order: 3 }, requestId],
      [{ order: 3 }, requestId],
    ]);
    const history = await db.dataSource.getRepository(FunctionInvocation).find({ where: { functionId: fn.id }, order: { attempt: 'ASC' } });
    expect(history.map(({ requestId: request, attempt, source, status }) => ({ request, attempt, source, status }))).toEqual([1, 2, 3].map((attempt) => ({ request: requestId, attempt, source: InvocationSource.ASYNC, status: InvocationStatus.ERROR })));
    // The first attempt is the invocation of the request's ID; each retry an invocation of its own.
    expect(history[0].id).toBe(requestId);
    expect(new Set(history.map(({ id }) => id)).size).toBe(3);
    expect(await db.dataSource.query(`SELECT status, billed_ms FROM usage_records WHERE request_id = $1 ORDER BY started_at`, [requestId])).toEqual([
      { status: 'error', billed_ms: 12 },
      { status: 'error', billed_ms: 12 },
      { status: 'error', billed_ms: 12 },
    ]);
  });

  it('runs an event that succeeds once, its attempt the history of its request ID, and deletes it', async () => {
    const fn = await newFunction();
    const requestId = uuid(400);
    await send(fn, requestId, '"hello"');
    invoke.mockResolvedValueOnce({ output: { done: true }, durationMs: 3, memoryUsedMb: 40 });
    const w = worker();

    await w.tick(new Date(Date.now() + 1000));
    await w.settled();

    expect(await message(requestId)).toBeUndefined();
    expect(await db.dataSource.getRepository(FunctionInvocation).findOneByOrFail({ id: requestId })).toMatchObject({
      requestId,
      attempt: 1,
      source: InvocationSource.ASYNC,
      status: InvocationStatus.COMPLETED,
      input: 'hello',
      output: { done: true },
    });
  });

  it('drops an event past its maximum age without a call', async () => {
    const fn = await newFunction();
    await send(fn, uuid(500));
    await db.dataSource.query(`UPDATE queue_messages SET sent_at = now() - interval '6 hours 1 minute'`);
    const w = worker();

    expect(await w.tick(new Date(Date.now() + 1000))).toBe(1);
    await w.settled();

    expect([invoke.mock.calls.length, await message(uuid(500))]).toEqual([0, undefined]);
  });

  it('keeps the size with the messages: deleted with their function, its queue going too, or past their expiry', async () => {
    const [kept, going] = [await newFunction(), await newFunction()];
    await send(kept, uuid(600), '{"a":1}', new Date(Date.now() - 1000));
    await send(kept, uuid(601), '{"a":22}');
    await send(going, uuid(602), '{"a":333}');
    const before = await queues.accountBytes(ACCOUNT);

    await db.dataSource.getRepository(Function).delete({ id: going.id });
    const purged = await queues.purgeExpired();

    expect(purged).toBe(1);
    expect(await db.dataSource.query(`SELECT count(*)::int AS n FROM queues WHERE function_id = $1`, [going.id])).toEqual([{ n: 0 }]);
    expect(await db.dataSource.query(`SELECT message_id FROM queue_messages`)).toEqual([{ message_id: uuid(601) }]);
    expect([before - (await queues.accountBytes(ACCOUNT)), await queues.accountBytes(ACCOUNT)]).toEqual([7 + 9, 8]);
  });

  it("marks an attempt its backend stopped during LOST, the record naming the event's request", async () => {
    const fn = await newFunction();
    const requestId = uuid(700);
    await db.dataSource.query(
      `INSERT INTO function_invocations (function_id, request_id, attempt, input, status, source, created_at) VALUES ($1, $2, 2, '{}', 'RUNNING', 'async', now() - interval '1 hour')`,
      [fn.id, requestId],
    );

    expect(await usage.reapLost()).toBe(1);

    expect(await db.dataSource.query(`SELECT status FROM usage_records WHERE request_id = $1`, [requestId])).toEqual([{ status: 'lost' }]);
    expect(await db.dataSource.query(`SELECT status FROM function_invocations WHERE request_id = $1`, [requestId])).toEqual([{ status: 'LOST' }]);
  });
});

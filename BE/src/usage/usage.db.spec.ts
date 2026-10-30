/**
 * L2: usage records against a real PostgreSQL server (client-readiness plan,
 * P-20, D6, D7), in a scratch database that is dropped after: written with the
 * invocation's final state through the real invoke path (the orchestrator is a
 * stand-in), append-only, untouched by the function's changes, lost calls
 * reaped, and monthly partitions in UTC.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { FunctionInvocation, InvocationStatus } from '../functions/entities/function-invocation.entity';
import { Function, FunctionStatus, Runtime } from '../functions/entities/function.entity';
import { FunctionsService } from '../functions/functions.service';
import { InvokeResult, Orchestrator } from '../orchestrator/orchestrator.types';
import { UsageRecord, UsageStatus } from './usage-record.entity';
import { usageRecord } from './usage';
import { LOST_MESSAGE, UsageService } from './usage.service';
import { memoryEnvironments, noFunctionKeys, noPackages } from '../functions/test-fixtures';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '300000000001';
/** The cold-start limit the reaper is configured with here: K8S_READY_TIMEOUT_SECONDS. */
const COLD_START_SECONDS = 20;

interface RecordRow {
  request_id: string;
  started_at: Date;
  ended_at: Date;
  function_id: string;
  function_name: string;
  memory_mb: number;
  duration_ms: string;
  billed_ms: number;
  init_ms: number | null;
  status: string;
}

run('usage records (L2, P-20)', () => {
  let db: ScratchDatabase;
  let usage: UsageService;
  let functions: FunctionsService;
  const invoke = jest.fn<Promise<InvokeResult>, Parameters<Orchestrator['invoke']>>();
  let n = 0;

  const query = <T = unknown>(sql: string, parameters?: unknown[]) => db.dataSource.query<T>(sql, parameters);
  const refusal = (sql: string) => query(sql).then(() => 'accepted', (error: Error) => error.message);
  const recordsOf = (requestId: string) =>
    query<RecordRow[]>('SELECT *, tableoid::regclass::text AS partition FROM usage_records WHERE request_id = $1', [requestId]);
  const invocationOf = (id: string) => db.dataSource.getRepository(FunctionInvocation).findOneBy({ id });
  /** Waits until the database shows `sql` answering a count above zero: another session got that far. */
  async function until(sql: string): Promise<void> {
    for (let tries = 0; tries < 250; tries++) {
      const [{ n }] = await query<Array<{ n: number }>>(sql);
      if (n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Never true: ${sql}`);
  }
  const waitingFor = (event: string) =>
    `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND (wait_event_type = '${event}' OR wait_event = '${event}')`;

  /** An invocation whose orchestrator call waits until the test answers it. */
  function pendingCall(fn: Function): { id: Promise<string>; answer: (result: InvokeResult) => void; done: Promise<FunctionInvocation> } {
    let called!: (requestId: string) => void;
    const id = new Promise<string>((resolve) => (called = resolve));
    let answer!: (result: InvokeResult) => void;
    invoke.mockImplementationOnce((_fn, _payload, requestId) => {
      called(requestId as string);
      return new Promise((resolve) => (answer = resolve));
    });
    const done = functions.invoke(ACCOUNT, fn.id, {});
    return { id, answer: (result) => answer(result), done };
  }

  /** This month's partition, by the UTC calendar. */
  const thisMonth = () => `usage_records_${new Date().toISOString().slice(0, 7).replace('-', '_')}`;

  async function newFunction(overrides: Partial<Function> = {}): Promise<Function> {
    return db.dataSource.getRepository(Function).save({
      name: `fn-${++n}`,
      accountId: ACCOUNT,
      runtime: Runtime.NODEJS,
      code: 'export const handler = async () => 1;',
      memory: 128,
      timeout: 5,
      status: FunctionStatus.ACTIVE,
      ...overrides,
    });
  }

  /** A RUNNING invocation that started `secondsAgo` before the database's now. */
  async function runningSince(fn: Function, secondsAgo: number): Promise<string> {
    const [{ id }] = await query<Array<{ id: string }>>(
      `INSERT INTO function_invocations (function_id, input, status, created_at, updated_at)
       VALUES ($1, '{}', 'RUNNING', now() - make_interval(secs => $2), now() - make_interval(secs => $2)) RETURNING id`,
      [fn.id, secondsAgo],
    );
    return id;
  }

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    await db.dataSource.getRepository(Account).save({ id: ACCOUNT, name: 'Metered', planId: 'beta', status: AccountStatus.ACTIVE });
    const config = {
      get: (key: string, fallback?: unknown) => (key === 'kubernetes.readyTimeoutSeconds' ? COLD_START_SECONDS : fallback),
    } as unknown as ConfigService;
    usage = new UsageService(db.dataSource.getRepository(UsageRecord), db.dataSource, config);
    functions = new FunctionsService(
      db.dataSource.getRepository(Function),
      db.dataSource.getRepository(FunctionInvocation),
      {} as never, // invocations only: no code storage
      { invoke } as unknown as Orchestrator,
      config,
      { invocationStarted: () => undefined, invocationFinished: () => undefined, recordMetric: () => undefined } as never,
      {} as never, // no plans: invocations only
      { record: async () => undefined } as never,
      usage,
      { admit: async () => undefined } as never, // D9's balance check (P-33): every call admitted
      memoryEnvironments(),
      ...noPackages(),
      noFunctionKeys(),
    );
  });

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(() => {
    invoke.mockReset();
  });

  it("writes an invocation's final state and its usage record together, as the function was when invoked, minInstances included (P-30)", async () => {
    const fn = await newFunction({ memory: 256, minInstances: 1 });
    invoke.mockResolvedValueOnce({ output: { ok: true }, durationMs: 12.34, memoryUsedMb: 50, initMs: 812 });

    const invocation = await functions.invoke(ACCOUNT, fn.id, { a: 1 });

    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ id: fn.id }), { a: 1 }, invocation.id);
    const saved = (await invocationOf(invocation.id)) as FunctionInvocation;
    expect(saved).toMatchObject({ status: InvocationStatus.COMPLETED, duration: 12.34, memoryUsed: 50 });
    expect(await recordsOf(invocation.id)).toEqual([
      {
        request_id: invocation.id,
        started_at: saved.createdAt,
        ended_at: saved.updatedAt,
        account_id: ACCOUNT,
        function_id: fn.id,
        function_name: fn.name,
        runtime: 'nodejs',
        memory_mb: 256,
        min_instances: 1,
        duration_ms: '12.340',
        billed_ms: 13,
        init_ms: 812,
        status: 'success',
        partition: thisMonth(),
      },
    ]);
    expect(saved.updatedAt.getTime()).toBeGreaterThan(saved.createdAt.getTime());
  });

  it("keeps a function's records as they were when it changes, and when it is deleted with its history", async () => {
    const fn = await newFunction();
    invoke.mockResolvedValueOnce({ output: 1, durationMs: 3 });
    const { id } = await functions.invoke(ACCOUNT, fn.id, {});
    const before = await recordsOf(id);

    await db.dataSource.getRepository(Function).update(fn.id, { memory: 1024, name: 'renamed', timeout: 60 });
    expect(await recordsOf(id)).toEqual(before);
    expect(before[0]).toMatchObject({ memory_mb: 128, function_name: fn.name, billed_ms: 3 });

    await db.dataSource.getRepository(Function).delete(fn.id);
    expect(await invocationOf(id)).toBeNull();
    expect(await recordsOf(id)).toEqual(before);
  });

  it("refuses UPDATE, DELETE and TRUNCATE, on the table and on a month's partition, even to the database's owner", async () => {
    const fn = await newFunction();
    invoke.mockResolvedValueOnce({ output: 1, durationMs: 1 });
    const { id } = await functions.invoke(ACCOUNT, fn.id, {});
    const partition = thisMonth();

    expect(await refusal(`UPDATE usage_records SET billed_ms = 0 WHERE request_id = '${id}'`)).toBe(`${partition} is append-only: UPDATE refused`);
    expect(await refusal(`UPDATE ${partition} SET billed_ms = 0`)).toBe(`${partition} is append-only: UPDATE refused`);
    expect(await refusal(`DELETE FROM usage_records WHERE request_id = '${id}'`)).toBe(`${partition} is append-only: DELETE refused`);
    expect(await refusal('TRUNCATE usage_records')).toBe('usage_records is append-only: TRUNCATE refused');
    expect(await refusal(`TRUNCATE ${partition}`)).toBe(`${partition} is append-only: TRUNCATE refused`);
    expect(await recordsOf(id)).toHaveLength(1);
  });

  it('writes a record once: writing it again is a no-op, and the first one stands', async () => {
    const fn = await newFunction();
    const call = { requestId: '7d0b8a3e-9a51-4c7e-8d5f-1b2c3d4e5f60', startedAt: new Date(), endedAt: new Date() };
    await usage.record(usageRecord(fn, { ...call, status: UsageStatus.SUCCESS, durationMs: 5 }));

    await usage.record(usageRecord({ ...fn, memory: 4096 }, { ...call, status: UsageStatus.ERROR, durationMs: 900 }));

    expect(await recordsOf(call.requestId)).toEqual([expect.objectContaining({ status: 'success', memory_mb: 128, billed_ms: 5 })]);
  });

  it('marks calls past the longest a call can take LOST, with records that bill nothing, and leaves the others', async () => {
    // timeout 5 s: the longest is 5 s waiting for an instance, 5 s running, after a 20 s cold start; then 30 s more: 60 s.
    const fn = await newFunction({ memory: 512, minInstances: 1 });
    await query(`UPDATE functions SET updated_at = now() - interval '1 day' WHERE id = $1`, [fn.id]);
    const young = await runningSince(fn, 55);
    const old = await runningSince(fn, 65);
    // A function changed since its call started may have had a longer timeout then: the platform's 900 s.
    const changed = await newFunction();
    const changedYoung = await runningSince(changed, 1_700);
    const changedOld = await runningSince(changed, 1_900);
    await query(`UPDATE functions SET updated_at = now() - interval '10 seconds' WHERE id = $1`, [changed.id]);

    expect(await usage.reapLost()).toBe(2);

    for (const [id, fn_] of [[old, fn], [changedOld, changed]] as const) {
      const lost = (await invocationOf(id)) as FunctionInvocation;
      expect(lost).toMatchObject({ status: InvocationStatus.LOST, error: LOST_MESSAGE });
      expect(await recordsOf(id)).toEqual([
        expect.objectContaining({
          function_id: fn_.id,
          memory_mb: fn_.memory,
          min_instances: fn_.minInstances, // P-30
          status: 'lost',
          duration_ms: '0.000',
          billed_ms: 0,
          init_ms: null,
          started_at: lost.createdAt,
          ended_at: lost.updatedAt,
        }),
      ]);
    }
    for (const id of [young, changedYoung]) {
      expect(await invocationOf(id)).toMatchObject({ status: InvocationStatus.RUNNING });
      expect(await recordsOf(id)).toEqual([]);
    }
    expect(await usage.reapLost()).toBe(0);
    // Out of the way of the next cases: these would soon be past their own deadline.
    await query(`UPDATE function_invocations SET status = 'COMPLETED' WHERE id IN ($1, $2)`, [young, changedYoung]);
  });

  it("writes neither when the record can't be written, so the call is reaped as LOST later", async () => {
    const fn = await newFunction();
    let id = '';
    invoke.mockImplementationOnce(async (_fn, _payload, requestId) => {
      id = requestId as string;
      return { output: 1, durationMs: 2 };
    });
    await query(`
      CREATE FUNCTION refuse_usage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'usage records are unavailable'; END $$;
      CREATE TRIGGER refuse_usage BEFORE INSERT ON usage_records FOR EACH ROW EXECUTE FUNCTION refuse_usage();`);
    try {
      await expect(functions.invoke(ACCOUNT, fn.id, {})).rejects.toThrow('usage records are unavailable');
    } finally {
      await query('DROP TRIGGER refuse_usage ON usage_records; DROP FUNCTION refuse_usage();');
    }

    expect(await invocationOf(id)).toMatchObject({ status: InvocationStatus.RUNNING, output: null });
    expect(await recordsOf(id)).toEqual([]);

    await query(`UPDATE function_invocations SET created_at = created_at - interval '1 hour' WHERE id = $1`, [id]);
    expect(await usage.reapLost()).toBe(1);
    expect(await recordsOf(id)).toEqual([expect.objectContaining({ status: 'lost', billed_ms: 0 })]);
  });

  it('keeps no record of a final state that failed to commit: they are one transaction', async () => {
    const fn = await newFunction();
    let id = '';
    invoke.mockImplementationOnce(async (_fn, _payload, requestId) => {
      id = requestId as string;
      return { output: 1, durationMs: 2 };
    });
    // Checked at commit, after the record was written.
    await query(`
      CREATE FUNCTION refuse_ending() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'the final state could not be committed'; END $$;
      CREATE CONSTRAINT TRIGGER refuse_ending AFTER UPDATE ON function_invocations DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION refuse_ending();`);
    try {
      await expect(functions.invoke(ACCOUNT, fn.id, {})).rejects.toThrow('the final state could not be committed');
    } finally {
      await query('DROP TRIGGER refuse_ending ON function_invocations; DROP FUNCTION refuse_ending();');
    }

    expect(await invocationOf(id)).toMatchObject({ status: InvocationStatus.RUNNING });
    expect(await recordsOf(id)).toEqual([]);
    await query(`UPDATE function_invocations SET created_at = created_at - interval '1 hour' WHERE id = $1`, [id]);
    expect(await usage.reapLost()).toBe(1);
  });

  it('leaves a call that ends after it was reaped LOST, with its one record, and still answers the caller', async () => {
    const call = pendingCall(await newFunction());
    const id = await call.id;
    // The backend froze past the call's deadline: the reaper got there first.
    await query(`UPDATE function_invocations SET created_at = created_at - interval '1 hour' WHERE id = $1`, [id]);
    expect(await usage.reapLost()).toBe(1);
    call.answer({ output: 'late', durationMs: 4 });

    await expect(call.done).resolves.toMatchObject({ id, output: 'late' });
    expect(await invocationOf(id)).toMatchObject({ status: InvocationStatus.LOST, output: null });
    expect(await recordsOf(id)).toEqual([expect.objectContaining({ status: 'lost', billed_ms: 0 })]);
  });

  it('makes a call that ends while the reaper is marking it wait, and leaves it LOST', async () => {
    const call = pendingCall(await newFunction());
    const id = await call.id;
    await query(`UPDATE function_invocations SET created_at = created_at - interval '1 hour' WHERE id = $1`, [id]);
    // The reaper has marked the call, and takes its time writing the record.
    await query(`
      CREATE FUNCTION slow_usage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.5); RETURN NEW; END $$;
      CREATE TRIGGER slow_usage BEFORE INSERT ON usage_records FOR EACH ROW EXECUTE FUNCTION slow_usage();`);
    try {
      const reaping = usage.reapLost();
      await until(waitingFor('PgSleep'));
      call.answer({ output: 'late', durationMs: 4 });

      expect(await reaping).toBe(1);
      await expect(call.done).resolves.toMatchObject({ output: 'late' });
    } finally {
      await query('DROP TRIGGER slow_usage ON usage_records; DROP FUNCTION slow_usage();');
    }
    expect(await invocationOf(id)).toMatchObject({ status: InvocationStatus.LOST });
    expect(await recordsOf(id)).toEqual([expect.objectContaining({ status: 'lost' })]);
  });

  it('leaves a call that ended while the reaper looked at it: its outcome stands', async () => {
    const fn = await newFunction();
    await query(`UPDATE functions SET updated_at = now() - interval '1 day' WHERE id = $1`, [fn.id]);
    const id = await runningSince(fn, 3_600);
    const ending = db.dataSource.createQueryRunner();
    await ending.connect();
    await ending.startTransaction();
    try {
      await ending.query('SELECT 1 FROM function_invocations WHERE id = $1 FOR UPDATE', [id]); // as finish() does
      const reaping = usage.reapLost();
      await until(waitingFor('Lock'));
      await ending.query(`UPDATE function_invocations SET status = 'COMPLETED' WHERE id = $1`, [id]);
      await ending.commitTransaction();

      expect(await reaping).toBe(0);
    } finally {
      if (ending.isTransactionActive) await ending.rollbackTransaction();
      await ending.release();
    }
    expect(await invocationOf(id)).toMatchObject({ status: InvocationStatus.COMPLETED });
    expect(await recordsOf(id)).toEqual([]);
  });

  it('bills a call whose function was deleted while it ran: its history went with the function, its record stays', async () => {
    const fn = await newFunction();
    invoke.mockImplementationOnce(async (workload) => {
      await db.dataSource.getRepository(Function).delete(workload.id);
      return { output: 1, durationMs: 4.5 };
    });

    const { id } = await functions.invoke(ACCOUNT, fn.id, {});

    expect(await invocationOf(id)).toBeNull();
    expect(await recordsOf(id)).toEqual([expect.objectContaining({ function_id: fn.id, status: 'success', billed_ms: 5 })]);
  });

  it("creates each month's partition with UTC bounds, whatever the session's time zone, and refuses a month without one", async () => {
    // A session 14 hours ahead of UTC creates March; the backend's job creates the months around it.
    await db.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL TIME ZONE 'Pacific/Kiritimati'`);
      await manager.query(`SELECT ff_ensure_month_partition('usage_records', '2031-03-01')`);
    });
    await expect(usage.ensurePartitions(new Date('2031-02-10T12:00:00Z'))).resolves.toEqual([
      'usage_records_2031_02',
      'usage_records_2031_03',
      'usage_records_2031_04',
      'capacity_samples_2031_02',
      'capacity_samples_2031_03',
      'capacity_samples_2031_04',
      'database_samples_2031_02',
      'database_samples_2031_03',
      'database_samples_2031_04',
      'bucket_samples_2031_02',
      'bucket_samples_2031_03',
      'bucket_samples_2031_04',
      'storage_request_counts_2031_02',
      'storage_request_counts_2031_03',
      'storage_request_counts_2031_04',
      'queue_request_counts_2031_02',
      'queue_request_counts_2031_03',
      'queue_request_counts_2031_04',
      'queue_samples_2031_02',
      'queue_samples_2031_03',
      'queue_samples_2031_04',
      'async_event_counts_2031_02',
      'async_event_counts_2031_03',
      'async_event_counts_2031_04',
      'cache_samples_2031_02',
      'cache_samples_2031_03',
      'cache_samples_2031_04',
    ]);
    await expect(usage.ensurePartitions(new Date('2031-02-10T12:00:00Z'))).resolves.toHaveLength(27); // again: nothing to do

    const fn = await newFunction();
    const at = async (startedAt: string, requestId: string) => {
      const call = { requestId, startedAt: new Date(startedAt), endedAt: new Date(startedAt) };
      await usage.record(usageRecord(fn, { ...call, status: UsageStatus.SUCCESS, durationMs: 1 }));
      return ((await recordsOf(requestId))[0] as unknown as { partition: string }).partition;
    };
    expect(await at('2031-02-28T23:59:59.999Z', '00000000-0000-4000-8000-000000000001')).toBe('usage_records_2031_02');
    expect(await at('2031-03-01T00:00:00.000Z', '00000000-0000-4000-8000-000000000002')).toBe('usage_records_2031_03');
    expect(await at('2031-03-31T23:59:59.999Z', '00000000-0000-4000-8000-000000000003')).toBe('usage_records_2031_03');
    expect(await at('2031-04-01T00:00:00.000Z', '00000000-0000-4000-8000-000000000004')).toBe('usage_records_2031_04');
    await expect(at('2031-05-01T00:00:00.000Z', '00000000-0000-4000-8000-000000000005')).rejects.toThrow(
      /no partition of relation "usage_records" found for row/,
    );
    expect(await refusal('TRUNCATE usage_records_2031_04')).toBe('usage_records_2031_04 is append-only: TRUNCATE refused');
  });
});

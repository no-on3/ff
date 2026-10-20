/**
 * L2: capacity samples and the capacity report against a real PostgreSQL
 * server (client-readiness plan, P-21, D8), in a scratch database that is
 * dropped after: what a sample copies from the functions table, a minute
 * written once, append-only, and reserved against billed GB-s per account and
 * day. The orchestrator is a stand-in; hack/k8s/test-it.sh lists real
 * Deployments (L3).
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { Function, FunctionStatus, Runtime } from '../functions/entities/function.entity';
import { Orchestrator } from '../orchestrator/orchestrator.types';
import { capacityReport } from './capacity-report';
import { CapacityService } from './capacity.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const A = '400000000001';
const B = '400000000002';

interface SampleRow {
  function_id: string;
  minute: Date;
  account_id: string;
  instances: number;
  min_instances: number;
  memory_mb: number;
  partition: string;
}

run('capacity samples (L2, P-21)', () => {
  let db: ScratchDatabase;
  let capacity: CapacityService;
  let ready = new Map<string, number>();
  let n = 0;

  const query = <T = unknown>(sql: string, parameters?: unknown[]) => db.dataSource.query<T>(sql, parameters);
  const refusal = (sql: string) => query(sql).then(() => 'accepted', (error: Error) => error.message);
  const samplesOf = (functionId: string) =>
    query<SampleRow[]>(
      'SELECT *, tableoid::regclass::text AS partition FROM capacity_samples WHERE function_id = $1 ORDER BY minute',
      [functionId],
    );
  const newFunction = (accountId: string, overrides: Partial<Function> = {}) =>
    db.dataSource.getRepository(Function).save({
      name: `fn-${++n}`,
      accountId,
      runtime: Runtime.NODEJS,
      code: 'x',
      memory: 128,
      timeout: 5,
      status: FunctionStatus.ACTIVE,
      ...overrides,
    });
  /** Writes a sample row as the sampler would, for a minute in the past. */
  const sampleAt = (functionId: string, accountId: string, minute: string, instances: number, minInstances: number, memoryMb: number) =>
    query('INSERT INTO capacity_samples VALUES ($1, $2, $3, $4, $5, $6)', [functionId, minute, accountId, instances, minInstances, memoryMb]);
  const usageAt = (accountId: string, startedAt: string, memoryMb: number, billedMs: number, status = 'success') =>
    query(
      `INSERT INTO usage_records (request_id, started_at, ended_at, account_id, function_id, function_name, runtime, memory_mb,
         duration_ms, billed_ms, status) VALUES (gen_random_uuid(), $2, $2, $1, gen_random_uuid(), 'f', 'nodejs', $3, $4::numeric, $4::int, $5)`,
      [accountId, startedAt, memoryMb, billedMs, status],
    );

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    for (const id of [A, B]) {
      await db.dataSource.getRepository(Account).save({ id, name: `Account ${id}`, planId: 'beta', status: AccountStatus.ACTIVE });
    }
    // Months the fixtures use, as the backend's partition job creates them.
    for (const month of ['2026-08-01', '2026-09-01', '2026-10-01']) {
      for (const table of ['capacity_samples', 'usage_records']) await query('SELECT ff_ensure_month_partition($1, $2)', [table, month]);
    }
    const orchestrator = { readyInstancesByFunction: async () => ready } as unknown as Orchestrator;
    capacity = new CapacityService(orchestrator, db.dataSource);
  });

  afterAll(async () => {
    await db?.drop();
  });

  it("samples a minute: each ready function's instances, with its account, minInstances and memory from the database", async () => {
    const warm = await newFunction(A, { memory: 512, minInstances: 2, maxInstances: 5 });
    const busy = await newFunction(B);
    ready = new Map([[warm.id, 3], [busy.id, 1], ['5e2b9c7a-1d4f-4a6e-8b3c-9f0e1d2c3b4a', 2]]); // the last one: no such function

    await expect(capacity.sample(new Date('2026-10-17T10:01:05.123Z'))).resolves.toBe(2);

    expect(await samplesOf(warm.id)).toEqual([
      {
        function_id: warm.id,
        minute: new Date('2026-10-17T10:01:00Z'),
        account_id: A,
        instances: 3,
        min_instances: 2,
        memory_mb: 512,
        partition: 'capacity_samples_2026_10',
      },
    ]);
    expect(await samplesOf(busy.id)).toEqual([expect.objectContaining({ account_id: B, instances: 1, min_instances: 0, memory_mb: 128 })]);
  });

  it('writes a minute once: a second sample of it keeps the first, the next minute gets its own', async () => {
    const fn = await newFunction(A);
    ready = new Map([[fn.id, 1]]);
    await capacity.sample(new Date('2026-10-17T10:02:05Z'));
    ready = new Map([[fn.id, 4]]);

    await expect(capacity.sample(new Date('2026-10-17T10:02:50Z'))).resolves.toBe(0);
    await expect(capacity.sample(new Date('2026-10-17T10:03:05Z'))).resolves.toBe(1);

    expect((await samplesOf(fn.id)).map((row) => [row.minute.toISOString(), row.instances])).toEqual([
      ['2026-10-17T10:02:00.000Z', 1],
      ['2026-10-17T10:03:00.000Z', 4],
    ]);
  });

  it("takes the minute by the database's clock when not told, and keeps a deleted function's samples", async () => {
    const fn = await newFunction(A);
    ready = new Map([[fn.id, 1]]);

    await expect(capacity.sample()).resolves.toBe(1);
    await db.dataSource.getRepository(Function).delete(fn.id);

    const [{ minute }] = await samplesOf(fn.id);
    const [{ now }] = await query<Array<{ now: Date }>>(`SELECT date_trunc('minute', now()) AS now`);
    expect(Math.abs(minute.getTime() - now.getTime())).toBeLessThanOrEqual(60_000);
    expect(minute.getUTCSeconds()).toBe(0);
  });

  it("refuses UPDATE, DELETE and TRUNCATE, on the table and on a month's partition, even to the database's owner", async () => {
    const fn = await newFunction(A);
    ready = new Map([[fn.id, 1]]);
    await capacity.sample(new Date('2026-10-17T10:04:05Z'));

    expect(await refusal(`UPDATE capacity_samples SET instances = 0 WHERE function_id = '${fn.id}'`)).toBe(
      'capacity_samples_2026_10 is append-only: UPDATE refused',
    );
    expect(await refusal(`DELETE FROM capacity_samples WHERE function_id = '${fn.id}'`)).toBe(
      'capacity_samples_2026_10 is append-only: DELETE refused',
    );
    expect(await refusal('TRUNCATE capacity_samples')).toBe('capacity_samples is append-only: TRUNCATE refused');
    expect(await refusal('TRUNCATE capacity_samples_2026_10')).toBe('capacity_samples_2026_10 is append-only: TRUNCATE refused');
    expect(await samplesOf(fn.id)).toHaveLength(1);
  });

  it('reports reserved against billed GB-s per account and UTC day, exactly, with the requests billed', async () => {
    const f = '00000000-0000-4000-8000-0000000000a1';
    // Account A on 2026-09-01: 3 minutes of 2 instances at 512 MB, with minInstances 1; on 2026-09-02, usage only.
    for (const minute of ['2026-09-01T10:00:00Z', '2026-09-01T10:01:00Z', '2026-09-01T23:59:00Z']) await sampleAt(f, A, minute, 2, 1, 512);
    await usageAt(A, '2026-09-01T10:00:30Z', 512, 1_500); // 1.5 s × 0.5 GB = 0.75 GB-s
    await usageAt(A, '2026-09-01T10:00:31Z', 512, 3_000, 'timeout'); // 1.5 GB-s
    await usageAt(A, '2026-09-01T10:00:32Z', 512, 0, 'throttled'); // not a request billed
    await usageAt(A, '2026-09-02T00:00:00Z', 128, 8_000); // 1 GB-s, on the next day by the UTC calendar
    // Account B: an instance held for a minute, and no call.
    await sampleAt('00000000-0000-4000-8000-0000000000b1', B, '2026-09-01T12:00:00Z', 1, 0, 1_024);
    // Outside the window: the day before, and the first instant of the day after.
    await sampleAt(f, A, '2026-08-31T23:59:00Z', 2, 1, 512);
    await usageAt(A, '2026-09-03T00:00:00Z', 512, 1_000);

    const window = [new Date('2026-09-01T00:00:00Z'), new Date('2026-09-03T00:00:00Z')] as const;
    const report = await capacityReport(db.dataSource, ...window);
    // The same days, by the UTC calendar, from a session 14 hours ahead of UTC.
    const fromKiritimati = await db.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL TIME ZONE 'Pacific/Kiritimati'`);
      return capacityReport(manager, ...window);
    });

    expect(fromKiritimati).toEqual(report);
    expect(report).toEqual([
      // 3 samples × 2 instances × 0.5 GB × 60 s; minInstances: 3 × 1 × 0.5 GB × 60 s.
      { day: '2026-09-01', accountId: A, reservedGbS: 180, provisionedGbS: 90, billedGbS: 2.25, requests: 2 },
      { day: '2026-09-01', accountId: B, reservedGbS: 60, provisionedGbS: 0, billedGbS: 0, requests: 0 },
      { day: '2026-09-02', accountId: A, reservedGbS: 0, provisionedGbS: 0, billedGbS: 1, requests: 1 },
    ]);
  });
});

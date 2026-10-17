/**
 * L2: the migrations against a real PostgreSQL server: the compose database,
 * or whatever the DB_* variables (BE/.env) point to. Every case works in its own
 * scratch database, which is dropped afterwards, so the development database is
 * never touched.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { databaseConfiguration } from '../config/configuration';
import { FunctionInvocation, InvocationStatus } from '../functions/entities/function-invocation.entity';
import { Function, FunctionStatus, Runtime } from '../functions/entities/function.entity';
import { FunctionMetrics } from '../metrics/entities/function-metrics.entity';
import { MIGRATIONS } from '../migrations';
import { PendingMigrationsError, assertSchemaUpToDate, pendingMigrations, schemaDrift } from './schema-check';
import { ScratchDatabase, createScratchDatabase, withScratchDatabase } from './scratch-database';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const migrationNames = MIGRATIONS.map((migration) => (new migration() as { name: string }).name);

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  column_default: string | null;
}

run('database schema (L2, real PostgreSQL)', () => {
  const settings = databaseConfiguration();

  it('a fresh database has every migration pending, and the startup check refuses it', async () => {
    await withScratchDatabase(settings, 'ff_test', async (dataSource) => {
      expect(await pendingMigrations(dataSource)).toEqual(migrationNames);
      expect(migrationNames[0]).toMatch(/^Baseline\d+$/);

      const refusal = assertSchemaUpToDate(dataSource);
      await expect(refusal).rejects.toBeInstanceOf(PendingMigrationsError);
      await expect(refusal).rejects.toThrow('npm run migration:run');
    });
  });

  it('the scaling-model migration keeps existing rows, and reverts with rows present (P-06)', async () => {
    await withScratchDatabase(settings, 'ff_test', async (dataSource) => {
      await dataSource.runMigrations({ transaction: 'each' });
      await dataSource.undoLastMigration({ transaction: 'each' }); // back to the baseline
      const [{ id }] = await dataSource.query(
        `INSERT INTO functions (name, user_id, runtime, code, memory, timeout, status)
         VALUES ('before', 't', 'nodejs', 'x', 128, 5, 'ACTIVE') RETURNING id`,
      );
      await dataSource.query(
        `INSERT INTO function_metrics (function_id, "timestamp", cpu_usage, memory_usage, request_count,
           response_time_p50, response_time_p95, response_time_p99, error_count, active_instances)
         VALUES ($1, now(), 0, 30, 3, 1, 2, 2, 0, 1)`,
        [id],
      );
      await dataSource.query(`INSERT INTO function_invocations (function_id, status, cpu_used) VALUES ($1, 'COMPLETED', 0.5)`, [id]);

      await dataSource.runMigrations({ transaction: 'each' });

      const [before] = await dataSource.query('SELECT max_instances FROM functions WHERE id = $1', [id]);
      const [metrics] = await dataSource.query('SELECT max_concurrency, request_count FROM function_metrics');
      const [{ id: after }] = await dataSource.query(
        `INSERT INTO functions (name, user_id, runtime, code, memory, timeout) VALUES ('after', 't', 'nodejs', 'x', 128, 5) RETURNING id`,
      );
      const [created] = await dataSource.query('SELECT max_instances FROM functions WHERE id = $1', [after]);
      expect({ before, metrics, created }).toEqual({
        before: { max_instances: 1 }, // existing functions keep their limit
        metrics: { max_concurrency: 0, request_count: 3 },
        created: { max_instances: 3 }, // new ones may scale to 3
      });
      expect(await dataSource.query('SELECT count(*)::int AS n FROM function_invocations')).toEqual([{ n: 1 }]);

      // The way back works with rows in every table, and so does the way forward again.
      await dataSource.undoLastMigration({ transaction: 'each' });
      expect(await dataSource.query('SELECT cpu, target_concurrency FROM functions WHERE id = $1', [id])).toEqual([
        { cpu: 100, target_concurrency: 100 },
      ]);
      await dataSource.runMigrations({ transaction: 'each' });
      expect(await schemaDrift(dataSource)).toEqual([]);
    });
  });

  describe('after the migrations', () => {
    let db: ScratchDatabase;

    beforeAll(async () => {
      db = await createScratchDatabase(settings, 'ff_test');
      await db.dataSource.runMigrations({ transaction: 'each' });
    });

    afterAll(async () => {
      await db?.drop();
    });

    const columns = (): Promise<ColumnRow[]> =>
      db.dataSource.query(
        `SELECT table_name, column_name, data_type, column_default FROM information_schema.columns
          WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
      );

    it('nothing is pending, and the schema is exactly what the entities describe', async () => {
      await expect(assertSchemaUpToDate(db.dataSource)).resolves.toBeUndefined();
      expect(await schemaDrift(db.dataSource)).toEqual([]);
    });

    it('names tables and columns in snake_case, defaults UUIDs to gen_random_uuid(), and keeps time zones', async () => {
      const rows = await columns();
      const tables = [...new Set(rows.map((row) => row.table_name))].sort();

      expect(tables).toEqual(['function_invocations', 'function_metrics', 'functions', 'migrations']);
      expect(rows.filter((row) => !/^[a-z][a-z0-9_]*$/.test(row.column_name))).toEqual([]);
      for (const table of ['functions', 'function_invocations', 'function_metrics']) {
        expect(rows.find((row) => row.table_name === table && row.column_name === 'id')?.column_default).toBe(
          'gen_random_uuid()',
        );
      }
      const appTimestamps = rows.filter((row) => row.table_name !== 'migrations' && /^timestamp/.test(row.data_type));
      expect(appTimestamps.length).toBeGreaterThanOrEqual(6);
      expect(appTimestamps.filter((row) => row.data_type !== 'timestamp with time zone')).toEqual([]);
    });

    it('stores and reads entities through the repositories, with the API field names unchanged', async () => {
      const functions = db.dataSource.getRepository(Function);
      const invocations = db.dataSource.getRepository(FunctionInvocation);
      const fn = await functions.save(
        functions.create({
          name: 'hello',
          userId: 'tenant-1',
          runtime: Runtime.PYTHON,
          code: 'def handler(event, context):\n    return 1\n',
          memory: 128,
          timeout: 5,
          status: FunctionStatus.ACTIVE,
        }),
      );
      await invocations.save(
        invocations.create({ functionId: fn.id, input: { a: 1 }, status: InvocationStatus.COMPLETED, duration: 1.5 }),
      );

      const [page, total] = await invocations.findAndCount({
        where: { functionId: fn.id },
        order: { createdAt: 'DESC' },
      });
      expect(fn.id).toMatch(UUID);
      expect(total).toBe(1);
      expect(page[0]).toMatchObject({ functionId: fn.id, input: { a: 1 }, status: 'COMPLETED', duration: 1.5 });
      expect(page[0].createdAt).toBeInstanceOf(Date);
      expect(await functions.findOneBy({ id: fn.id })).toMatchObject({
        userId: 'tenant-1',
        minInstances: 0,
        maxInstances: 3,
        scaleToZero: true,
      });
      const [raw] = await db.dataSource.query(
        'SELECT user_id, min_instances, scale_to_zero FROM functions WHERE id = $1',
        [fn.id],
      );
      expect(raw).toEqual({ user_id: 'tenant-1', min_instances: 0, scale_to_zero: true });
    });

    it('still deletes a function with its invocations and metrics (P-20 moves usage out of their reach)', async () => {
      const functions = db.dataSource.getRepository(Function);
      const fn = await functions.save(
        functions.create({ name: 'doomed', userId: 't', runtime: Runtime.NODEJS, code: 'x', memory: 128, timeout: 5 }),
      );
      await db.dataSource
        .getRepository(FunctionInvocation)
        .save({ functionId: fn.id, status: InvocationStatus.ERROR, duration: 2 });
      await db.dataSource.getRepository(FunctionMetrics).save({
        functionId: fn.id,
        timestamp: new Date(),
        memoryUsage: 0,
        requestCount: 1,
        responseTimeP50: 2,
        responseTimeP95: 2,
        responseTimeP99: 2,
        errorCount: 1,
        activeInstances: 1,
        maxConcurrency: 1,
      });

      await functions.delete(fn.id);

      const [{ invocations, metrics }] = await db.dataSource.query(
        `SELECT (SELECT count(*)::int FROM function_invocations WHERE function_id = $1) AS invocations,
                (SELECT count(*)::int FROM function_metrics WHERE function_id = $1) AS metrics`,
        [fn.id],
      );
      expect({ invocations, metrics }).toEqual({ invocations: 0, metrics: 0 });
    });

    it('running the migrations again changes nothing', async () => {
      expect(await db.dataSource.runMigrations({ transaction: 'each' })).toEqual([]);
    });

    it('every migration reverts, newest first, and applies again', async () => {
      for (let i = 0; i < MIGRATIONS.length; i++) await db.dataSource.undoLastMigration({ transaction: 'each' });

      expect([...new Set((await columns()).map((row) => row.table_name))]).toEqual(['migrations']);
      const enums = await db.dataSource.query(
        `SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'public' AND t.typtype = 'e'`,
      );
      expect(enums).toEqual([]);
      expect(await pendingMigrations(db.dataSource)).toEqual(migrationNames);

      await db.dataSource.runMigrations({ transaction: 'each' });
      expect(await schemaDrift(db.dataSource)).toEqual([]);
    });
  });
});

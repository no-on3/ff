/**
 * L2: the migrations against a real PostgreSQL server: the compose database,
 * or whatever the DB_* variables (BE/.env) point to. Every case works in its own
 * scratch database, which is dropped afterwards, so the development database is
 * never touched.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { DataSource } from 'typeorm';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { LedgerTransactionKind } from '../billing/ledger/ledger-transaction.entity';
import { LedgerService } from '../billing/ledger/ledger.service';
import { databaseConfiguration } from '../config/configuration';
import { inlineCodeFacts } from '../functions/code-package';
import { FunctionInvocation, InvocationStatus } from '../functions/entities/function-invocation.entity';
import { Function, FunctionStatus, Runtime } from '../functions/entities/function.entity';
import { FunctionMetrics } from '../metrics/entities/function-metrics.entity';
import { MIGRATIONS } from '../migrations';
import { BETA_LIMITS } from '../plans/test-fixtures';
import { PendingMigrationsError, assertSchemaUpToDate, pendingMigrations, schemaDrift } from './schema-check';
import { ScratchDatabase, createScratchDatabase, withScratchDatabase } from './scratch-database';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const migrationNames = MIGRATIONS.map((migration) => (new migration() as { name: string }).name);
/** A development account: functions belong to accounts since P-12. */
const ACCOUNT = '000000000001';

/** Undoes migrations, newest first, until `name` is the newest one applied: later migrations don't change where a test starts. */
async function migrateDownTo(dataSource: DataSource, name: string): Promise<void> {
  for (;;) {
    const [newest] = await dataSource.query('SELECT name FROM migrations ORDER BY id DESC LIMIT 1');
    if (!newest) throw new Error(`${name} is not applied`);
    if (newest.name === name) return;
    await dataSource.undoLastMigration({ transaction: 'each' });
  }
}
const BASELINE = migrationNames[0];
const SCALING_MODEL = migrationNames.find((name) => name.startsWith('ScalingModel')) as string;
const API_KEYS = migrationNames.find((name) => name.startsWith('ApiKeys')) as string;
const AUDIT_LOG = migrationNames.find((name) => name.startsWith('AuditLog')) as string;
const USAGE_RECORDS = migrationNames.find((name) => name.startsWith('UsageRecords')) as string;
const PRICE_BOOKS = migrationNames.find((name) => name.startsWith('PriceBooks')) as string;
const LEDGER = migrationNames.find((name) => name.startsWith('Ledger')) as string;
const RATING = migrationNames.find((name) => name.startsWith('Rating')) as string;
const CREDIT_CONTROLS = migrationNames.find((name) => name.startsWith('CreditControls')) as string;
const BANK_TRANSFERS = migrationNames.find((name) => name.startsWith('BankTransfers')) as string;
const INVOICES = migrationNames.find((name) => name.startsWith('Invoices')) as string;
const CANCELLED_PRO_FORMAS = migrationNames.find((name) => name.startsWith('CancelledProFormas')) as string;
const INVOCATION_HISTORY = migrationNames.find((name) => name.startsWith('InvocationHistory')) as string;
const CLOSED_ACCOUNT_DELETION = migrationNames.find((name) => name.startsWith('ClosedAccountDeletion')) as string;
const ALARMS = migrationNames.find((name) => name.startsWith('Alarms')) as string;
const FUNCTION_ENVIRONMENTS = migrationNames.find((name) => name.startsWith('FunctionEnvironments')) as string;
const SCHEDULES = migrationNames.find((name) => name.startsWith('Schedules')) as string;
const CODE_IMAGES = migrationNames.find((name) => name.startsWith('CodeImages')) as string;
/** A table's partition for the month `ahead` months from now, by the UTC calendar (P-20, P-21). */
function monthPartition(table: string, ahead = 0): string {
  const now = new Date();
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + ahead, 1));
  return `${table}_${month.toISOString().slice(0, 7).replace('-', '_')}`;
}
const usagePartition = (ahead = 0) => monthPartition('usage_records', ahead);
/** The partitions of a partitioned table, by name. */
const partitionsOf = (dataSource: DataSource, table: string) =>
  dataSource.query(`SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = $1::regclass ORDER BY 1`, [table]);
/** FF's own SQL functions. */
const ffFunctions = async (dataSource: DataSource) =>
  (await dataSource.query<Array<{ proname: string }>>(`SELECT proname FROM pg_proc WHERE proname LIKE 'ff\\_%' ORDER BY 1`)).map(
    (row) => row.proname,
  );

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
      await migrateDownTo(dataSource, BASELINE);
      const [{ id }] = await dataSource.query(
        `INSERT INTO functions (name, user_id, runtime, code, memory, timeout, status)
         VALUES ('before', $1, 'nodejs', 'x', 128, 5, 'ACTIVE') RETURNING id`,
        [ACCOUNT],
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
        `INSERT INTO functions (name, account_id, runtime, code, memory, timeout) VALUES ('after', $1, 'nodejs', 'x', 128, 5) RETURNING id`,
        [ACCOUNT],
      );
      const [created] = await dataSource.query('SELECT max_instances FROM functions WHERE id = $1', [after]);
      expect({ before, metrics, created }).toEqual({
        before: { max_instances: 1 }, // existing functions keep their limit
        metrics: { max_concurrency: 0, request_count: 3 },
        created: { max_instances: 3 }, // new ones may scale to 3
      });
      expect(await dataSource.query('SELECT count(*)::int AS n FROM function_invocations')).toEqual([{ n: 1 }]);

      // The way back works with rows in every table, and so does the way forward again.
      await migrateDownTo(dataSource, BASELINE);
      expect(await dataSource.query('SELECT cpu, target_concurrency FROM functions WHERE id = $1', [id])).toEqual([
        { cpu: 100, target_concurrency: 100 },
      ]);
      await dataSource.runMigrations({ transaction: 'each' });
      expect(await schemaDrift(dataSource)).toEqual([]);
    });
  });

  it('the accounts migration makes each tenant an active account, keeps its functions, and reverts with rows present (P-12)', async () => {
    await withScratchDatabase(settings, 'ff_test', async (dataSource) => {
      await dataSource.runMigrations({ transaction: 'each' });
      await migrateDownTo(dataSource, SCALING_MODEL); // before the accounts
      const insert = (tenant: string) =>
        dataSource.query(
          `INSERT INTO functions (name, user_id, runtime, code, memory, timeout, status)
           VALUES ('f', $1, 'nodejs', 'x', 128, 5, 'ACTIVE') RETURNING id`,
          [tenant],
        );
      for (const tenant of ['000000000001', '000000000001', '000000000002']) await insert(tenant);

      await dataSource.runMigrations({ transaction: 'each' });

      expect(await dataSource.query(`SELECT id, status, plan_id, name FROM accounts ORDER BY id`)).toEqual([
        { id: '000000000001', status: 'active', plan_id: 'beta', name: 'Account 000000000001' },
        { id: '000000000002', status: 'active', plan_id: 'beta', name: 'Account 000000000002' },
      ]);
      expect(await dataSource.query(`SELECT account_id, count(*)::int AS n FROM functions GROUP BY 1 ORDER BY 1`)).toEqual([
        { account_id: '000000000001', n: 2 },
        { account_id: '000000000002', n: 1 },
      ]);
      // A function needs an account that exists.
      await expect(
        dataSource.query(`INSERT INTO functions (name, account_id, runtime, code, memory, timeout) VALUES ('x', '999999999999', 'nodejs', 'x', 128, 5)`),
      ).rejects.toThrow(/foreign key/);

      await migrateDownTo(dataSource, SCALING_MODEL);
      expect(await dataSource.query(`SELECT user_id, count(*)::int AS n FROM functions GROUP BY 1 ORDER BY 1`)).toEqual([
        { user_id: '000000000001', n: 2 },
        { user_id: '000000000002', n: 1 },
      ]);
      expect(await dataSource.query(`SELECT to_regclass('accounts') AS accounts`)).toEqual([{ accounts: null }]);

      // A tenant from before 2026-10-17 can't become an account: the migration stops, and changes nothing.
      await insert('1');
      await expect(dataSource.runMigrations({ transaction: 'each' })).rejects.toThrow(/not 12-digit account IDs/);
      expect(await dataSource.query(`SELECT to_regclass('plans') AS plans`)).toEqual([{ plans: null }]);
      expect(await dataSource.query(`SELECT count(*)::int AS n FROM functions WHERE user_id = '1'`)).toEqual([{ n: 1 }]);
    });
  });

  it('the plan-limits migration gives the beta plan its limits and invocations THROTTLED, and reverts with one present (P-15)', async () => {
    await withScratchDatabase(settings, 'ff_test', async (dataSource) => {
      await dataSource.runMigrations({ transaction: 'each' });
      expect(await dataSource.query(`SELECT name, limits FROM plans WHERE id = 'beta'`)).toEqual([{ name: 'Beta', limits: BETA_LIMITS }]);
      await dataSource.query(`INSERT INTO accounts (id, name, status, plan_id) VALUES ($1, 'A', 'active', 'beta')`, [ACCOUNT]);
      const [{ id }] = await dataSource.query(
        `INSERT INTO functions (name, account_id, runtime, code, memory, timeout, status) VALUES ('f', $1, 'nodejs', 'x', 128, 5, 'ACTIVE') RETURNING id`,
        [ACCOUNT],
      );
      const throttled = () =>
        dataSource.query(`INSERT INTO function_invocations (function_id, input, status) VALUES ($1, '{}', 'THROTTLED')`, [id]);
      await throttled();

      await migrateDownTo(dataSource, API_KEYS);

      expect(await dataSource.query(`SELECT status FROM function_invocations`)).toEqual([{ status: 'ERROR' }]);
      expect(await dataSource.query(`SELECT limits FROM plans WHERE id = 'beta'`)).toEqual([{ limits: {} }]);
      await expect(throttled()).rejects.toThrow(/invalid input value for enum/);

      await dataSource.runMigrations({ transaction: 'each' });
      expect(await schemaDrift(dataSource)).toEqual([]);
      await throttled();
    });
  });

  it("the usage-records migration adds LOST and the table with this month's and next month's partitions, and reverts with a LOST invocation present (P-20)", async () => {
    await withScratchDatabase(settings, 'ff_test', async (dataSource) => {
      await dataSource.runMigrations({ transaction: 'each' });
      const partitions = () => partitionsOf(dataSource, 'usage_records');
      expect(await partitions()).toEqual([{ relname: usagePartition(0) }, { relname: usagePartition(1) }]);
      await dataSource.query(`INSERT INTO accounts (id, name, status, plan_id) VALUES ($1, 'A', 'active', 'beta')`, [ACCOUNT]);
      const [{ id }] = await dataSource.query(
        `INSERT INTO functions (name, account_id, runtime, code, memory, timeout, status) VALUES ('f', $1, 'nodejs', 'x', 128, 5, 'ACTIVE') RETURNING id`,
        [ACCOUNT],
      );
      const lost = () => dataSource.query(`INSERT INTO function_invocations (function_id, input, status) VALUES ($1, '{}', 'LOST')`, [id]);
      await lost();

      await migrateDownTo(dataSource, AUDIT_LOG);

      expect(await dataSource.query(`SELECT status FROM function_invocations`)).toEqual([{ status: 'ERROR' }]);
      expect(await dataSource.query(`SELECT to_regclass('usage_records') AS t, to_regclass('${usagePartition(0)}') AS p`)).toEqual([{ t: null, p: null }]);
      expect(await ffFunctions(dataSource)).toEqual(['ff_refuse_change']);
      await expect(lost()).rejects.toThrow(/invalid input value for enum/);

      await dataSource.runMigrations({ transaction: 'each' });
      expect(await schemaDrift(dataSource)).toEqual([]);
      expect(await partitions()).toEqual([{ relname: usagePartition(0) }, { relname: usagePartition(1) }]);
      await lost();
    });
  });

  it("the capacity-samples migration replaces P-20's partition function, and reverts with samples present (P-21)", async () => {
    await withScratchDatabase(settings, 'ff_test', async (dataSource) => {
      await dataSource.runMigrations({ transaction: 'each' });
      // P-30's price book guard, P-31's ledger check, P-33's NOTIFY and inline code's hash too, which reverting their migrations removes.
      expect(await ffFunctions(dataSource)).toEqual(['ff_check_ledger_transaction', 'ff_ensure_month_partition', 'ff_guard_price_book', 'ff_inline_code_facts', 'ff_notify_ledger', 'ff_refuse_change']);
      expect(await partitionsOf(dataSource, 'capacity_samples')).toEqual([
        { relname: monthPartition('capacity_samples', 0) },
        { relname: monthPartition('capacity_samples', 1) },
      ]);
      await dataSource.query(
        `INSERT INTO capacity_samples VALUES (gen_random_uuid(), date_trunc('minute', now()), $1, 1, 0, 128)`,
        [ACCOUNT],
      );

      await migrateDownTo(dataSource, USAGE_RECORDS);

      expect(await dataSource.query(`SELECT to_regclass('capacity_samples') AS t`)).toEqual([{ t: null }]);
      expect(await ffFunctions(dataSource)).toEqual(['ff_ensure_usage_partition', 'ff_refuse_change']);
      expect(await dataSource.query(`SELECT ff_ensure_usage_partition('2031-01-01') AS p`)).toEqual([{ p: 'usage_records_2031_01' }]);
      expect(await dataSource.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'usage_records_2031_01'::regclass`)).toEqual([{ n: 2 }]);

      await dataSource.runMigrations({ transaction: 'each' });
      expect(await schemaDrift(dataSource)).toEqual([]);
      expect(await ffFunctions(dataSource)).toEqual(['ff_check_ledger_transaction', 'ff_ensure_month_partition', 'ff_guard_price_book', 'ff_inline_code_facts', 'ff_notify_ledger', 'ff_refuse_change']);
    });
  });

  it('the invoices migration loads the tax rates, and refuses to revert while an invoice exists, as issued invoices are legal records (P-36)', async () => {
    await withScratchDatabase(settings, 'ff_test', async (dataSource) => {
      await dataSource.runMigrations({ transaction: 'each' });
      expect(await dataSource.query(`SELECT kind, valid_from::text AS "from", percent, amount_minor::int AS amount, currency FROM tax_rates ORDER BY kind`)).toEqual([
        { kind: 'stamp_duty', from: '2023-01-01', percent: null, amount: 1000, currency: 'TND' },
        { kind: 'vat', from: '2018-01-01', percent: 19, amount: null, currency: null },
      ]);
      await dataSource.query(`INSERT INTO accounts (id, name, status, plan_id) VALUES ($1, 'A', 'active', 'beta')`, [ACCOUNT]);
      await dataSource.query(
        `INSERT INTO invoices (id, account_id, kind, number, fiscal_year, sequence, month, issued_on, issued_by, currency, subtotal_minor, vat_minor, stamp_duty_minor, total_minor, buyer_name, pdf_key)
         VALUES (gen_random_uuid(), $1, 'invoice', 'FAC-2026-000001', 2026, 1, '2026-10', '2026-11-02', 'operator:kc-op-1', 'TND', 50000, 9500, 0, 59500, 'A', 'invoices/FAC-2026-000001.pdf')`,
        [ACCOUNT],
      );
      await migrateDownTo(dataSource, INVOICES);

      await expect(dataSource.undoLastMigration({ transaction: 'each' })).rejects.toThrow('1 invoice(s) or credit note(s) were issued: they are legal records, and reverting would drop them');
      expect(await dataSource.query(`SELECT count(*)::int AS n FROM invoices`)).toEqual([{ n: 1 }]); // nothing undone

      await withScratchDatabase(settings, 'ff_test', async (fresh) => {
        await fresh.runMigrations({ transaction: 'each' });
        await fresh.query(`INSERT INTO invoice_counters (series, fiscal_year, last_number) VALUES ('FAC', 2026, 0)`);
        await fresh.query(`INSERT INTO invoice_notices (month, kind, waiting) VALUES ('2026-10', 'ready', 0)`);

        await migrateDownTo(fresh, BANK_TRANSFERS);

        expect(await fresh.query(`SELECT to_regclass('invoices') AS i, to_regclass('invoice_counters') AS c, to_regclass('tax_rates') AS t`)).toEqual([{ i: null, c: null, t: null }]);
        await fresh.runMigrations({ transaction: 'each' });
        expect(await schemaDrift(fresh)).toEqual([]);
      });
    });
  });

  it('the cancelled-pro-formas migration refuses to revert while a pro-forma was cancelled, and reverts with pending and paid ones present (P-74)', async () => {
    const proForma = (status: string, cancelled: boolean) =>
      `INSERT INTO payments (account_id, method, reference, status, currency, credit_minor, vat_percent, vat_minor, total_minor, buyer_name, requested_by, cancelled_at, cancelled_by)
       VALUES ('${ACCOUNT}', 'bank_transfer', 'FF-${status.slice(0, 4).toUpperCase()}-EFGH', '${status}', 'TND', 50000, 19, 9500, 59500, 'A', 'dev',
               ${cancelled ? "now(), 'user:x'" : 'NULL, NULL'})`;
    await withScratchDatabase(settings, 'ff_test', async (dataSource) => {
      await dataSource.runMigrations({ transaction: 'each' });
      await dataSource.query(`INSERT INTO accounts (id, name, status, plan_id) VALUES ($1, 'A', 'active', 'beta')`, [ACCOUNT]);
      await dataSource.query(proForma('cancelled', true));
      await migrateDownTo(dataSource, CANCELLED_PRO_FORMAS);

      await expect(dataSource.undoLastMigration({ transaction: 'each' })).rejects.toThrow('1 pro-forma(s) were cancelled: reverting would lose that');
      expect(await dataSource.query(`SELECT status FROM payments`)).toEqual([{ status: 'cancelled' }]); // nothing undone

      await withScratchDatabase(settings, 'ff_test', async (fresh) => {
        await fresh.runMigrations({ transaction: 'each' });
        await fresh.query(`INSERT INTO accounts (id, name, status, plan_id) VALUES ($1, 'A', 'active', 'beta')`, [ACCOUNT]);
        await fresh.query(proForma('pending', false));

        await migrateDownTo(fresh, INVOICES);

        expect(await fresh.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'payments' AND column_name LIKE 'cancelled%'`)).toEqual([]);
        await expect(fresh.query(`UPDATE payments SET status = 'cancelled'`)).rejects.toThrow(/violates check constraint/);
        await fresh.runMigrations({ transaction: 'each' });
        expect(await schemaDrift(fresh)).toEqual([]);
      });
    });
  });

  it('the invocation-history migration marks no invocation already kept as truncated, and reverts with a truncated one present, its value kept (P-45)', async () => {
    await withScratchDatabase(settings, 'ff_test', async (dataSource) => {
      await dataSource.runMigrations({ transaction: 'each' });
      await migrateDownTo(dataSource, CANCELLED_PRO_FORMAS);
      await dataSource.query(`INSERT INTO accounts (id, name, status, plan_id) VALUES ($1, 'A', 'active', 'beta')`, [ACCOUNT]);
      const [{ id }] = await dataSource.query(
        `INSERT INTO functions (name, account_id, runtime, code, memory, timeout, status) VALUES ('f', $1, 'nodejs', 'x', 128, 5, 'ACTIVE') RETURNING id`,
        [ACCOUNT],
      );
      // Kept before P-45: an output of 100 KB, whole.
      await dataSource.query(`INSERT INTO function_invocations (function_id, input, output, status) VALUES ($1, '{}', to_jsonb(repeat('x', 100000)), 'COMPLETED')`, [id]);
      const flags = `SELECT input_truncated, output_truncated, error_truncated, octet_length(output #>> '{}') AS bytes FROM function_invocations ORDER BY created_at`;

      await dataSource.runMigrations({ transaction: 'each' });
      await migrateDownTo(dataSource, INVOCATION_HISTORY);

      expect(await dataSource.query(flags)).toEqual([{ input_truncated: false, output_truncated: false, error_truncated: false, bytes: 100000 }]);
      await dataSource.query(
        `INSERT INTO function_invocations (function_id, input, output, status, output_truncated) VALUES ($1, '{}', to_jsonb('{"rows":[1,2'::text), 'COMPLETED', true)`,
        [id],
      );

      await migrateDownTo(dataSource, CANCELLED_PRO_FORMAS);

      expect(await dataSource.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'function_invocations' AND column_name LIKE '%truncated'`)).toEqual([]);
      expect(await dataSource.query(`SELECT output #>> '{}' AS output FROM function_invocations ORDER BY created_at`)).toEqual([{ output: 'x'.repeat(100000) }, { output: '{"rows":[1,2' }]);
      await dataSource.runMigrations({ transaction: 'each' });
      expect(await schemaDrift(dataSource)).toEqual([]);
    });
  });

  it('the closed-account-deletion migration gives an account closed before it the whole default notice from now, one not closed none, and reverts with a deletion recorded', async () => {
    await withScratchDatabase(settings, 'ff_test', async (dataSource) => {
      await dataSource.runMigrations({ transaction: 'each' });
      await migrateDownTo(dataSource, INVOCATION_HISTORY);
      await dataSource.query(`INSERT INTO accounts (id, name, status, plan_id) VALUES ('000000000001', 'Open', 'active', 'beta'), ('000000000002', 'Shut', 'closed', 'beta')`);

      await dataSource.runMigrations({ transaction: 'each' });
      await migrateDownTo(dataSource, CLOSED_ACCOUNT_DELETION);

      const rows = await dataSource.query<Array<{ id: string; days: string | null; deleted: Date | null }>>(
        `SELECT id, round(extract(epoch FROM data_deletion_due_at - now()) / 86400)::text AS days, data_deleted_at AS deleted FROM accounts ORDER BY id`,
      );
      expect(rows).toEqual([
        { id: '000000000001', days: null, deleted: null },
        { id: '000000000002', days: '30', deleted: null },
      ]);
      await dataSource.query(`UPDATE accounts SET data_deleted_at = now() WHERE id = '000000000002'`);

      await migrateDownTo(dataSource, INVOCATION_HISTORY);

      expect(await dataSource.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'accounts' AND column_name LIKE 'data_%'`)).toEqual([]);
      expect(await dataSource.query(`SELECT id, status FROM accounts ORDER BY id`)).toEqual([
        { id: '000000000001', status: 'active' },
        { id: '000000000002', status: 'closed' },
      ]);
      await dataSource.runMigrations({ transaction: 'each' });
      expect(await schemaDrift(dataSource)).toEqual([]);
    });
  });

  it("the unique-function-names migration renames all but the oldest of an account's functions with one name, records each in its audit log, and reverts keeping the names", async () => {
    await withScratchDatabase(settings, 'ff_test', async (dataSource) => {
      await dataSource.runMigrations({ transaction: 'each' });
      await migrateDownTo(dataSource, ALARMS);
      await dataSource.query(`INSERT INTO accounts (id, name, status, plan_id) VALUES ('000000000001', 'A', 'active', 'beta'), ('000000000002', 'B', 'active', 'beta')`);
      const created = async (accountId: string, name: string, minutesAgo: number): Promise<string> => {
        const [{ id }] = await dataSource.query(
          `INSERT INTO functions (name, account_id, runtime, code, memory, timeout, status, created_at)
           VALUES ($1, $2, 'nodejs', 'x', 128, 5, 'ERROR', now() - make_interval(mins => $3)) RETURNING id`,
          [name, accountId, minutesAgo],
        );
        return id;
      };
      const oldest = await created('000000000001', 'test', 30);
      const second = await created('000000000001', 'test', 20);
      const third = await created('000000000001', 'test', 10);
      const elsewhere = await created('000000000002', 'test', 5);
      const alone = await created('000000000001', 'testing', 1);
      const printed = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const indexes = () => dataSource.query(`SELECT indexdef FROM pg_indexes WHERE tablename = 'functions' AND indexname NOT LIKE 'PK_%'`);
      const names = () => dataSource.query(`SELECT id, name FROM functions ORDER BY created_at`);

      let lines: unknown[];
      try {
        await dataSource.runMigrations({ transaction: 'each' });
      } finally {
        lines = printed.mock.calls.map(([line]) => line); // before the restore, which forgets them
        printed.mockRestore();
      }

      const renamed = { [second]: `test-${second.slice(0, 8)}`, [third]: `test-${third.slice(0, 8)}` };
      expect(await names()).toEqual([
        { id: oldest, name: 'test' },
        { id: second, name: renamed[second] },
        { id: third, name: renamed[third] },
        { id: elsewhere, name: 'test' },
        { id: alone, name: 'testing' },
      ]);
      expect(await dataSource.query(`SELECT account_id, actor, actor_label, action, resource, details FROM audit_log ORDER BY resource`)).toEqual(
        [second, third].sort().map((id) => ({
          account_id: '000000000001',
          actor: 'system',
          actor_label: 'FF',
          action: 'function.update',
          resource: `function:${id}`,
          details: {
            changed: ['name'],
            name: renamed[id],
            outcome: "renamed by FF: another of the account's functions had the same name, and names are now unique",
          },
        })),
      );
      // The migrations after it print their own lines too: this one's are the renames.
      expect(lines.filter((line) => String(line).startsWith('Renamed ')).sort()).toEqual(
        [second, third].sort().map((id) => `Renamed function:${id} of account 000000000001 to "${renamed[id]}": another of its functions had the same name`),
      );
      expect(await indexes()).toEqual([{ indexdef: expect.stringMatching(/^CREATE UNIQUE INDEX .* ON public\.functions USING btree \(account_id, name\)$/) }]);
      const another = await dataSource
        .query(`INSERT INTO functions (name, account_id, runtime, code, memory, timeout) VALUES ('test', '000000000001', 'nodejs', 'x', 128, 5)`)
        .then(() => 'accepted', (error: Error) => error.message);
      expect(another).toMatch(/^duplicate key value violates unique constraint/);

      await migrateDownTo(dataSource, ALARMS);

      expect(await indexes()).toEqual([{ indexdef: expect.stringMatching(/^CREATE INDEX .* ON public\.functions USING btree \(account_id\)$/) }]);
      expect((await names()).map((row: { name: string }) => row.name)).toEqual(['test', renamed[second], renamed[third], 'test', 'testing']);
      await dataSource.runMigrations({ transaction: 'each' });
      expect(await schemaDrift(dataSource)).toEqual([]);
    });
  });

  it("the event-format migration gives every function that exists FF's original wrapper, a new one Lambda's event, and reverts with both present", async () => {
    await withScratchDatabase(settings, 'ff_test', async (dataSource) => {
      await dataSource.runMigrations({ transaction: 'each' });
      await migrateDownTo(dataSource, FUNCTION_ENVIRONMENTS);
      await dataSource.query(`INSERT INTO accounts (id, name, status, plan_id) VALUES ('000000000001', 'A', 'active', 'beta')`);
      const insert = (name: string) =>
        dataSource.query(`INSERT INTO functions (name, account_id, runtime, code, memory, timeout) VALUES ($1, '000000000001', 'nodejs', 'x', 128, 5)`, [name]);
      await insert('reads-event-body');
      const printed = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        await dataSource.runMigrations({ transaction: 'each' });
        expect(printed).toHaveBeenCalledWith("1 function(s) keep the event they had, FF's original wrapper: each moves to AWS Lambda's with an update");
      } finally {
        printed.mockRestore();
      }
      await insert('made-after');

      expect(await dataSource.query(`SELECT name, event_format FROM functions ORDER BY created_at, name`)).toEqual([
        { name: 'reads-event-body', event_format: 'wrapped' },
        { name: 'made-after', event_format: 'lambda' },
      ]);

      await migrateDownTo(dataSource, FUNCTION_ENVIRONMENTS);
      expect((await dataSource.query(`SELECT count(*)::int AS n FROM functions`))[0].n).toBe(2);
      await dataSource.runMigrations({ transaction: 'each' });
      expect(await schemaDrift(dataSource)).toEqual([]);
    });
  });

  it("the function-packages migration gives every function that exists its code's hash and size as the backend computes them, inline with function.handler, and reverts keeping the code", async () => {
    await withScratchDatabase(settings, 'ff_test', async (dataSource) => {
      await dataSource.runMigrations({ transaction: 'each' });
      await migrateDownTo(dataSource, SCHEDULES);
      await dataSource.query(`INSERT INTO accounts (id, name, status, plan_id) VALUES ('000000000001', 'A', 'active', 'beta')`);
      // A letter outside ASCII: the size counts the bytes of its UTF-8, two.
      const code = "export const handler = async () => 'café';\n";
      await dataSource.query(`INSERT INTO functions (name, account_id, runtime, code, memory, timeout) VALUES ('made-before', '000000000001', 'nodejs', $1, 128, 5)`, [code]);

      await dataSource.runMigrations({ transaction: 'each' });

      const { codeSha256, codeSize } = inlineCodeFacts(code);
      expect(codeSize).toBe(code.length + 1);
      expect(await dataSource.query(`SELECT package_type, handler, code_sha256, code_size FROM functions`)).toEqual([
        { package_type: 'inline', handler: 'function.handler', code_sha256: codeSha256, code_size: codeSize },
      ]);

      await migrateDownTo(dataSource, SCHEDULES);
      expect(await dataSource.query(`SELECT code FROM functions`)).toEqual([{ code }]);
      await dataSource.runMigrations({ transaction: 'each' });
      expect(await schemaDrift(dataSource)).toEqual([]);
    });
  });

  it("keeps inline code's hash and size with its code, whatever writes the row, and a package's as the backend gives them", async () => {
    await withScratchDatabase(settings, 'ff_test', async (dataSource) => {
      await dataSource.runMigrations({ transaction: 'each' });
      await dataSource.query(`INSERT INTO accounts (id, name, status, plan_id) VALUES ('000000000001', 'A', 'active', 'beta')`);
      const facts = async (name: string) => (await dataSource.query(`SELECT code_sha256, code_size FROM functions WHERE name = $1`, [name]))[0];
      const of = (code: string) => {
        const { codeSha256, codeSize } = inlineCodeFacts(code);
        return { code_sha256: codeSha256, code_size: codeSize };
      };

      // Written without them, or with others: inline code's are its code's.
      await dataSource.query(`INSERT INTO functions (name, account_id, runtime, code, memory, timeout) VALUES ('raw', '000000000001', 'nodejs', 'v1', 128, 5)`);
      await dataSource.query(
        `INSERT INTO functions (name, account_id, runtime, code, code_sha256, code_size, memory, timeout) VALUES ('wrong', '000000000001', 'nodejs', 'v1', 'not it', 7, 128, 5)`,
      );
      expect(await facts('raw')).toEqual(of('v1'));
      expect(await facts('wrong')).toEqual(of('v1'));
      await dataSource.query(`UPDATE functions SET code = 'é' WHERE name = 'raw'`);
      await dataSource.query(`UPDATE functions SET code_size = 0 WHERE name = 'wrong'`);
      expect(await facts('raw')).toEqual(of('é'));
      expect(await facts('wrong')).toEqual(of('v1'));

      // A package's are the backend's, from the package: its inline code, if any, says nothing of them.
      const zip = { code_sha256: 'n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=', code_size: 4_096 };
      await dataSource.query(
        `INSERT INTO functions (name, account_id, runtime, code, package_type, code_sha256, code_size, memory, timeout) VALUES ('zipped', '000000000001', 'python', '', 'zip', $1, $2, 128, 5)`,
        [zip.code_sha256, zip.code_size],
      );
      expect(await facts('zipped')).toEqual(zip);
      // Back to inline code: its code's again.
      await dataSource.query(`UPDATE functions SET package_type = 'inline', code = 'v2' WHERE name = 'zipped'`);
      expect(await facts('zipped')).toEqual(of('v2'));
    });
  });

  it("the inline-code-packages migration names each package function's package, an inline one's at its next rollout, makes no package inline, and reverts with both named", async () => {
    await withScratchDatabase(settings, 'ff_test', async (dataSource) => {
      await dataSource.runMigrations({ transaction: 'each' });
      await migrateDownTo(dataSource, CODE_IMAGES);
      await dataSource.query(`INSERT INTO accounts (id, name, status, plan_id) VALUES ($1, 'A', 'active', 'beta')`, [ACCOUNT]);
      const zipped = 'n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=';
      await dataSource.query(
        `INSERT INTO functions (name, account_id, runtime, code, package_type, code_sha256, code_size, memory, timeout) VALUES ('zipped', $1, 'python', '', 'zip', $2, 4096, 128, 5)`,
        [ACCOUNT, zipped],
      );
      await dataSource.query(`INSERT INTO functions (name, account_id, runtime, code, memory, timeout) VALUES ('inline', $1, 'nodejs', 'v1', 128, 5)`, [ACCOUNT]);
      await dataSource.query(
        `INSERT INTO packages (account_id, code_sha256, code_size, unpacked_size, file_count, files) VALUES ($1, $2, 4096, 9000, 1, '{app.py}')`,
        [ACCOUNT, zipped],
      );

      await dataSource.runMigrations({ transaction: 'each' });

      expect(await dataSource.query(`SELECT name, package_sha256 FROM functions ORDER BY name`)).toEqual([
        { name: 'inline', package_sha256: null },
        { name: 'zipped', package_sha256: zipped },
      ]);
      expect(await dataSource.query(`SELECT code_sha256, inline FROM packages`)).toEqual([{ code_sha256: zipped, inline: false }]);

      await dataSource.query(`UPDATE functions SET package_sha256 = 'its own package' WHERE name = 'inline'`);
      await migrateDownTo(dataSource, CODE_IMAGES);
      expect(await dataSource.query(`SELECT count(*)::int AS n FROM functions`)).toEqual([{ n: 2 }]);
      await dataSource.runMigrations({ transaction: 'each' });
      expect(await schemaDrift(dataSource)).toEqual([]);
    });
  });

  it('the bank-transfers migration reverts with a pro-forma present, unless a withholding receivable exists, which the ledger keeps (P-35)', async () => {
    await withScratchDatabase(settings, 'ff_test', async (dataSource) => {
      await dataSource.runMigrations({ transaction: 'each' });
      await dataSource.query(`INSERT INTO accounts (id, name, status, plan_id) VALUES ($1, 'A', 'active', 'beta')`, [ACCOUNT]);
      await dataSource.query(
        `INSERT INTO payments (account_id, method, reference, currency, credit_minor, vat_percent, vat_minor, total_minor, buyer_name, requested_by)
         VALUES ($1, 'bank_transfer', 'FF-ABCD-EFGH', 'TND', 50000, 19, 9500, 59500, 'A', 'dev')`,
        [ACCOUNT],
      );
      await dataSource.query(`INSERT INTO ledger_accounts (type, currency) VALUES ('withholding_receivable', 'TND')`);
      await migrateDownTo(dataSource, BANK_TRANSFERS);

      await expect(dataSource.undoLastMigration({ transaction: 'each' })).rejects.toThrow(/violated by some row/);
      expect(await dataSource.query(`SELECT count(*)::int AS n FROM payments`)).toEqual([{ n: 1 }]); // nothing undone

      await withScratchDatabase(settings, 'ff_test', async (fresh) => {
        await fresh.runMigrations({ transaction: 'each' });
        await fresh.query(`INSERT INTO accounts (id, name, status, plan_id) VALUES ($1, 'A', 'active', 'beta')`, [ACCOUNT]);
        await fresh.query(
          `INSERT INTO payments (account_id, method, reference, currency, credit_minor, vat_percent, vat_minor, total_minor, buyer_name, requested_by)
           VALUES ($1, 'bank_transfer', 'FF-ABCD-EFGH', 'TND', 50000, 19, 9500, 59500, 'A', 'dev')`,
          [ACCOUNT],
        );

        await migrateDownTo(fresh, CREDIT_CONTROLS);

        expect(await fresh.query(`SELECT to_regclass('payments') AS t`)).toEqual([{ t: null }]);
        await expect(fresh.query(`INSERT INTO ledger_accounts (type, currency) VALUES ('withholding_receivable', 'TND')`)).rejects.toThrow(/violates check constraint/);
        await fresh.runMigrations({ transaction: 'each' });
        expect(await schemaDrift(fresh)).toEqual([]);
      });
    });
  });

  it("the credit-controls migration reverts with e-mails sent and an owner's shares, and the ledger stops notifying (P-33)", async () => {
    await withScratchDatabase(settings, 'ff_test', async (dataSource) => {
      await dataSource.runMigrations({ transaction: 'each' });
      await dataSource.query(`INSERT INTO accounts (id, name, status, plan_id, low_balance_percents) VALUES ($1, 'A', 'active', 'beta', '{80,20}')`, [ACCOUNT]);
      const posted = await new LedgerService(dataSource).grantCredit({ accountId: ACCOUNT, currency: 'TND', amountMinor: 5000n, kind: LedgerTransactionKind.PROMO, idempotencyKey: 'promo:1' });
      await dataSource.query(`INSERT INTO low_balance_notices (account_id, credit_transaction_id, percent, balance_minor) VALUES ($1, $2, 80, 4000)`, [ACCOUNT, posted.transaction.id]);

      await migrateDownTo(dataSource, RATING);

      const left = await dataSource.query(
        `SELECT to_regclass('low_balance_notices') AS t, (SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'accounts' AND column_name = 'low_balance_percents') AS c`,
      );
      expect(left).toEqual([{ t: null, c: 0 }]);
      expect(await ffFunctions(dataSource)).toEqual(['ff_check_ledger_transaction', 'ff_ensure_month_partition', 'ff_guard_price_book', 'ff_refuse_change']);

      await dataSource.runMigrations({ transaction: 'each' });
      expect(await schemaDrift(dataSource)).toEqual([]);
    });
  });

  it('the rating migration reverts with charges present; applied again, it refuses a price book that starts within an hour, naming it (P-32)', async () => {
    await withScratchDatabase(settings, 'ff_test', async (dataSource) => {
      await dataSource.runMigrations({ transaction: 'each' });
      await dataSource.query(`INSERT INTO accounts (id, name, status, plan_id) VALUES ($1, 'A', 'active', 'beta')`, [ACCOUNT]);
      const hour = `date_trunc('hour', now())`;
      await dataSource.query(`INSERT INTO rating_runs (hour, accounts, shadow) VALUES (${hour}, 1, true)`);
      await dataSource.query(
        `INSERT INTO usage_hourly (account_id, hour, function_id, price_book_id, on_demand_requests, on_demand_mb_ms, provisioned_requests, provisioned_mb_ms, provisioned_time_mb_ms, reserved_mb_ms)
         VALUES ($1, ${hour}, gen_random_uuid(), (SELECT id FROM price_books LIMIT 1), 1, 128, 0, 0, 0, 0)`,
        [ACCOUNT],
      );
      await dataSource.query(`INSERT INTO usage_charges (account_id, hour, currency, amount_minor, month_to_date_minor, shadow) VALUES ($1, ${hour}, 'TND', 0, 0, true)`, [ACCOUNT]);

      await migrateDownTo(dataSource, LEDGER);

      const tables = await dataSource.query(`SELECT to_regclass('usage_hourly') AS h, to_regclass('usage_charges') AS c, to_regclass('rating_runs') AS r`);
      expect(tables).toEqual([{ h: null, c: null, r: null }]);
      const [{ id }] = await dataSource.query(`INSERT INTO price_books (currency, valid_from, prices, created_by) VALUES ('TND', '2099-01-01T10:30:00Z', '{}', 'test') RETURNING id`);
      await expect(dataSource.runMigrations({ transaction: 'each' })).rejects.toThrow(
        `Price books must start at a whole hour, UTC, for the hourly rating (P-32), and these don't: ${id} (2099-01-01T10:30:00.000Z).`,
      );

      await dataSource.query(`DELETE FROM price_books WHERE id = $1`, [id]); // it hasn't started
      await dataSource.runMigrations({ transaction: 'each' });
      expect(await schemaDrift(dataSource)).toEqual([]);
    });
  });

  it('the ledger migration reverts with entries present, though its tables refuse every change but an insert (P-31)', async () => {
    await withScratchDatabase(settings, 'ff_test', async (dataSource) => {
      await dataSource.runMigrations({ transaction: 'each' });
      await dataSource.query(`INSERT INTO accounts (id, name, status, plan_id) VALUES ($1, 'A', 'active', 'beta')`, [ACCOUNT]);
      await new LedgerService(dataSource).grantCredit({ accountId: ACCOUNT, currency: 'TND', amountMinor: 5000n, kind: LedgerTransactionKind.PROMO, idempotencyKey: 'promo:1' });

      await migrateDownTo(dataSource, PRICE_BOOKS);

      const tables = await dataSource.query(`SELECT to_regclass('ledger_accounts') AS a, to_regclass('ledger_transactions') AS t, to_regclass('ledger_entries') AS e`);
      expect(tables).toEqual([{ a: null, t: null, e: null }]);
      expect(await ffFunctions(dataSource)).toEqual(['ff_ensure_month_partition', 'ff_guard_price_book', 'ff_refuse_change']);

      await dataSource.runMigrations({ transaction: 'each' });
      expect(await schemaDrift(dataSource)).toEqual([]);
    });
  });

  describe('after the migrations', () => {
    let db: ScratchDatabase;

    beforeAll(async () => {
      db = await createScratchDatabase(settings, 'ff_test');
      await db.dataSource.runMigrations({ transaction: 'each' });
      // Functions belong to accounts (P-12).
      await db.dataSource.getRepository(Account).save({ id: ACCOUNT, name: 'Test', planId: 'beta', status: AccountStatus.ACTIVE });
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
      const monthly = /^(usage_records|capacity_samples)_\d{4}_\d{2}$/; // their partitions, one per month (P-20, P-21)

      expect(tables.filter((table) => !monthly.test(table))).toEqual([
        'accounts',
        'alarms',
        'api_keys',
        'audit_log',
        'capacity_samples',
        'currencies',
        'custom_domains',
        'databases',
        'function_environments',
        'function_invocations',
        'function_metrics',
        'function_urls',
        'functions',
        'invitations',
        'invoice_counters',
        'invoice_lines',
        'invoice_notices',
        'invoices',
        'ledger_accounts',
        'ledger_entries',
        'ledger_transactions',
        'low_balance_notices',
        'memberships',
        'migrations',
        'notification_deliveries',
        'packages',
        'payments',
        'plans',
        'platform_settings',
        'price_books',
        'rate_limited_invocations',
        'rating_runs',
        'schedules',
        'tax_rates',
        'usage_charges',
        'usage_hourly',
        'usage_records',
        'users',
        'webhook_secrets',
      ]);
      expect(tables.filter((table) => monthly.test(table))).toEqual([
        monthPartition('capacity_samples', 0),
        monthPartition('capacity_samples', 1),
        usagePartition(0),
        usagePartition(1),
      ]);
      expect(rows.filter((row) => !/^[a-z][a-z0-9_]*$/.test(row.column_name))).toEqual([]);
      for (const table of ['functions', 'function_invocations', 'function_metrics', 'users', 'invitations', 'price_books', 'ledger_accounts', 'ledger_transactions', 'payments', 'notification_deliveries', 'alarms', 'packages']) {
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
          accountId: ACCOUNT,
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
        accountId: ACCOUNT,
        minInstances: 0,
        maxInstances: 3,
        scaleToZero: true,
        packageType: 'inline',
        handler: 'function.handler',
        codeSize: 42,
      });
      const [raw] = await db.dataSource.query(
        'SELECT account_id, min_instances, scale_to_zero, code_size FROM functions WHERE id = $1',
        [fn.id],
      );
      expect(raw).toEqual({ account_id: ACCOUNT, min_instances: 0, scale_to_zero: true, code_size: 42 });
    });

    it('deletes a function with its invocations and metrics, and keeps its usage records (P-20)', async () => {
      const functions = db.dataSource.getRepository(Function);
      const fn = await functions.save(
        functions.create({ name: 'doomed', accountId: ACCOUNT, runtime: Runtime.NODEJS, code: 'x', memory: 128, timeout: 5 }),
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

      await db.dataSource.query(
        `INSERT INTO usage_records (request_id, started_at, ended_at, account_id, function_id, function_name, runtime, memory_mb,
           duration_ms, billed_ms, status) VALUES (gen_random_uuid(), now(), now(), $1, $2, 'doomed', 'nodejs', 128, 2, 2, 'error')`,
        [ACCOUNT, fn.id],
      );

      await functions.delete(fn.id);

      const [counts] = await db.dataSource.query(
        `SELECT (SELECT count(*)::int FROM function_invocations WHERE function_id = $1) AS invocations,
                (SELECT count(*)::int FROM function_metrics WHERE function_id = $1) AS metrics,
                (SELECT count(*)::int FROM usage_records WHERE function_id = $1) AS usage`,
        [fn.id],
      );
      expect(counts).toEqual({ invocations: 0, metrics: 0, usage: 1 });
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
      expect(await ffFunctions(db.dataSource)).toEqual([]);
      expect(await pendingMigrations(db.dataSource)).toEqual(migrationNames);

      await db.dataSource.runMigrations({ transaction: 'each' });
      expect(await schemaDrift(db.dataSource)).toEqual([]);
    });
  });
});

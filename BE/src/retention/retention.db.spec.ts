/**
 * L2: what FF keeps only for a while, against a real PostgreSQL server, in a
 * scratch database dropped after:
 * - the invocation history: each account's kept for its plan's retention,
 *   then deleted; a call still running left to the lost-call reaper;
 * - a closed account's functions, with their code and history, its namespace
 *   and its logs, once its notice period has passed, through the real
 *   FunctionsService (the cluster and object storage are stand-ins).
 * Usage records are kept in both cases.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { FunctionInvocation } from '../functions/entities/function-invocation.entity';
import { Function, FunctionStatus, Runtime } from '../functions/entities/function.entity';
import { FunctionsService } from '../functions/functions.service';
import { LogStoreUnavailableError } from '../orchestrator/orchestrator.errors';
import { Orchestrator } from '../orchestrator/orchestrator.types';
import { Package, packageKey } from '../packages/package.entity';
import { PackagesService } from '../packages/packages.service';
import { BETA_LIMITS } from '../plans/test-fixtures';
import { UsageRecord } from '../usage/usage-record.entity';
import { UsageService } from '../usage/usage.service';
import { RetentionService } from './retention.service';
import { memoryEnvironments, noFunctionKeys, noPackages } from '../functions/test-fixtures';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const MINUTE = 60;
const DAY = 86_400;

run('what FF keeps only for a while (L2)', () => {
  let db: ScratchDatabase;
  let retention: RetentionService;
  let accounts = 0;
  // The cluster and object storage, as far as deleting goes. The functions' IDs are kept as given:
  // TypeORM clears an entity's ID once it has deleted its row.
  const removed: string[] = [];
  const orchestrator = {
    remove: jest.fn(async (fn: Function) => void removed.push(fn.id)),
    removeTenant: jest.fn(async (_accountId: string) => undefined),
    deleteLogs: jest.fn(async (_accountId: string) => undefined),
  };
  const objectStore = { deleteCode: jest.fn(async (_path: string) => undefined), deleteObject: jest.fn(async (_key: string) => undefined) };

  const query = <T = unknown>(sql: string, parameters?: unknown[]) => db.dataSource.query<T>(sql, parameters);

  /** An account on `planId`, with one function. */
  async function functionOn(planId: string): Promise<Function> {
    const id = `30000000${String(++accounts).padStart(4, '0')}`;
    await db.dataSource.getRepository(Account).save({ id, name: `Account ${accounts}`, planId, status: AccountStatus.ACTIVE });
    return db.dataSource.getRepository(Function).save({
      name: 'fn',
      accountId: id,
      runtime: Runtime.NODEJS,
      code: 'export const handler = async () => 1;',
      memory: 128,
      timeout: 5,
      status: FunctionStatus.ACTIVE,
    });
  }

  /** An invocation that started `secondsAgo` before the database's now, with its usage record. */
  async function invokedAgo(fn: Function, secondsAgo: number, status = 'COMPLETED'): Promise<string> {
    const [{ id }] = await query<Array<{ id: string }>>(
      `INSERT INTO function_invocations (function_id, input, output, status, created_at, updated_at)
       VALUES ($1, '{"name": "a user"}', '"hello"', $3, now() - make_interval(secs => $2), now() - make_interval(secs => $2)) RETURNING id`,
      [fn.id, secondsAgo, status],
    );
    await query(`SELECT ff_ensure_month_partition('usage_records', date_trunc('month', (now() - make_interval(secs => $1)) AT TIME ZONE 'UTC')::date)`, [secondsAgo]);
    await query(
      `INSERT INTO usage_records (request_id, started_at, ended_at, account_id, function_id, function_name, runtime, memory_mb, duration_ms, billed_ms, status)
       VALUES ($1, now() - make_interval(secs => $2), now() - make_interval(secs => $2), $3, $4, 'fn', 'nodejs', 128, 1, 1, 'success')`,
      [id, secondsAgo, fn.accountId, fn.id],
    );
    return id;
  }

  const kept = async () => (await query<Array<{ id: string }>>('SELECT id FROM function_invocations ORDER BY id')).map((row) => row.id).sort();
  const usageRecords = async () => (await query<Array<{ n: number }>>('SELECT count(*)::int AS n FROM usage_records'))[0].n;

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    await query(`INSERT INTO plans (id, name, limits) VALUES ('short', 'Short', $1)`, [JSON.stringify({ ...BETA_LIMITS, historyRetentionDays: 7 })]);
    const config = { get: (_key: string, fallback?: unknown) => fallback } as unknown as ConfigService;
    const audit = new AuditService(db.dataSource.getRepository(AuditEntry));
    const functions = new FunctionsService(
      db.dataSource.getRepository(Function),
      db.dataSource.getRepository(FunctionInvocation),
      objectStore as never,
      orchestrator as unknown as Orchestrator,
      config,
      { invocationStarted: () => undefined, invocationFinished: () => undefined, recordMetric: () => undefined } as never,
      {} as never, // no plans: deleting reads none
      audit,
      new UsageService(db.dataSource.getRepository(UsageRecord), db.dataSource, config),
      { admit: async () => undefined } as never,
      memoryEnvironments(),
      ...noPackages(),
      noFunctionKeys(),
    );
    const packages = new PackagesService(db.dataSource.getRepository(Package), objectStore as never, audit, { deleteImage: async () => undefined } as never);
    // An account without databases or buckets: deleting them asks no server, nor the store.
    retention = new RetentionService(db.dataSource, functions, packages, { deleteAll: async () => 0 } as never, { deleteAll: async () => 0 } as never, orchestrator as unknown as Orchestrator, audit, config);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await db?.drop();
  });

  beforeEach(async () => {
    await query('DELETE FROM function_invocations');
    jest.clearAllMocks();
    removed.length = 0;
  });

  describe("the invocation history's purge", () => {
  it("deletes each account's invocations past its own plan's retention, keeps the others and a call still running, and every usage record", async () => {
    const onBeta = await functionOn('beta'); // 30 days
    const onShort = await functionOn('short'); // 7 days
    const keep = [
      await invokedAgo(onBeta, 30 * DAY - MINUTE),
      await invokedAgo(onBeta, 10 * DAY),
      await invokedAgo(onBeta, 40 * DAY, 'RUNNING'), // the lost-call reaper's, whatever its age
      await invokedAgo(onShort, 7 * DAY - MINUTE),
      await invokedAgo(onShort, 0),
    ];
    for (const [fn, secondsAgo] of [[onBeta, 30 * DAY + MINUTE], [onBeta, 90 * DAY], [onShort, 7 * DAY + MINUTE], [onShort, 20 * DAY]] as const) {
      await invokedAgo(fn, secondsAgo, 'ERROR');
    }
    const records = await usageRecords();

    await expect(retention.purgeHistory()).resolves.toBe(4);

    expect(await kept()).toEqual(keep.sort());
    expect(await usageRecords()).toBe(records);
    await expect(retention.purgeHistory()).resolves.toBe(0); // a second pass finds nothing
  });

  it("deletes a batch at a time until none is left, and only the purged accounts' rows", async () => {
    const onShort = await functionOn('short');
    const other = await functionOn('beta');
    for (let i = 0; i < 5; i++) await invokedAgo(onShort, 8 * DAY + i);
    const untouched = await invokedAgo(other, 8 * DAY);

    await expect(retention.purgeHistory(undefined, 2)).resolves.toBe(5);

    expect(await kept()).toEqual([untouched]);
  });

  it("follows the account's plan: moved to a shorter retention, its older history goes at the next purge", async () => {
    const fn = await functionOn('beta');
    await invokedAgo(fn, 10 * DAY);
    const yesterday = await invokedAgo(fn, DAY);
    await expect(retention.purgeHistory()).resolves.toBe(0);

    await query(`UPDATE accounts SET plan_id = 'short' WHERE id = $1`, [fn.accountId]);

    await expect(retention.purgeHistory()).resolves.toBe(1);
    expect(await kept()).toEqual([yesterday]);
  });

  it('measures the retention back from the time it is given', async () => {
    const fn = await functionOn('short');
    const id = await invokedAgo(fn, DAY);
    const [{ now }] = await query<Array<{ now: Date }>>('SELECT now()');

    await expect(retention.purgeHistory(new Date(now.getTime() + 5 * DAY * 1000))).resolves.toBe(0);
    await expect(retention.purgeHistory(new Date(now.getTime() + 6 * DAY * 1000 + MINUTE * 1000))).resolves.toBe(1);
    expect(await kept()).not.toContain(id);
  });
  });

  describe("the notification deliveries' purge", () => {
    it('deletes the deliveries made more than 30 days before now, or before the time given', async () => {
      const [{ now }] = await query<Array<{ now: Date }>>('SELECT now()');
      const made = async (daysAgo: number) =>
        (
          await query<Array<{ id: string }>>(
            `INSERT INTO notification_deliveries (account_id, notification_id, kind, channel, target, payload, status, created_at)
             SELECT id, gen_random_uuid(), 'test', 'webhook', 'https://hooks.example.tn', '{}', 'failed', now() - make_interval(days => $1) FROM accounts LIMIT 1 RETURNING id`,
            [daysAgo],
          )
        )[0].id;
      const old = await made(31);
      const recent = await made(29);
      const left = async () => (await query<Array<{ id: string }>>('SELECT id FROM notification_deliveries WHERE id = ANY($1)', [[old, recent]])).map((row) => row.id);

      expect(await retention.purgeDeliveries()).toBeGreaterThanOrEqual(1);
      expect(await left()).toEqual([recent]);
      await retention.purgeDeliveries(new Date(now.getTime() + 2 * DAY * 1000));
      expect(await left()).toEqual([]);
    });
  });

  describe("closed accounts' data", () => {
    /** A closed account whose data is due `dueInSeconds` from now (past when negative): a Node.js and a Python function, each called. */
    async function closedAccount(dueInSeconds: number): Promise<{ id: string; functions: Function[] }> {
      const node = await functionOn('beta');
      const python = await db.dataSource.getRepository(Function).save({
        name: 'fn-py',
        accountId: node.accountId,
        runtime: Runtime.PYTHON,
        code: 'def handler(event, context):\n    return 1\n',
        memory: 128,
        timeout: 5,
        status: FunctionStatus.ACTIVE,
      });
      for (const fn of [node, python]) await invokedAgo(fn, DAY);
      await query(`UPDATE accounts SET status = 'closed', data_deletion_due_at = now() + make_interval(secs => $2) WHERE id = $1`, [node.accountId, dueInSeconds]);
      return { id: node.accountId, functions: [node, python] };
    }
    const count = async (sql: string, accountId: string) => (await query<Array<{ n: number }>>(sql, [accountId]))[0].n;
    const functionsOf = (accountId: string) => count('SELECT count(*)::int AS n FROM functions WHERE account_id = $1', accountId);
    const historyOf = (accountId: string) =>
      count('SELECT count(*)::int AS n FROM function_invocations i JOIN usage_records u ON u.request_id = i.id WHERE u.account_id = $1', accountId);
    const recordsOf = (accountId: string) => count('SELECT count(*)::int AS n FROM usage_records WHERE account_id = $1', accountId);
    /** A package the account uploaded: its SHA-256. */
    const packaged = async (accountId: string) => {
      const sha = Buffer.from(accountId.padEnd(32, '0')).toString('base64');
      await query(`INSERT INTO packages (account_id, code_sha256, code_size, unpacked_size, file_count, files) VALUES ($1, $2, 100, 200, 1, '{app.js}')`, [accountId, sha]);
      return sha;
    };
    const packagesOf = (accountId: string) => count('SELECT count(*)::int AS n FROM packages WHERE account_id = $1', accountId);
    const deletedAt = async (accountId: string) =>
      (await query<Array<{ at: Date | null }>>('SELECT data_deleted_at AS at FROM accounts WHERE id = $1', [accountId]))[0].at;
    /** A notification delivered to the account, and its webhook secret. */
    const notified = async (accountId: string) => {
      await query(
        `INSERT INTO notification_deliveries (account_id, notification_id, kind, channel, target, payload) VALUES ($1, gen_random_uuid(), 'test', 'webhook', 'https://hooks.example.tn', '{}')`,
        [accountId],
      );
      await query(`INSERT INTO webhook_secrets (account_id, secret) VALUES ($1, 'whsec_x')`, [accountId]);
      await query(
        `INSERT INTO alarms (account_id, name, metric, statistic, period, comparison, threshold, evaluation_periods, datapoints_to_alarm, actions)
         VALUES ($1, 'Low balance', 'Balance', 'Latest', 60, 'LessThanThreshold', 5, 1, 1, '{"email": true, "webhookUrls": []}')`,
        [accountId],
      );
    };
    const notificationsOf = async (accountId: string) => [
      await count('SELECT count(*)::int AS n FROM notification_deliveries WHERE account_id = $1', accountId),
      await count('SELECT count(*)::int AS n FROM webhook_secrets WHERE account_id = $1', accountId),
      await count('SELECT count(*)::int AS n FROM alarms WHERE account_id = $1', accountId),
    ];
    const auditOf = async (accountId: string) =>
      (await query<Array<{ action: string; actor: string; resource: string }>>('SELECT action, actor, resource FROM audit_log WHERE account_id = $1 ORDER BY id', [accountId])).map(
        (row) => `${row.action} ${row.actor} ${row.resource}`,
      );

    it("deletes a closed account's functions, with their code and history, its packages, its namespace, its logs and its notifications once its date has passed, keeps its usage records, and says so once", async () => {
      const due = await closedAccount(-MINUTE);
      const later = await closedAccount(DAY);
      const active = await functionOn('beta');
      await invokedAgo(active, DAY);
      for (const id of [due.id, later.id]) await notified(id);
      const [node, python] = due.functions;
      const sha = await packaged(due.id);
      await packaged(later.id);

      await expect(retention.deleteClosedAccounts()).resolves.toBe(1);

      expect([await functionsOf(due.id), await historyOf(due.id), await recordsOf(due.id)]).toEqual([0, 0, 2]);
      expect([await notificationsOf(due.id), await notificationsOf(later.id)]).toEqual([
        [0, 0, 0],
        [1, 1, 1],
      ]);
      expect(removed).toEqual([node.id, python.id]);
      expect(objectStore.deleteCode.mock.calls).toEqual([[`${node.id}/code.ts`], [`${python.id}/code.py`]]);
      expect([await packagesOf(due.id), await packagesOf(later.id), objectStore.deleteObject.mock.calls]).toEqual([0, 1, [[packageKey(due.id, sha)]]]);
      expect([orchestrator.removeTenant.mock.calls, orchestrator.deleteLogs.mock.calls]).toEqual([[[due.id]], [[due.id]]]);
      expect(Date.now() - ((await deletedAt(due.id)) as Date).getTime()).toBeLessThan(60_000);
      expect(await auditOf(due.id)).toEqual([
        `function.delete system function:${node.id}`,
        `function.delete system function:${python.id}`,
        `account.data_delete system account:${due.id}`,
      ]);
      // Not yet due, or not closed: untouched.
      expect([await functionsOf(later.id), await historyOf(later.id), await deletedAt(later.id)]).toEqual([2, 2, null]);
      expect([await functionsOf(active.accountId), await historyOf(active.accountId)]).toEqual([1, 1]);
      // Done once.
      await expect(retention.deleteClosedAccounts()).resolves.toBe(0);
      expect(orchestrator.removeTenant).toHaveBeenCalledTimes(1);
    });

    it('leaves an account whose logs could not be deleted for the next run, which finishes it and says so once', async () => {
      const due = await closedAccount(-MINUTE);
      orchestrator.deleteLogs.mockRejectedValueOnce(new LogStoreUnavailableError('The log store did not answer: connect ECONNREFUSED'));
      const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await expect(retention.deleteClosedAccounts()).resolves.toBe(0);

      expect([await functionsOf(due.id), await deletedAt(due.id)]).toEqual([0, null]);
      expect(errors).toHaveBeenCalledWith(`Could not delete the data of closed account ${due.id}; the next run tries again: The log store did not answer: connect ECONNREFUSED`);

      await expect(retention.deleteClosedAccounts()).resolves.toBe(1);

      expect(await deletedAt(due.id)).not.toBeNull();
      expect((await auditOf(due.id)).filter((entry) => entry.startsWith('account.data_delete'))).toHaveLength(1);
      expect(orchestrator.removeTenant).toHaveBeenCalledTimes(2); // the namespace asked again: nothing left to do
    });

    it('takes the earliest date first, and goes by the time it is given', async () => {
      const first = await closedAccount(-2 * DAY);
      const second = await closedAccount(-DAY);
      const [{ now }] = await query<Array<{ now: Date }>>('SELECT now()');

      await expect(retention.deleteClosedAccounts(new Date(now.getTime() - 3 * DAY * 1000))).resolves.toBe(0);
      await expect(retention.deleteClosedAccounts()).resolves.toBe(2);

      expect(orchestrator.removeTenant.mock.calls).toEqual([[first.id], [second.id]]);
    });
  });
});

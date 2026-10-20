/**
 * L2: the operator's gauges read from a real PostgreSQL server, in a scratch
 * database dropped after: how far the hourly rating is behind, how long ago
 * the alarm judged longest ago was judged, how many notifications wait to be
 * sent, and how many accounts' month doesn't reconcile.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { Currency } from '../billing/currency.entity';
import { PriceBook } from '../billing/price-book.entity';
import { PricingService } from '../billing/pricing.service';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { MonitoringService } from './monitoring.service';
import { alarmLagSeconds, deliveriesPending, ratingLagSeconds, reconciliationMismatches } from './operator-metrics';
import { valueOf } from './test-fixtures';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const HOUR = 3_600_000;
/** Next year: no book or rating of the migrations reaches it. */
const Y = new Date().getUTCFullYear() + 1;

run("the operator's gauges (L2)", () => {
  let db: ScratchDatabase;
  let monitoring: MonitoringService;
  const A = '700000000001';
  const B = '700000000002';
  const query = <T = unknown>(sql: string, parameters?: unknown[]) => db.dataSource.query<T>(sql, parameters);
  const gauges = async () => [await valueOf(ratingLagSeconds), await valueOf(alarmLagSeconds), await valueOf(deliveriesPending)];
  const alarm = (createdAt: Date, evaluatedAt: Date | null) =>
    query(
      `INSERT INTO alarms (account_id, name, metric, statistic, period, comparison, threshold, evaluation_periods, datapoints_to_alarm, actions, created_at, evaluated_at)
       VALUES ($1, 'Errors', 'Errors', 'Sum', 60, 'GreaterThanThreshold', 0, 1, 1, '{"email":false,"webhookUrls":[]}', $2, $3)`,
      [A, createdAt, evaluatedAt],
    );
  const delivery = (status: 'pending' | 'delivered' | 'failed') =>
    query(
      `INSERT INTO notification_deliveries (account_id, notification_id, kind, channel, target, payload, status, delivered_at)
       VALUES ($1, gen_random_uuid(), 'test', 'webhook', 'https://hooks.example.tn/ff', '{}', $2, $3)`,
      [A, status, status === 'delivered' ? new Date() : null],
    );
  const call = (accountId: string, startedAt: Date) =>
    query(
      `INSERT INTO usage_records (request_id, started_at, ended_at, account_id, function_id, function_name, runtime, memory_mb, duration_ms, billed_ms, status)
       VALUES (gen_random_uuid(), $1, $1, $2, $3, 'checkout', 'nodejs', 128, 10, 10, 'success')`,
      [startedAt, accountId, randomUUID()],
    );

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    for (const table of ['usage_records', 'capacity_samples']) await query('SELECT ff_ensure_month_partition($1, $2::date)', [table, `${Y}-03-01`]);
    for (const id of [A, B]) await db.dataSource.getRepository(Account).save({ id, name: `Account ${id}`, planId: 'beta', status: AccountStatus.ACTIVE });
    const pricing = new PricingService(db.dataSource.getRepository(PriceBook), db.dataSource.getRepository(Currency));
    monitoring = new MonitoringService(db.dataSource, pricing, {} as ConfigService);
    // The month's reconciliation is tested on its own, below.
    jest.spyOn(monitoring, 'reconcileMonth').mockResolvedValue(0);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await db?.drop();
  });

  it("count the rating's lag from the first book's start before any hour is rated, as the rating does; nothing judged, nothing pending", async () => {
    const [{ first }] = await query<Array<{ first: Date }>>(`SELECT min(valid_from) AS first FROM price_books`);
    const now = new Date(first.getTime() + 5 * HOUR + 90_000);

    await monitoring.refresh(now);

    expect(await gauges()).toEqual([5 * 3600 + 90, 0, 0]);
  });

  it('then from the end of the last hour rated; the alarm judged longest ago, or created and never judged; the deliveries still to send', async () => {
    const now = new Date();
    const hour = new Date(Math.floor(now.getTime() / HOUR) * HOUR - 2 * HOUR); // ended an hour ago
    await query(`INSERT INTO rating_runs (hour, accounts, shadow) VALUES ($1, 0, true), ($2, 0, true)`, [new Date(hour.getTime() - HOUR), hour]);
    await alarm(new Date(now.getTime() - 3_600_000), new Date(now.getTime() - 50_000));
    await alarm(new Date(now.getTime() - 70_000), null); // waiting for its first evaluation
    await alarm(new Date(now.getTime() - 3_600_000), new Date(now.getTime() - 10_000));
    for (const status of ['pending', 'pending', 'delivered', 'failed'] as const) await delivery(status);

    await monitoring.refresh(now);

    expect(await gauges()).toEqual([(now.getTime() - (hour.getTime() + HOUR)) / 1000, 70, 2]);
  });

  describe("the month's reconciliation", () => {
    beforeAll(() => jest.restoreAllMocks());

    it("finds nothing to reconcile before the month's first hour is rated", async () => {
      await call(A, new Date(`${Y}-03-01T04:10:00Z`));

      expect(await monitoring.reconcileMonth(new Date(`${Y}-03-01T07:00:00Z`))).toBe(0);
      expect(await valueOf(reconciliationMismatches)).toBe(0);
    });

    it('counts each account whose charges and usage differ: a call recorded after its hour was rated', async () => {
      // 04:00 was rated without the call, which reached the database later; B had no call.
      await query(`INSERT INTO rating_runs (hour, accounts, shadow) VALUES ($1, 0, true)`, [new Date(`${Y}-03-01T04:00:00Z`)]);

      expect(await monitoring.reconcileMonth(new Date(`${Y}-03-01T07:00:00Z`))).toBe(1);
      expect(await valueOf(reconciliationMismatches)).toBe(1);
    });

    it('keeps the last count when it cannot reconcile, and says so', async () => {
      const broken = new MonitoringService({ query: () => Promise.reject(new Error('canceling statement due to statement timeout')) } as never, {} as PricingService, {} as ConfigService);
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      expect(await broken.reconcileMonth(new Date(`${Y}-03-01T07:00:00Z`))).toBe(-1);
      expect(await valueOf(reconciliationMismatches)).toBe(1);
      expect(logged).toHaveBeenCalledWith("Could not reconcile the month for the operator's metrics: canceling statement due to statement timeout");
    });
  });
});

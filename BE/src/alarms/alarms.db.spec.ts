/**
 * L2: alarms against a real PostgreSQL server, in a scratch database dropped
 * after: an account's alarms and their audit entries, what they refuse, and
 * the evaluator, from usage records written here, through the notifications'
 * queue: an error alarm that fires and recovers, telling each change once;
 * missing data; an account's alarm; the money; a database's and a cache's,
 * from their hourly samples; the account's mail's, from its messages; two
 * backends at once.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { Membership } from '../accounts/entities/membership.entity';
import { User } from '../accounts/entities/user.entity';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import type { BillingService } from '../billing/billing.service';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { monthPartitions } from '../usage/usage.service';
import { Function, FunctionStatus, Runtime } from '../functions/entities/function.entity';
import { CustomerMetricsService } from '../metrics/customer-metrics.service';
import { alarmChanges, alarmEvaluations } from '../monitoring/operator-metrics';
import { valueOf } from '../monitoring/test-fixtures';
import { DeliveryChannel, NotificationDelivery } from '../notifications/entities/notification-delivery.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Alarm } from './alarm.entity';
import { AlarmEvaluator } from './alarm-evaluator.service';
import { MAX_ALARMS } from './alarm-rules';
import { AlarmDto } from './alarms.dto';
import { AlarmsService } from './alarms.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const A = '900000000001';
const B = '900000000002';

run('alarms (L2)', () => {
  let db: ScratchDatabase;
  let alarms: AlarmsService;
  let evaluator: AlarmEvaluator;
  let notifications: NotificationsService;
  let f: Function;
  let quiet: Function;
  let g: Function;
  let money = { balance: '2.500', charged: '1.000' };
  const config = {
    getOrThrow: (key: string) =>
      key === 'alarms' ? { intervalSeconds: 60, settleSeconds: 0 } : key === 'mail' ? { consoleUrl: 'https://console.ff.example' } : { intervalSeconds: 10, allowPrivate: false },
  } as unknown as ConfigService;

  const query = <T = unknown>(sql: string, parameters?: unknown[]) => db.dataSource.query<T>(sql, parameters);
  const fn = (accountId: string, name: string) =>
    db.dataSource.getRepository(Function).save({ name, accountId, runtime: Runtime.NODEJS, code: 'x', memory: 128, timeout: 5, status: FunctionStatus.ACTIVE });
  /** A call of the function, started at the time. */
  const call = (fnc: Function, at: string, status = 'success', durationMs = 10) =>
    query(
      `INSERT INTO usage_records (request_id, started_at, ended_at, account_id, function_id, function_name, runtime, memory_mb, duration_ms, billed_ms, status)
       VALUES (gen_random_uuid(), $1, $1, $2, $3, $4, 'nodejs', 128, $5, ceil($5::numeric)::int, $6)`,
      [at, fnc.accountId, fnc.id, fnc.name, durationMs, status],
    );
  const alarm = (change: Partial<AlarmDto> = {}): AlarmDto => ({
    name: 'Errors',
    functionId: f.id,
    metric: 'Errors',
    statistic: 'Sum',
    period: 60,
    comparison: 'GreaterThanThreshold',
    threshold: 0,
    evaluationPeriods: 1,
    datapointsToAlarm: 1,
    actions: { email: true, webhookUrls: ['https://hooks.example.tn/ff'] },
    ...change,
  });
  const stateOf = (id: string) => db.dataSource.getRepository(Alarm).findOneByOrFail({ id });
  const toldOf = async (id: string) =>
    (await db.dataSource.getRepository(NotificationDelivery).find({ where: { kind: 'alarm' }, order: { createdAt: 'ASC', channel: 'ASC' } }))
      .filter((d) => d.channel === DeliveryChannel.EMAIL || (d.payload as { data: { alarm: { id: string } } }).data.alarm.id === id)
      .map((d) => (d.channel === DeliveryChannel.EMAIL ? `email ${(d.payload as { subject: string }).subject}` : `webhook ${(d.payload as { data: { previousState: string; state: string } }).data.previousState}>${(d.payload as { data: { state: string } }).data.state}`));
  let databases = 0;
  /** A customer's database of the account, as its row: the server isn't asked here. */
  const database = async (accountId: string, name: string) =>
    (
      await query<Array<{ id: string }>>(`INSERT INTO databases (account_id, name, db_name, status) VALUES ($1, $2, $3, 'active') RETURNING id`, [
        accountId,
        `${name}-${++databases}`,
        `ff_${String(databases).padStart(24, '0')}`,
      ])
    )[0].id;
  let buckets = 0;
  /** A customer's bucket of the account, as its row: the store isn't asked here. Answers its name. */
  const bucket = async (accountId: string, name: string) => {
    const unique = `${name}-${++buckets}`;
    await query(`INSERT INTO buckets (account_id, name, store_name) VALUES ($1, $2, $3)`, [accountId, unique, `ff-${String(buckets).padStart(24, '0')}`]);
    return unique;
  };
  let queues = 0;
  /** A customer's queue of the account, as its row. Answers its ID and name. */
  const queue = async (accountId: string, name: string) => {
    const unique = `${name}-${++queues}`;
    const [{ id }] = await query<Array<{ id: string }>>(`INSERT INTO queues (account_id, name, kind) VALUES ($1, $2, 'customer') RETURNING id`, [accountId, unique]);
    return { id, name: unique };
  };
  let caches = 0;
  /** A customer's cache of the account, as its row: the server isn't asked here. Answers its ID and name. */
  const cache = async (accountId: string, name: string) => {
    const unique = `${name}-${++caches}`;
    const [{ id }] = await query<Array<{ id: string }>>(
      `INSERT INTO caches (account_id, name, server_name, port, memory_mb, status, password_sha256) VALUES ($1, $2, $3, $4, 64, 'active', repeat('0', 64)) RETURNING id`,
      [accountId, unique, `ffc-${String(caches).padStart(12, '0')}`, 6400 + caches],
    );
    return { id, name: unique };
  };
  /** Only the deliveries of the alarm a test makes: each test clears those before it. */
  const clearDeliveries = () => query(`DELETE FROM notification_deliveries`);

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    await monthPartitions(db.dataSource, ['2026-10']);
    for (const [id, name] of [[A, 'Alarmed'], [B, 'Other']]) await db.dataSource.getRepository(Account).save({ id, name, planId: 'beta', status: AccountStatus.ACTIVE });
    const owner = await db.dataSource.getRepository(User).save({ oidcSub: 'kc-alarm-owner', email: 'owner@ff.test', name: null, locale: 'fr-TN' }); // the e-mails in the owner's language
    await db.dataSource.getRepository(Membership).save({ accountId: A, userId: owner.id, role: 'owner' });
    const audit = new AuditService(db.dataSource.getRepository(AuditEntry));
    alarms = new AlarmsService(db.dataSource, audit);
    notifications = new NotificationsService(db.dataSource, audit, config);
    const billing = { balance: async () => money } as unknown as BillingService;
    evaluator = new AlarmEvaluator(db.dataSource, new CustomerMetricsService(db.dataSource), billing, notifications, config);
    f = await fn(A, 'checkout');
    quiet = await fn(A, 'quiet');
    g = await fn(B, 'other');
  });

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await clearDeliveries();
    await query(`DELETE FROM alarms`);
  });

  describe("an account's alarms", () => {
    it('are created, listed, read, replaced and deleted by their account only, each change in its audit log', async () => {
      const created = await alarms.create(A, alarm({ name: '  Checkout errors ' }));

      expect(created).toMatchObject({ name: 'Checkout errors', functionId: f.id, treatMissingData: 'missing', state: 'INSUFFICIENT_DATA', stateReason: null, evaluatedAt: null });
      expect([(await alarms.list(A)).map((a) => a.id), await alarms.list(B)]).toEqual([[created.id], []]);
      await expect(alarms.get(B, created.id)).rejects.toThrow(new NotFoundException(`Alarm ${created.id} not found`));
      await expect(alarms.update(B, created.id, alarm())).rejects.toThrow(NotFoundException);

      const replaced = await alarms.update(A, created.id, alarm({ name: 'Checkout errors', threshold: 10, treatMissingData: 'notBreaching' }));
      expect(replaced).toMatchObject({ threshold: 10, treatMissingData: 'notBreaching' });
      await alarms.remove(A, created.id);
      await expect(alarms.get(A, created.id)).rejects.toThrow(NotFoundException);

      const entries = await db.dataSource.getRepository(AuditEntry).find({ where: { accountId: A, resource: `alarm:${created.id}` }, order: { id: 'ASC' } });
      expect(entries.map((e) => [e.action, e.details])).toEqual([
        ['alarm.create', expect.objectContaining({ name: 'Checkout errors', metric: 'Errors', threshold: 0 })],
        ['alarm.update', { name: 'Checkout errors', changes: { threshold: { from: 0, to: 10 }, treatMissingData: { from: 'missing', to: 'notBreaching' } } }],
        ['alarm.delete', { name: 'Checkout errors', metric: 'Errors' }],
      ]);
    });

    it("refuse another account's function, a rule that can't be, a webhook that wouldn't go, and one alarm too many", async () => {
      await expect(alarms.create(A, alarm({ functionId: g.id }))).rejects.toThrow(new NotFoundException(`Function with ID ${g.id} not found`));
      await expect(alarms.create(A, alarm({ statistic: 'p95' }))).rejects.toThrow(new BadRequestException('Errors has the statistic Sum, not p95'));
      await expect(alarms.create(A, alarm({ actions: { email: false, webhookUrls: ['ftp://example.tn'] } }))).rejects.toThrow('webhookUrl must be an http or https URL');
      for (let i = 0; i < MAX_ALARMS; i++) await alarms.create(A, alarm({ name: `Alarm ${i}` }));
      await expect(alarms.create(A, alarm())).rejects.toThrow(new BadRequestException(`An account has at most ${MAX_ALARMS} alarms`));
      expect(await alarms.list(B)).toEqual([]);
    });

    it("go with their function", async () => {
      const doomed = await fn(A, 'doomed');
      const watching = await alarms.create(A, alarm({ functionId: doomed.id }));
      await db.dataSource.getRepository(Function).delete({ id: doomed.id });
      await expect(alarms.get(A, watching.id)).rejects.toThrow(NotFoundException);
    });

    it("watch the account's own database, an hour at a time, and go with it", async () => {
      const mine = await database(A, 'orders');
      const theirs = await database(B, 'orders');
      const sessions = alarm({ functionId: null, databaseId: mine, metric: 'DatabaseConnections', statistic: 'Maximum', period: 3600 });

      const watching = await alarms.create(A, sessions);
      expect(watching).toMatchObject({ functionId: null, databaseId: mine, metric: 'DatabaseConnections', period: 3600 });
      await expect(alarms.create(A, { ...sessions, databaseId: theirs })).rejects.toThrow(new NotFoundException(`Database ${theirs} not found`));
      await expect(alarms.create(A, { ...sessions, period: 60 })).rejects.toThrow(new BadRequestException("A database's metrics have a point an hour: period must be 3600"));
      await query(`DELETE FROM databases WHERE id = $1`, [mine]);
      await expect(alarms.get(A, watching.id)).rejects.toThrow(NotFoundException);
    });

    it("watch the account's own bucket, by its name, and go with it", async () => {
      const mine = await bucket(A, 'photos');
      const theirs = await bucket(B, 'photos');
      const errors = alarm({ functionId: null, bucketName: mine, metric: '5xxErrors', statistic: 'Sum', period: 300 });

      const watching = await alarms.create(A, errors);
      expect(watching).toMatchObject({ functionId: null, databaseId: null, bucketName: mine, metric: '5xxErrors', period: 300 });
      expect((await alarms.list(A)).map((listed) => listed.bucketName)).toEqual([mine]);
      await expect(alarms.create(A, { ...errors, bucketName: theirs })).rejects.toThrow(new NotFoundException(`The account has no bucket ${theirs}`));
      await expect(alarms.create(A, { ...errors, metric: 'Errors' })).rejects.toThrow(BadRequestException);
      expect(await alarms.update(A, watching.id, { ...errors, metric: 'BucketSizeBytes', statistic: 'Average', threshold: 1e9 })).toMatchObject({ bucketName: mine, metric: 'BucketSizeBytes' });
      await query(`DELETE FROM buckets WHERE name = $1`, [mine]);
      await expect(alarms.get(A, watching.id)).rejects.toThrow(NotFoundException);
    });

    it("watch the account's own queue, by its name, and go with it", async () => {
      const mine = await queue(A, 'orders-dlq');
      const theirs = await queue(B, 'orders-dlq');
      const waiting = alarm({ functionId: null, queueName: mine.name, metric: 'ApproximateNumberOfMessagesVisible', statistic: 'Maximum', period: 60 });

      const watching = await alarms.create(A, waiting);
      expect(watching).toMatchObject({ functionId: null, databaseId: null, bucketName: null, queueName: mine.name, metric: 'ApproximateNumberOfMessagesVisible' });
      expect((await alarms.list(A)).map((listed) => listed.queueName)).toEqual([mine.name]);
      await expect(alarms.create(A, { ...waiting, queueName: theirs.name })).rejects.toThrow(new NotFoundException(`The account has no queue ${theirs.name}`));
      await expect(alarms.create(A, { ...waiting, metric: 'Errors', statistic: 'Sum' })).rejects.toThrow(BadRequestException);
      expect(await alarms.update(A, watching.id, { ...waiting, metric: 'ApproximateAgeOfOldestMessage', threshold: 600 })).toMatchObject({ queueName: mine.name, metric: 'ApproximateAgeOfOldestMessage' });
      await query(`DELETE FROM queues WHERE id = $1`, [mine.id]);
      await expect(alarms.get(A, watching.id)).rejects.toThrow(NotFoundException);
    });

    it("watch the account's own cache, by its name, an hour at a time, and go with it", async () => {
      const mine = await cache(A, 'sessions');
      const theirs = await cache(B, 'sessions');
      const full = alarm({ functionId: null, cacheName: mine.name, metric: 'BytesUsedForCache', statistic: 'Maximum', period: 3600 });

      const watching = await alarms.create(A, full);
      expect(watching).toMatchObject({ functionId: null, databaseId: null, bucketName: null, queueName: null, cacheName: mine.name, metric: 'BytesUsedForCache' });
      expect((await alarms.list(A)).map((listed) => listed.cacheName)).toEqual([mine.name]);
      await expect(alarms.create(A, { ...full, cacheName: theirs.name })).rejects.toThrow(new NotFoundException(`The account has no cache ${theirs.name}`));
      await expect(alarms.create(A, { ...full, period: 60 })).rejects.toThrow(new BadRequestException("A cache's metrics have a point an hour: period must be 3600"));
      expect(await alarms.update(A, watching.id, { ...full, metric: 'Evictions', statistic: 'Sum' })).toMatchObject({ cacheName: mine.name, metric: 'Evictions' });
      await query(`DELETE FROM caches WHERE id = $1`, [mine.id]);
      await expect(alarms.get(A, watching.id)).rejects.toThrow(NotFoundException);
    });
  });

  describe('the evaluator', () => {
    it('fires an error alarm and recovers it, each change told once, to the e-mail and the webhook', async () => {
      const watching = await alarms.create(A, alarm({ name: 'Checkout errors' }));
      const counted = async () => ({
        evaluated: await valueOf(alarmEvaluations),
        alarm: await valueOf(alarmChanges, { state: 'ALARM' }),
        ok: await valueOf(alarmChanges, { state: 'OK' }),
        insufficient: await valueOf(alarmChanges, { state: 'INSUFFICIENT_DATA' }),
      });
      const before = await counted();
      await call(f, '2026-10-20T10:00:30Z', 'error');
      await call(f, '2026-10-20T10:00:40Z', 'success');

      await evaluator.tick(new Date('2026-10-20T10:01:05Z'));
      const fired = await stateOf(watching.id);
      expect(fired).toMatchObject({ state: 'ALARM', stateChangedAt: new Date('2026-10-20T10:01:05Z'), stateReason: '1 of the last 1 period(s) of 60 s breaching Errors Sum > 0 (1 needed); latest 1' });
      expect(await toldOf(watching.id)).toEqual(['email ALARME : « Checkout errors » (Alarmed)', 'webhook INSUFFICIENT_DATA>ALARM']);

      await evaluator.tick(new Date('2026-10-20T10:02:05Z')); // 10:01 had no error
      expect((await stateOf(watching.id)).state).toBe('OK');
      await evaluator.tick(new Date('2026-10-20T10:03:05Z')); // still OK: nothing more told
      expect(await toldOf(watching.id)).toEqual([
        'email ALARME : « Checkout errors » (Alarmed)',
        'webhook INSUFFICIENT_DATA>ALARM',
        'email OK : « Checkout errors » (Alarmed)',
        'webhook ALARM>OK',
      ]);
      // The operator's metrics: three evaluations, two changes of state.
      const after = await counted();
      expect({ evaluated: after.evaluated - before.evaluated, alarm: after.alarm - before.alarm, ok: after.ok - before.ok, insufficient: after.insufficient - before.insufficient }).toEqual({
        evaluated: 3,
        alarm: 1,
        ok: 1,
        insufficient: 0,
      });
      const [webhook] = await db.dataSource.getRepository(NotificationDelivery).find({ where: { channel: DeliveryChannel.WEBHOOK, kind: 'alarm' }, order: { createdAt: 'ASC' } });
      expect((webhook.payload as { data: Record<string, unknown> }).data).toMatchObject({
        alarm: { id: watching.id, name: 'Checkout errors', functionId: f.id, metric: 'Errors', statistic: 'Sum', threshold: 0 },
        previousState: 'INSUFFICIENT_DATA',
        state: 'ALARM',
        latest: 1,
        datapoints: [1],
        at: '2026-10-20T10:01:05.000Z',
      });
    });

    it('waits for the settling time before judging a period, so that a call ending late still counts', async () => {
      const settled = new AlarmEvaluator(db.dataSource, new CustomerMetricsService(db.dataSource), {} as BillingService, notifications, {
        getOrThrow: (key: string) => (key === 'alarms' ? { intervalSeconds: 60, settleSeconds: 60 } : { consoleUrl: 'x' }),
      } as unknown as ConfigService);
      const watching = await alarms.create(A, alarm({ actions: { email: false, webhookUrls: [] } }));
      await call(f, '2026-10-20T11:00:30Z', 'error');

      await settled.tick(new Date('2026-10-20T11:01:05Z')); // judges 10:59, not 11:00 yet
      expect((await stateOf(watching.id)).state).toBe('OK');
      await settled.tick(new Date('2026-10-20T11:02:05Z'));
      expect((await stateOf(watching.id)).state).toBe('ALARM');
    });

    it('treats a period without a datapoint as the alarm says, and tells nothing for INSUFFICIENT_DATA', async () => {
      const missing = await alarms.create(A, alarm({ functionId: quiet.id, metric: 'Duration', statistic: 'p95', threshold: 100, evaluationPeriods: 2 }));
      const notBreaching = await alarms.create(A, alarm({ functionId: quiet.id, metric: 'Duration', statistic: 'p95', threshold: 100, evaluationPeriods: 2, treatMissingData: 'notBreaching' }));
      const breaching = await alarms.create(A, alarm({ functionId: quiet.id, metric: 'Duration', statistic: 'p95', threshold: 100, evaluationPeriods: 2, treatMissingData: 'breaching', actions: { email: false, webhookUrls: [] } }));

      await evaluator.tick(new Date('2026-10-20T12:05:05Z'));

      expect([(await stateOf(missing.id)).state, (await stateOf(notBreaching.id)).state, (await stateOf(breaching.id)).state]).toEqual(['INSUFFICIENT_DATA', 'OK', 'ALARM']);
      expect((await stateOf(missing.id)).stateReason).toBe('No datapoint for Duration p95 in the last 2 period(s) of 60 s');
      expect(await toldOf(missing.id)).toEqual([]);
    });

    it("judges an account's alarm on all its functions together, and none of another account's", async () => {
      const busy = await alarms.create(A, alarm({ functionId: null, metric: 'Invocations', threshold: 3, comparison: 'GreaterThanOrEqualToThreshold', actions: { email: false, webhookUrls: [] } }));
      await call(f, '2026-10-20T13:00:10Z');
      await call(quiet, '2026-10-20T13:00:20Z');
      await call(g, '2026-10-20T13:00:30Z');
      await call(g, '2026-10-20T13:00:31Z');

      await evaluator.tick(new Date('2026-10-20T13:01:05Z'));
      expect((await stateOf(busy.id)).state).toBe('OK'); // 2 of A's: B's 2 don't count
      await call(quiet, '2026-10-20T13:01:20Z');
      await call(quiet, '2026-10-20T13:01:21Z');
      await call(f, '2026-10-20T13:01:22Z');
      await evaluator.tick(new Date('2026-10-20T13:02:05Z'));
      expect((await stateOf(busy.id)).state).toBe('ALARM');
    });

    it('reads the money as it is: a low balance fires, and recovers once credit comes', async () => {
      const low = await alarms.create(A, alarm({ functionId: null, metric: 'Balance', statistic: 'Latest', comparison: 'LessThanThreshold', threshold: 5, actions: { email: true, webhookUrls: [] } }));
      const spend = await alarms.create(A, alarm({ functionId: null, metric: 'MonthToDateCharges', statistic: 'Latest', threshold: 1, actions: { email: false, webhookUrls: [] } }));
      money = { balance: '2.500', charged: '1.000' };

      await evaluator.tick(new Date('2026-10-20T14:00:05Z'));
      expect([(await stateOf(low.id)).state, (await stateOf(low.id)).stateReason, (await stateOf(spend.id)).state]).toEqual(['ALARM', 'Balance is 2.5: breaching Balance < 5', 'OK']);
      money = { balance: '12.500', charged: '1.250' };
      await evaluator.tick(new Date('2026-10-20T14:01:05Z'));
      expect([(await stateOf(low.id)).state, (await stateOf(spend.id)).state]).toEqual(['OK', 'ALARM']);
      expect(await toldOf(low.id)).toEqual(['email ALARME : « Errors » (Alarmed)', 'email OK : « Errors » (Alarmed)']);
    });

    it("fires on a database's storage from its hourly samples, the e-mail naming the database, and recovers once it is smaller", async () => {
      const orders = await database(A, 'orders');
      const big = await alarms.create(
        A,
        alarm({ name: 'Storage', functionId: null, databaseId: orders, metric: 'VolumeBytesUsed', statistic: 'Maximum', period: 3600, threshold: 800_000_000, actions: { email: true, webhookUrls: [] } }),
      );
      await query(`INSERT INTO database_samples (database_id, hour, account_id, name, size_bytes, connections) VALUES ($1, '2026-10-20T15:00:00Z', $2, 'orders', 900000000, 3)`, [orders, A]);

      // The hour 15:00 is judged once it is over: at 16:00, the settling time here being nothing.
      await evaluator.tick(new Date('2026-10-20T15:30:00Z'));
      expect((await stateOf(big.id)).state).toBe('INSUFFICIENT_DATA');
      await evaluator.tick(new Date('2026-10-20T16:00:05Z'));
      expect([(await stateOf(big.id)).state, (await stateOf(big.id)).stateReason]).toEqual([
        'ALARM',
        '1 of the last 1 period(s) of 3600 s breaching VolumeBytesUsed Maximum > 800000000 (1 needed); latest 900000000',
      ]);
      const [told] = await db.dataSource.getRepository(NotificationDelivery).find({ where: { kind: 'alarm', channel: DeliveryChannel.EMAIL } });
      expect((told.payload as { text: string }).text).toMatch(/sur la base de données « orders-\d+ » du compte « Alarmed »/);

      await query(`INSERT INTO database_samples (database_id, hour, account_id, name, size_bytes, connections) VALUES ($1, '2026-10-20T16:00:00Z', $2, 'orders', 700000000, 3)`, [orders, A]);
      await evaluator.tick(new Date('2026-10-20T17:00:05Z'));
      expect((await stateOf(big.id)).state).toBe('OK');
    });

    it("fires on the account's mail's bounces from its messages, an hour at a time, the e-mail naming its mail, and names no resource", async () => {
      const full = alarm({ name: 'Bounces', functionId: null, metric: 'Bounce', statistic: 'Sum', period: 3600, threshold: 1, actions: { email: true, webhookUrls: [] } });
      await expect(alarms.create(A, { ...full, cacheName: 'sessions' })).rejects.toThrow(
        new BadRequestException("A cacheName goes with a cache's metrics only: BytesUsedForCache, CurrConnections, CacheHits, CacheMisses, Evictions"),
      );
      await expect(alarms.create(A, { ...full, period: 300 })).rejects.toThrow(new BadRequestException("Mail's metrics have a point an hour: period must be 3600"));
      const watching = await alarms.create(A, full);
      await query(
        `INSERT INTO email_messages (id, account_id, identity, from_address, return_path, recipients, recipient_count, size_bytes, status, created_at)
         VALUES (gen_random_uuid(), $1, 'shop.example.tn', 'orders@shop.example.tn', 'b-0@bounces.mail.ff.test', $2, 3, 1000, 'SENT', '2026-10-20T15:10:00Z')`,
        [A, JSON.stringify([{ address: 'a@example.tn', status: 'BOUNCED', permanent: true }, { address: 'b@example.tn', status: 'SUPPRESSED' }, { address: 'c@example.tn', status: 'SENT' }])],
      );

      // The hour 15:00 is judged once it is over: 2 bounces, past 1.
      await evaluator.tick(new Date('2026-10-20T16:00:05Z'));
      expect([(await stateOf(watching.id)).state, (await stateOf(watching.id)).stateReason]).toEqual([
        'ALARM',
        '1 of the last 1 period(s) of 3600 s breaching Bounce Sum > 1 (1 needed); latest 2',
      ]);
      const told = await db.dataSource.getRepository(NotificationDelivery).find({ where: { kind: 'alarm', channel: DeliveryChannel.EMAIL } });
      expect(told.map((one) => (one.payload as { text: string }).text).find((text) => text.includes('Bounces'))).toMatch(/sur le courrier du compte « Alarmed »/);

      // A quiet hour counts none: the alarm is back to OK.
      await evaluator.tick(new Date('2026-10-20T17:00:05Z'));
      expect((await stateOf(watching.id)).state).toBe('OK');
    });

    it("fires on a cache's memory from its hourly samples, the e-mail naming the cache, and recovers once its keys use less", async () => {
      const sessions = await cache(A, 'sessions');
      const full = await alarms.create(
        A,
        alarm({ name: 'Memory', functionId: null, cacheName: sessions.name, metric: 'BytesUsedForCache', statistic: 'Maximum', period: 3600, threshold: 60_000_000, actions: { email: true, webhookUrls: [] } }),
      );
      const sample = (hour: string, bytesUsed: number) =>
        query(
          `INSERT INTO cache_samples (cache_id, hour, account_id, name, memory_mb, bytes_used, connections, hits, misses, evictions, process_started_at)
           VALUES ($1, $2, $3, 'sessions', 64, $4, 2, 0, 0, 0, '2026-10-20T00:00:00Z')`,
          [sessions.id, hour, A, bytesUsed],
        );
      await sample('2026-10-20T15:00:00Z', 63_000_000);

      // The hour 15:00 is judged once it is over, as a database's.
      await evaluator.tick(new Date('2026-10-20T16:00:05Z'));
      expect([(await stateOf(full.id)).state, (await stateOf(full.id)).stateReason]).toEqual([
        'ALARM',
        '1 of the last 1 period(s) of 3600 s breaching BytesUsedForCache Maximum > 60000000 (1 needed); latest 63000000',
      ]);
      const [told] = await db.dataSource.getRepository(NotificationDelivery).find({ where: { kind: 'alarm', channel: DeliveryChannel.EMAIL } });
      expect((told.payload as { text: string }).text).toMatch(/sur le cache « sessions-\d+ » du compte « Alarmed »/);

      await sample('2026-10-20T16:00:00Z', 2_000_000);
      await evaluator.tick(new Date('2026-10-20T17:00:05Z'));
      expect((await stateOf(full.id)).state).toBe('OK');
    });

    it("fires on a bucket's errors from the front door's counts, the e-mail naming the bucket, and recovers on a quiet period", async () => {
      const photos = await bucket(A, 'photos');
      const [{ id }] = await query<Array<{ id: string }>>(`SELECT id FROM buckets WHERE name = $1`, [photos]);
      const failing = await alarms.create(
        A,
        alarm({ name: 'Store errors', functionId: null, bucketName: photos, metric: '5xxErrors', statistic: 'Sum', period: 60, threshold: 2, actions: { email: true, webhookUrls: [] } }),
      );
      await query(
        `INSERT INTO storage_request_counts (bucket_id, minute, class, writer, account_id, name, requests, gets, puts, errors4xx, errors5xx, bytes_in, bytes_out)
         VALUES ($1, '2026-10-20T15:00:00Z', 'tier2', gen_random_uuid(), $2, $3, 5, 5, 0, 0, 3, 0, 0)`,
        [id, A, photos],
      );

      await evaluator.tick(new Date('2026-10-20T15:01:05Z'));
      expect([(await stateOf(failing.id)).state, (await stateOf(failing.id)).stateReason]).toEqual([
        'ALARM',
        '1 of the last 1 period(s) of 60 s breaching 5xxErrors Sum > 2 (1 needed); latest 3',
      ]);
      const [told] = await db.dataSource.getRepository(NotificationDelivery).find({ where: { kind: 'alarm', channel: DeliveryChannel.EMAIL } });
      expect((told.payload as { text: string }).text).toMatch(/sur le bucket « photos-\d+ » du compte « Alarmed »/);

      await evaluator.tick(new Date('2026-10-20T15:02:05Z'));
      expect((await stateOf(failing.id)).state).toBe('OK');
    });

    it("fires on a site's share of failed visits from the website server's counts alone, and a quiet period after it is missing data", async () => {
      const shop = await bucket(A, 'shop');
      const [{ id }] = await query<Array<{ id: string }>>(`SELECT id FROM buckets WHERE name = $1`, [shop]);
      const failing = await alarms.create(
        A,
        alarm({ name: 'Site errors', functionId: null, bucketName: shop, metric: 'TotalErrorRate', statistic: 'Average', period: 60, threshold: 10, actions: { email: false, webhookUrls: [] } }),
      );
      const counted = (kind: string, requests: number, errors4xx: number) =>
        query(
          `INSERT INTO storage_request_counts (bucket_id, minute, class, writer, account_id, name, requests, gets, puts, errors4xx, errors5xx, bytes_in, bytes_out)
           VALUES ($1, '2026-10-20T15:00:00Z', $4, gen_random_uuid(), $2, $3, $5, $5, 0, $6, 0, 0, 0)`,
          [id, A, shop, kind, requests, errors4xx],
        );
      await counted('website', 8, 2);
      await counted('tier2', 100, 0); // its S3 API's requests, never the site's

      await evaluator.tick(new Date('2026-10-20T15:01:05Z'));
      expect([(await stateOf(failing.id)).state, (await stateOf(failing.id)).stateReason]).toEqual([
        'ALARM',
        '1 of the last 1 period(s) of 60 s breaching TotalErrorRate Average > 10 (1 needed); latest 25',
      ]);

      await evaluator.tick(new Date('2026-10-20T15:02:05Z'));
      expect((await stateOf(failing.id)).state).toBe('INSUFFICIENT_DATA');
    });

    it("fires on a queue's messages from its minute samples, the e-mail naming the queue, and recovers once a minute finds it empty", async () => {
      const dead = await queue(A, 'orders-dlq');
      const waiting = await alarms.create(
        A,
        alarm({ name: 'Dead letters', functionId: null, queueName: dead.name, metric: 'ApproximateNumberOfMessagesVisible', statistic: 'Maximum', period: 60, actions: { email: true, webhookUrls: [] } }),
      );
      await query(`INSERT INTO queue_samples (queue_id, minute, account_id, visible, not_visible, delayed, oldest_age_seconds) VALUES ($1, '2026-10-20T15:00:00Z', $2, 2, 0, 0, 40)`, [
        dead.id,
        A,
      ]);

      await evaluator.tick(new Date('2026-10-20T15:01:05Z'));
      expect([(await stateOf(waiting.id)).state, (await stateOf(waiting.id)).stateReason]).toEqual([
        'ALARM',
        '1 of the last 1 period(s) of 60 s breaching ApproximateNumberOfMessagesVisible Maximum > 0 (1 needed); latest 2',
      ]);
      const [told] = await db.dataSource.getRepository(NotificationDelivery).find({ where: { kind: 'alarm', channel: DeliveryChannel.EMAIL } });
      expect((told.payload as { text: string }).text).toMatch(/sur la file d'attente « orders-dlq-\d+ » du compte « Alarmed »/);

      // No sample the next minute: the queue was empty.
      await evaluator.tick(new Date('2026-10-20T15:02:05Z'));
      expect((await stateOf(waiting.id)).state).toBe('OK');
    });

    it("fires on a function's asynchronous calls dropped, as Lambda's AsyncEventsDropped counts them", async () => {
      const dropping = await alarms.create(A, alarm({ name: 'Dropped', metric: 'AsyncEventsDropped', statistic: 'Sum', period: 60, actions: { email: false, webhookUrls: [] } }));
      await query(
        `INSERT INTO async_event_counts (function_id, minute, writer, account_id, received, dropped, destination_failures, attempts, age_ms_sum, age_ms_max)
         VALUES ($1, '2026-10-20T16:00:00Z', gen_random_uuid(), $2, 1, 1, 0, 3, 183000, 121000)`,
        [f.id, A],
      );

      await evaluator.tick(new Date('2026-10-20T16:01:05Z'));
      expect((await stateOf(dropping.id)).stateReason).toBe('1 of the last 1 period(s) of 60 s breaching AsyncEventsDropped Sum > 0 (1 needed); latest 1');
    });

    it('evaluates each alarm once a round when two backends work at once, and an alarm replaced again at once', async () => {
      const made = [];
      for (let i = 0; i < 5; i++) made.push(await alarms.create(A, alarm({ name: `Alarm ${i}`, actions: { email: false, webhookUrls: [] } })));
      const other = new AlarmEvaluator(db.dataSource, new CustomerMetricsService(db.dataSource), {} as BillingService, notifications, config);
      const now = new Date('2026-10-20T15:00:05Z');
      const evaluatedBefore = await valueOf(alarmEvaluations);

      const [mine, theirs] = await Promise.all([evaluator.tick(now), other.tick(now)]);

      expect(mine + theirs).toBe(5);
      expect((await db.dataSource.getRepository(Alarm).find()).every((a) => a.evaluatedAt?.getTime() === now.getTime())).toBe(true);
      expect(await evaluator.tick(new Date(now.getTime() + 10_000))).toBe(0); // the same round
      await alarms.update(A, made[0].id, alarm({ name: 'Alarm 0', threshold: 3, actions: { email: false, webhookUrls: [] } }));
      expect(await evaluator.tick(new Date(now.getTime() + 20_000))).toBe(1);
      // The next round: the one judged again 20 s in waits its own minute.
      expect(await evaluator.tick(new Date(now.getTime() + 60_000))).toBe(4);
      expect(await evaluator.tick(new Date(now.getTime() + 80_000))).toBe(1);
      expect(await valueOf(alarmEvaluations)).toBe(evaluatedBefore + 11); // each evaluation counted once, by whichever backend made it
    });
  });
});

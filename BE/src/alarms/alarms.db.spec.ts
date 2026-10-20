/**
 * L2: alarms against a real PostgreSQL server, in a scratch database dropped
 * after: an account's alarms and their audit entries, what they refuse, and
 * the evaluator, from usage records written here, through the notifications'
 * queue: an error alarm that fires and recovers, telling each change once;
 * missing data; an account's alarm; the money; two backends at once.
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
import { Function, FunctionStatus, Runtime } from '../functions/entities/function.entity';
import { CustomerMetricsService } from '../metrics/customer-metrics.service';
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
  /** Only the deliveries of the alarm a test makes: each test clears those before it. */
  const clearDeliveries = () => query(`DELETE FROM notification_deliveries`);

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    await query(`SELECT ff_ensure_month_partition('usage_records', '2026-10-01')`);
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
  });

  describe('the evaluator', () => {
    it('fires an error alarm and recovers it, each change told once, to the e-mail and the webhook', async () => {
      const watching = await alarms.create(A, alarm({ name: 'Checkout errors' }));
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

    it('evaluates each alarm once a round when two backends work at once, and an alarm replaced again at once', async () => {
      const made = [];
      for (let i = 0; i < 5; i++) made.push(await alarms.create(A, alarm({ name: `Alarm ${i}`, actions: { email: false, webhookUrls: [] } })));
      const other = new AlarmEvaluator(db.dataSource, new CustomerMetricsService(db.dataSource), {} as BillingService, notifications, config);
      const now = new Date('2026-10-20T15:00:05Z');

      const [mine, theirs] = await Promise.all([evaluator.tick(now), other.tick(now)]);

      expect(mine + theirs).toBe(5);
      expect((await db.dataSource.getRepository(Alarm).find()).every((a) => a.evaluatedAt?.getTime() === now.getTime())).toBe(true);
      expect(await evaluator.tick(new Date(now.getTime() + 10_000))).toBe(0); // the same round
      await alarms.update(A, made[0].id, alarm({ name: 'Alarm 0', threshold: 3, actions: { email: false, webhookUrls: [] } }));
      expect(await evaluator.tick(new Date(now.getTime() + 20_000))).toBe(1);
      // The next round: the one judged again 20 s in waits its own minute.
      expect(await evaluator.tick(new Date(now.getTime() + 60_000))).toBe(4);
      expect(await evaluator.tick(new Date(now.getTime() + 80_000))).toBe(1);
    });
  });
});

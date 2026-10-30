/**
 * L2: the admin dashboard's accounts (client-readiness plan, P-71) against a
 * real PostgreSQL server, in a scratch database that is dropped after: the
 * list and its pages, search and filters; the account page; each status
 * change with its audit entry, its e-mails and what it does to the functions;
 * two operators at once; the plan and internet egress; the balance (P-31)
 * and the credit (P-74; its own cases are in admin-credits.db.spec.ts).
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { Membership } from '../accounts/entities/membership.entity';
import { Plan } from '../accounts/entities/plan.entity';
import { User } from '../accounts/entities/user.entity';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import type { Role } from '../auth/principal';
import { LedgerAccountType } from '../billing/ledger/ledger-account.entity';
import { LedgerTransactionKind } from '../billing/ledger/ledger-transaction.entity';
import { LedgerService } from '../billing/ledger/ledger.service';
import { CreditService } from '../billing/credit.service';
import { LedgerEvents } from '../billing/ledger/ledger-events';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { Function, FunctionStatus, Runtime } from '../functions/entities/function.entity';
import { Mail } from '../mail/mail.service';
import { capturingMail } from '../mail/capturing-mail';
import { FunctionWorkload, Orchestrator, TenantLimits } from '../orchestrator/orchestrator.types';
import { BETA_LIMITS } from '../plans/test-fixtures';
import { PlansService } from '../plans/plans.service';
import { UsageRecord } from '../usage/usage-record.entity';
import { UsageService } from '../usage/usage.service';
import { AdminAccountsService, utcMinute } from './admin-accounts.service';
import { AdminCreditsService } from './admin-credits.service';
import { PlatformSetting } from './platform-setting.entity';
import { PlatformSettingsService } from './platform-settings.service';
import { BucketsService } from '../storage/buckets.service';
import { Bucket } from '../storage/bucket.entity';
import { StoreBuckets } from '../storage/store-buckets';
import { CustomerQueues } from '../queues/customer-queues';
import { Queue } from '../queues/queue.entity';
import { QueueStore } from '../queues/queue-store';

const DAY_MS = 86_400_000;

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const OPERATOR = { id: 'operator:kc-op-1', label: 'operator@ff.test' };
const CONSOLE = 'https://console.ff.example';

run('accounts, for operators (L2, P-71)', () => {
  let db: ScratchDatabase;
  let service: AdminAccountsService;
  let plans: PlansService;
  let ledger: LedgerService;
  let settings: PlatformSettingsService;
  const sent: Mail[] = [];
  /** [function ID, replicas] of each scale call. */
  const scaled: Array<[string, number]> = [];
  // What the account's databases were told: their users suspended, or let in again.
  const databaseChanges: string[] = [];
  const applied: Array<{ accountId: string; tenant: TenantLimits }> = [];
  let failScaleOf: string | null = null;
  let failLimitsOf: string | null = null;
  const orchestrator = {
    scale: async (fn: FunctionWorkload, replicas: number) => {
      if (fn.id === failScaleOf) throw new Error('the cluster refused');
      scaled.push([fn.id, replicas]);
    },
    applyTenantLimits: async (accountId: string, tenant: TenantLimits) => {
      if (accountId === failLimitsOf) throw new Error('the cluster refused the NetworkPolicy');
      applied.push({ accountId, tenant });
    },
  } as unknown as Orchestrator;
  let n = 0;
  /** The account whose databases the stand-in for the server of customers' databases lists. */
  const WITH_DATABASE = '300000009999';

  const query = <T = unknown>(sql: string, parameters?: unknown[]) => db.dataSource.query<T>(sql, parameters);
  /** A user; in English unless said otherwise, as most of the e-mails these tests read. */
  async function user(email: string, name: string | null = null, locale = 'en'): Promise<User> {
    return db.dataSource.getRepository(User).save({ oidcSub: `kc-${email}`, email, name, locale });
  }
  /** An account, with its members; the first given is its owner. */
  async function account(
    fields: Omit<Partial<Account>, 'createdAt'> & { createdAt?: string } = {},
    members: Array<[User, Role]> = [],
  ): Promise<string> {
    const id = fields.id ?? String(300000000000 + ++n);
    const { createdAt, ...rest } = fields;
    await db.dataSource.getRepository(Account).save({ id, name: `Account ${n}`, planId: 'beta', status: AccountStatus.PENDING, ...rest });
    if (createdAt) await query('UPDATE accounts SET created_at = $2 WHERE id = $1', [id, createdAt]);
    for (const [member, role] of members) await db.dataSource.getRepository(Membership).save({ accountId: id, userId: member.id, role });
    return id;
  }
  const fn = (accountId: string, fields: Partial<Function> = {}) =>
    db.dataSource.getRepository(Function).save({
      name: `fn-${++n}`,
      accountId,
      runtime: Runtime.NODEJS,
      code: 'x',
      memory: 128,
      timeout: 5,
      status: FunctionStatus.ACTIVE,
      ...fields,
    });
  const statusOf = async (id: string) => (await db.dataSource.getRepository(Account).findOneByOrFail({ id })).status;
  const entriesOf = (accountId: string) => db.dataSource.getRepository(AuditEntry).find({ where: { accountId }, order: { id: 'ASC' } });
  /** Each page's IDs, following `next` to the end. */
  async function pages(filter: Parameters<AdminAccountsService['list']>[0], limit: number): Promise<string[][]> {
    const all: string[][] = [];
    let before: string | undefined;
    do {
      const page = await service.list(filter, { limit, before });
      all.push(page.accounts.map((a) => a.id));
      before = page.next ?? undefined;
    } while (before);
    return all;
  }

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    const ds = db.dataSource;
    await ds.getRepository(Plan).save({ id: 'large', name: 'Large', limits: { ...BETA_LIMITS, quota: { pods: 60, cpu: '24', memory: '24Gi' } } });
    const audit = new AuditService(ds.getRepository(AuditEntry));
    // As the request context would name the operator: the audit service takes the actor from it.
    const record = audit.record.bind(audit);
    jest.spyOn(audit, 'record').mockImplementation((event, manager) => record({ actor: OPERATOR, ...event }, manager));
    plans = new PlansService(ds.getRepository(Plan), ds.getRepository(Account), orchestrator, audit);
    const config = { get: (_key: string, fallback?: unknown) => fallback, getOrThrow: () => ({ consoleUrl: CONSOLE }) } as unknown as ConfigService;
    const usage = new UsageService(ds.getRepository(UsageRecord), ds, config);
    const mail = capturingMail(sent);
    ledger = new LedgerService(ds);
    settings = new PlatformSettingsService(ds.getRepository(PlatformSetting), audit);
    const credits = new AdminCreditsService(ds, ledger, new CreditService(ds, settings, new LedgerEvents(ds)), settings, audit, mail, config);
    service = new AdminAccountsService(
      ds.getRepository(Account),
      ds.getRepository(Membership),
      ds.getRepository(Function),
      orchestrator,
      audit,
      plans,
      usage,
      ledger,
      mail,
      config,
      credits,
      settings,
      {
        suspendAccount: async (accountId: string) => void databaseChanges.push(`suspend ${accountId}`),
        reactivateAccount: async (accountId: string) => void databaseChanges.push(`reactivate ${accountId}`),
        applyAccess: async (accountId: string) => void databaseChanges.push(`apply ${accountId}`),
        list: async (accountId: string) =>
          accountId === WITH_DATABASE
            ? [{ id: 'db-1', name: 'orders', database: 'ff_0123456789abcdef01234567', status: 'active', sizeBytes: 7_634_423, connections: 2, storageLimitMb: 1024, createdAt: new Date('2026-10-20T10:00:00Z'), host: 'db.example.tn' }]
            : [],
      } as never,
      // Its buckets' rows and samples are read from the database itself; nothing here makes or empties a bucket in the store.
      new BucketsService(ds.getRepository(Bucket), {} as StoreBuckets, plans, audit, new ConfigService({ storage: { base: 'https://s3.example.tn', region: 'tn-tunis-1' }, website: { base: 'https://site.example.tn' } })),
      new CustomerQueues(ds, ds.getRepository(Queue)),
      new QueueStore(ds, { count: () => undefined } as never),
      {
        suspendAccount: async (accountId: string) => void databaseChanges.push(`caches suspend ${accountId}`),
        reactivateAccount: async (accountId: string) => void databaseChanges.push(`caches reactivate ${accountId}`),
        forOperator: async (accountId: string) =>
          accountId === WITH_DATABASE
            ? [{ name: 'sessions', serverName: 'fc-0123456789abcdef01234567', status: 'active', port: 6400, memoryMb: 64, bytesUsedForCache: 1_258_291, currConnections: 2, createdAt: new Date('2026-10-20T11:00:00Z'), host: 'cache.example.tn' }]
            : [],
      } as never,
    );
  });

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(() => {
    sent.length = 0;
    scaled.length = 0;
    databaseChanges.length = 0;
    applied.length = 0;
    failScaleOf = null;
    failLimitsOf = null;
  });

  describe('the list', () => {
    it('gives the newest first, a page at a time, each account with its owners', async () => {
      const owner = await user('list-owner@ff.test', 'Owner');
      const older = await account({ name: 'Older', createdAt: '2020-01-01T10:00:00Z' }, [[owner, 'owner'], [await user('list-dev@ff.test'), 'developer']]);
      const newer = await account({ name: 'Newer', createdAt: '2020-01-02T10:00:00Z' });
      const newest = await account({ name: 'Newest', createdAt: '2020-01-03T10:00:00Z' });

      const first = await service.list({ q: 'list-' }, { limit: 50 });
      expect(first.accounts.map((a) => [a.id, a.owners])).toEqual([[older, [{ email: 'list-owner@ff.test', name: 'Owner' }]]]);

      expect(await pages({ q: 'Newe' }, 1)).toEqual([[newest], [newer]]);
    });

    it('loses no account between pages, even several created in the same millisecond', async () => {
      const same = [];
      for (const micro of ['100', '200', '300']) same.push(await account({ name: 'Same ms', createdAt: `2020-02-01T10:00:00.000${micro}Z` }));

      expect(await pages({ q: 'Same ms' }, 1)).toEqual([[same[2]], [same[1]], [same[0]]]);
    });

    it('filters by status, the approvals queue, and by plan', async () => {
      const pending = await account({ name: 'Queue one' });
      const active = await account({ name: 'Queue two', status: AccountStatus.ACTIVE, planId: 'large' });

      expect((await service.list({ q: 'Queue', status: AccountStatus.PENDING }, { limit: 50 })).accounts.map((a) => a.id)).toEqual([pending]);
      expect((await service.list({ q: 'Queue', planId: 'large' }, { limit: 50 })).accounts.map((a) => a.id)).toEqual([active]);
    });

    it("searches the ID, the name and any member's e-mail, in any case, taking % and _ as themselves", async () => {
      const labs = await account({ id: '777000000001', name: 'Tunis LABS' });
      const percent = await account({ name: '100% serverless' });
      const viewer = await user('Find.Me_Viewer@ff.test');
      const byMember = await account({ name: 'Plain' }, [[await user('search-owner@ff.test'), 'owner'], [viewer, 'viewer']]);
      const found = async (q: string) => (await service.list({ q }, { limit: 50 })).accounts.map((a) => a.id);

      expect(await found('77700000')).toEqual([labs]);
      expect(await found('tunis labs')).toEqual([labs]);
      expect(await found('find.me_viewer')).toEqual([byMember]);
      expect(await found('100%')).toEqual([percent]);
      expect(await found('find.me%viewer')).toEqual([]);
    });
  });

  it("gives the account page: owners and members, functions with their last call from the usage records, this month's usage, the status history", async () => {
    const owner = await user('page-owner@ff.test', 'Page Owner');
    const developer = await user('page-dev@ff.test');
    const id = await account({ name: 'Page', taxId: '1234567A', useCase: 'invoices' }, [[owner, 'owner'], [developer, 'developer']]);
    await db.dataSource.getRepository(AuditEntry).save({ accountId: id, actor: `user:${owner.id}`, actorLabel: owner.email, action: 'account.create', resource: `account:${id}` });
    await service.changeStatus(id, 'approve', 'Use case checked');
    const used = await fn(id, { name: 'used' });
    const quiet = await fn(id, { name: 'quiet' });
    await fn(id, { name: 'never-called', minInstances: 1 });
    const call = async (functionId: string, name: string, secondsAgo: number, billedMs: number) => {
      await query(`SELECT ff_ensure_month_partition('usage_records', date_trunc('month', (now() - make_interval(secs => $1)) AT TIME ZONE 'UTC')::date)`, [secondsAgo]);
      await query(
        `INSERT INTO usage_records (request_id, started_at, ended_at, account_id, function_id, function_name, runtime, memory_mb, duration_ms, billed_ms, status)
         VALUES (gen_random_uuid(), now() - make_interval(secs => $4), now() - make_interval(secs => $4), $1, $2, $3, 'nodejs', 128, $5::numeric, $5::int, 'success')`,
        [id, functionId, name, secondsAgo, billedMs],
      );
    };
    await call(used.id, 'used', 0, 100);
    // Called 50 and 40 days ago, in earlier months: the history's retention cleared their invocations, their usage records stay (P-45).
    await call(quiet.id, 'quiet', 50 * 86_400, 7);
    await call(quiet.id, 'quiet', 40 * 86_400, 7);
    const lastCall = async (functionId: string) =>
      (await query<Array<{ at: Date }>>('SELECT max(started_at) AS at FROM usage_records WHERE function_id = $1', [functionId]))[0].at;

    const page = await service.detail(id);

    expect(page.account).toMatchObject({ id, name: 'Page', status: 'active', taxId: '1234567A', useCase: 'invoices', owners: [{ email: 'page-owner@ff.test', name: 'Page Owner' }] });
    expect(page.members.map((m) => [m.email, m.role])).toEqual([['page-owner@ff.test', 'owner'], ['page-dev@ff.test', 'developer']]);
    expect(page.functions.map((f) => [f.name, f.minInstances, f.lastInvokedAt])).toEqual([
      ['used', 0, await lastCall(used.id)],
      ['quiet', 0, await lastCall(quiet.id)],
      ['never-called', 1, null],
    ]);
    const quietLast = page.functions[1].lastInvokedAt?.getTime() ?? 0;
    expect(Date.now() - quietLast).toBeGreaterThan(39 * 86_400_000); // the newer of its two calls, 40 days ago
    expect(Date.now() - quietLast).toBeLessThan(41 * 86_400_000);
    expect(page.usage).toMatchObject({ month: new Date().toISOString().slice(0, 7), totals: { requests: 1, billedMs: 100 } });
    expect(page.statusHistory.map((e) => [e.status, e.by, e.reason])).toEqual([
      ['pending', 'page-owner@ff.test', null],
      ['active', 'operator@ff.test', 'Use case checked'],
    ]);
    expect(page.balances).toEqual([]);
    expect([page.databases, page.caches, page.account.storageDisabledAt, page.account.storageDisabledReason]).toEqual([[], [], null, null]);
    expect(page.credit).toEqual({
      currency: 'TND',
      balance: '0.000',
      state: { state: 'ok', buffer: '1.000', belowBufferSince: null, invokesStopAt: null },
      shadowMode: true,
      month: new Date().toISOString().slice(0, 7),
      debited: '0.000',
      ratedOnly: '0.000',
      ratedUntil: null,
      largeCreditThreshold: '100.000',
    });
  });

  it("gives the account's balance with its currency's decimals: none before its first entry, a debt below zero, another account's apart (P-31)", async () => {
    const id = await account({ status: AccountStatus.ACTIVE });
    const other = await account({ status: AccountStatus.ACTIVE });
    expect((await service.detail(id)).balances).toEqual([]);

    await ledger.grantCredit({ accountId: id, currency: 'TND', amountMinor: 12500n, kind: LedgerTransactionKind.PROMO, idempotencyKey: `promo:${id}` });
    await ledger.grantCredit({ accountId: other, currency: 'TND', amountMinor: 1000n, kind: LedgerTransactionKind.PROMO, idempotencyKey: `promo:${other}` });
    expect((await service.detail(id)).balances).toEqual([{ currency: 'TND', balance: '12.500' }]);

    await ledger.post({
      kind: LedgerTransactionKind.USAGE,
      idempotencyKey: `usage:${id}:2026-10-17T10`,
      currency: 'TND',
      entries: [
        { account: { wallet: id }, amountMinor: -12750n },
        { account: { ff: LedgerAccountType.REVENUE }, amountMinor: 12750n },
      ],
    });
    expect((await service.detail(id)).balances).toEqual([{ currency: 'TND', balance: '-0.250' }]);
    expect((await service.detail(id)).credit.balance).toBe('-0.250');
    expect((await service.detail(other)).balances).toEqual([{ currency: 'TND', balance: '1.000' }]);
  });

  describe('the status changes', () => {
    it("approve a pending account: active, with the operator, the reason and from → to in its audit log, and an e-mail to each owner in their language", async () => {
      const id = await account({ name: 'To approve' }, [
        [await user('approve-1@ff.test'), 'owner'],
        [await user('approve-2@ff.test', null, 'fr-TN'), 'owner'],
        [await user('approve-viewer@ff.test'), 'viewer'],
      ]);

      await service.changeStatus(id, 'approve', 'Use case checked');

      expect(await statusOf(id)).toBe('active');
      expect(await entriesOf(id)).toEqual([
        expect.objectContaining({
          actor: 'operator:kc-op-1',
          actorLabel: 'operator@ff.test',
          action: 'account.approve',
          resource: `account:${id}`,
          details: { reason: 'Use case checked', changes: { status: { from: 'pending', to: 'active' } } },
        }),
      ]);
      expect(sent.map((mail) => [mail.to, mail.subject])).toEqual([
        ['approve-1@ff.test', 'Your FF account is approved: To approve'],
        ['approve-2@ff.test', 'Votre compte FF est approuvé : To approve'],
      ]);
      expect([sent[0].text, sent[1].text]).toEqual([expect.stringContaining(`The console: ${CONSOLE}`), expect.stringContaining(`La console : ${CONSOLE}`)]);
    });

    it("refuse a change that doesn't apply with 409, writing and sending nothing", async () => {
      const id = await account({ status: AccountStatus.ACTIVE }, [[await user('refused@ff.test'), 'owner']]);

      await expect(service.changeStatus(id, 'approve', 'again')).rejects.toThrow(new ConflictException(`Account ${id} is active: only a pending account can be approved`));

      expect([await statusOf(id), await entriesOf(id), sent]).toEqual(['active', [], []]);
    });

    it("answer 404 for an account that doesn't exist, as every other route does", async () => {
      const missing = '999999999999';
      const message = `Account ${missing} not found`;

      await expect(service.changeStatus(missing, 'suspend', 'x')).rejects.toThrow(new NotFoundException(message));
      await expect(service.detail(missing)).rejects.toThrow(new NotFoundException(message));
      await expect(service.auditLog(missing, { limit: 10 })).rejects.toThrow(new NotFoundException(message));
      await expect(service.setEgress(missing, true, 'x')).rejects.toThrow(new NotFoundException(message));
      await expect(service.changePlan(missing, 'beta', 'x')).rejects.toThrow(new NotFoundException(message));
    });

    it("suspend: working functions scaled to zero, the databases' users kept out; reactivate: warm instances back, the others left to their next call, the users let in", async () => {
      const id = await account({ status: AccountStatus.ACTIVE }, [[await user('suspended@ff.test'), 'owner']]);
      const cold = await fn(id);
      const warm = await fn(id, { minInstances: 2 });
      await fn(id, { status: FunctionStatus.ERROR });

      await service.changeStatus(id, 'suspend', 'Mining cryptocurrency');
      expect([await statusOf(id), scaled]).toEqual(['suspended', [[cold.id, 0], [warm.id, 0]]]);
      expect(sent.map((mail) => mail.subject)).toEqual(['Your FF account is suspended: Account ' + String(n - 3)]);
      expect(sent[0].text).toContain('Why: Mining cryptocurrency');

      scaled.length = 0;
      await service.changeStatus(id, 'reactivate', 'Owner removed the miner');
      expect([await statusOf(id), scaled]).toEqual(['active', [[warm.id, 2]]]);
      // Its databases' and caches' users kept out, then let in again.
      expect(databaseChanges).toEqual([`suspend ${id}`, `caches suspend ${id}`, `reactivate ${id}`, `caches reactivate ${id}`]);
    });

    it("keep the change when a function can't be scaled: the others are, and the minute's hold catches up", async () => {
      const id = await account({ status: AccountStatus.ACTIVE });
      const failing = await fn(id);
      const other = await fn(id);
      failScaleOf = failing.id;

      await service.changeStatus(id, 'suspend', 'Unpaid');

      expect([await statusOf(id), scaled]).toEqual(['suspended', [[other.id, 0]]]);
    });

    it("make no change without its audit entry: one that can't be written rolls the status back, and nothing is scaled or sent", async () => {
      const id = await account({ status: AccountStatus.ACTIVE }, [[await user('unaudited@ff.test'), 'owner']]);
      await fn(id);
      await query(`
        CREATE FUNCTION refuse_suspend_entry() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'no audit today'; END $$ LANGUAGE plpgsql;
        CREATE TRIGGER refuse_suspend_entry BEFORE INSERT ON audit_log FOR EACH ROW WHEN (NEW.action = 'account.suspend') EXECUTE FUNCTION refuse_suspend_entry();`);
      try {
        await expect(service.changeStatus(id, 'suspend', 'Unpaid')).rejects.toThrow('no audit today');
      } finally {
        await query('DROP TRIGGER refuse_suspend_entry ON audit_log; DROP FUNCTION refuse_suspend_entry();');
      }

      expect([await statusOf(id), await entriesOf(id), scaled, sent]).toEqual(['active', [], [], []]);
    });

    it("close an account from any status but closed: its functions scaled to zero, its data due for deletion after the settings' notice period, which the e-mail and the audit entry give", async () => {
      const id = await account({ status: AccountStatus.REJECTED }, [[await user('closing@ff.test'), 'owner']]);
      const left = await fn(id);
      const before = Date.now();

      const page = await service.changeStatus(id, 'close', 'Owner asked');

      expect([await statusOf(id), scaled, databaseChanges]).toEqual(['closed', [[left.id, 0]], [`suspend ${id}`, `caches suspend ${id}`]]);
      const due = page.account.dataDeletionDueAt as Date;
      expect(due.getTime() - before).toBeGreaterThanOrEqual(30 * DAY_MS);
      expect(due.getTime() - before).toBeLessThan(30 * DAY_MS + 60_000);
      expect(page.account.dataDeletedAt).toBeNull();
      expect(sent.map((mail) => [mail.to, mail.subject])).toEqual([['closing@ff.test', `Your FF account is closed: Account ${n - 1}`]]);
      expect(sent[0].text).toContain(`Its functions, their invocation history and their logs will be deleted on ${utcMinute(due)}.`);
      const entry = (await entriesOf(id)).find((e) => e.action === 'account.close');
      expect(entry?.details).toEqual({ reason: 'Owner asked', changes: { status: { from: 'rejected', to: 'closed' } }, dataDeletionDueAt: due.toISOString() });

      await expect(service.changeStatus(id, 'close', 'Owner asked')).rejects.toThrow(new ConflictException(`Account ${id} is already closed`));
      expect((await service.detail(id)).account.dataDeletionDueAt).toEqual(due);
    });

    it('give an account closed after the notice period changed the new one, and keep the date of one closed before', async () => {
      const first = await account({ status: AccountStatus.ACTIVE });
      const firstDue = (await service.changeStatus(first, 'close', 'Owner asked')).account.dataDeletionDueAt as Date;
      await settings.update({ closedAccountDeletionDays: 7 }, 'A shorter notice');
      try {
        const second = await account({ status: AccountStatus.SUSPENDED });
        const before = Date.now();

        const secondDue = (await service.changeStatus(second, 'close', 'Unpaid')).account.dataDeletionDueAt as Date;

        expect(secondDue.getTime() - before).toBeGreaterThanOrEqual(7 * DAY_MS);
        expect(secondDue.getTime() - before).toBeLessThan(7 * DAY_MS + 60_000);
        expect((await service.detail(first)).account.dataDeletionDueAt).toEqual(firstDue);
      } finally {
        await settings.update({ closedAccountDeletionDays: 30 }, 'Back to the default');
      }
    });

    it('give no other change a deletion date, and refuse one on an account that is not closed', async () => {
      const id = await account({ status: AccountStatus.ACTIVE });
      await service.changeStatus(id, 'suspend', 'Unpaid');
      await service.changeStatus(id, 'reactivate', 'Paid');

      expect((await service.detail(id)).account.dataDeletionDueAt).toBeNull();
      await expect(query(`UPDATE accounts SET data_deletion_due_at = now() WHERE id = $1`, [id])).rejects.toThrow(/violates check constraint/);
      await expect(query(`UPDATE accounts SET status = 'closed' WHERE id = $1`, [id])).rejects.toThrow(/violates check constraint/);
    });

    it('take two operators at once one after the other: one changes the account, the other is told it is no longer pending', async () => {
      const id = await account({}, [[await user('race@ff.test'), 'owner']]);
      // Each status write now takes 200 ms, so changes that didn't wait for each other would both see "pending".
      await query(`
        CREATE FUNCTION slow_account() RETURNS trigger AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$ LANGUAGE plpgsql;
        CREATE TRIGGER slow_account BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION slow_account();`);
      let outcomes: PromiseSettledResult<unknown>[];
      try {
        outcomes = await Promise.allSettled([service.changeStatus(id, 'approve', 'one'), service.changeStatus(id, 'reject', 'two')]);
      } finally {
        await query('DROP TRIGGER slow_account ON accounts; DROP FUNCTION slow_account();');
      }

      const entries = await entriesOf(id);
      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect((outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
      expect(entries).toHaveLength(1);
      expect(await statusOf(id)).toBe((entries[0].details as { changes: { status: { to: string } } }).changes.status.to);
      expect(sent).toHaveLength(1);
    });
  });

  it("moves an account to another plan: the operator's reason in its log, and the plan's quota applied", async () => {
    const id = await account({ status: AccountStatus.ACTIVE });

    const page = await service.changePlan(id, 'large', 'Needs more room');

    expect(page.account.planId).toBe('large');
    expect(applied).toEqual([{ accountId: id, tenant: { quota: { pods: 60, cpu: '24', memory: '24Gi' }, internetEgress: false } }]);
    expect((await entriesOf(id)).map((entry) => [entry.action, entry.actor, entry.details])).toEqual([
      ['account.plan', 'operator:kc-op-1', { reason: 'Needs more room', changes: { planId: { from: 'beta', to: 'large' } } }],
    ]);
  });

  it("turns internet egress on and off, with from → to in the log, and writes it into the account's NetworkPolicy at once", async () => {
    const id = await account({ status: AccountStatus.ACTIVE });

    expect((await service.setEgress(id, true, 'Calls a payment API')).account.internetEgress).toBe(true);
    expect((await service.setEgress(id, false, 'No longer needed')).account.internetEgress).toBe(false);

    expect((await entriesOf(id)).map((entry) => [entry.action, entry.details])).toEqual([
      ['account.egress', { reason: 'Calls a payment API', changes: { internetEgress: { from: false, to: true } } }],
      ['account.egress', { reason: 'No longer needed', changes: { internetEgress: { from: true, to: false } } }],
    ]);
    expect(applied).toEqual([
      { accountId: id, tenant: { quota: BETA_LIMITS.quota, internetEgress: true } },
      { accountId: id, tenant: { quota: BETA_LIMITS.quota, internetEgress: false } },
    ]);
  });

  it("turns the account's databases, buckets and queues off and on, its reason on the page and in the log, the databases following each time, a retry too, the owners told of each change", async () => {
    const id = await account({ status: AccountStatus.ACTIVE }, [[await user(`storage-owner-${++n}@ff.test`), 'owner'], [await user(`storage-dev-${++n}@ff.test`), 'developer']]);

    const off = await service.setStorage(id, false, 'Files shared against our terms');
    await service.setStorage(id, false, 'Again, as a retry');
    const on = await service.setStorage(id, true, 'Cleared with the owner');

    expect(sent.map((mail) => [mail.to, mail.subject])).toEqual([
      [expect.stringMatching(/^storage-owner-/), `The databases, buckets and queues of your FF account are off: ${off.account.name}`],
      [expect.stringMatching(/^storage-owner-/), `The databases, buckets and queues of your FF account are on again: ${off.account.name}`],
    ]);

    expect([off.account.storageDisabledAt instanceof Date, off.account.storageDisabledReason]).toEqual([true, 'Files shared against our terms']);
    expect([on.account.storageDisabledAt, on.account.storageDisabledReason]).toEqual([null, null]);
    expect((await entriesOf(id)).map((entry) => [entry.action, entry.details])).toEqual([
      ['account.storage', { reason: 'Files shared against our terms', changes: { storageEnabled: { from: true, to: false } } }],
      ['account.storage', { reason: 'Cleared with the owner', changes: { storageEnabled: { from: false, to: true } } }],
    ]);
    expect(databaseChanges).toEqual([`apply ${id}`, `apply ${id}`, `apply ${id}`]);
    await expect(query(`UPDATE accounts SET storage_disabled_at = now() WHERE id = $1`, [id])).rejects.toThrow(/violates check constraint/); // no reason
    await expect(service.setStorage('999999999999', false, 'Nobody')).rejects.toThrow('Account 999999999999 not found');
  });

  it("shows the account's databases and caches on its page, their names on the servers, their size, memory and connections as the servers count them", async () => {
    const page = await service.detail(await account({ status: AccountStatus.ACTIVE, id: WITH_DATABASE }));

    expect(page.databases).toEqual([
      { id: 'db-1', name: 'orders', database: 'ff_0123456789abcdef01234567', status: 'active', sizeBytes: 7_634_423, connections: 2, storageLimitMb: 1024, createdAt: new Date('2026-10-20T10:00:00Z') },
    ]);
    expect(page.caches).toEqual([
      { name: 'sessions', serverName: 'fc-0123456789abcdef01234567', status: 'active', port: 6400, memoryMb: 64, bytesUsedForCache: 1_258_291, currConnections: 2, createdAt: new Date('2026-10-20T11:00:00Z') },
    ]);
  });

  it("shows the account's buckets on its page, their names in the store, what each held at its last measure, which are public sites, and how full they are together", async () => {
    const id = await account({ status: AccountStatus.ACTIVE });
    const [{ id: photos }] = await query<Array<{ id: string }>>(
      `INSERT INTO buckets (account_id, name, store_name, created_at, website) VALUES ($1, $2, 'ff-0123456789abcdef0123456a', '2026-10-20T10:00:00Z', $3) RETURNING id`,
      [id, `photos-${id}`, JSON.stringify({ indexDocument: 'index.html', errorDocument: null, singlePageApp: false })],
    );
    await query(`INSERT INTO buckets (account_id, name, store_name, created_at) VALUES ($1, $2, 'ff-0123456789abcdef0123456b', '2026-10-21T10:00:00Z')`, [id, `zz-new-${id}`]);
    await query(`SELECT ff_ensure_month_partition('bucket_samples', '2026-10-01')`);
    for (const [hour, size] of [['2026-10-22T08:00:00Z', 1_000], ['2026-10-22T09:00:00Z', 161_480_253]] as const) {
      await query(`INSERT INTO bucket_samples (bucket_id, hour, account_id, name, size_bytes, objects) VALUES ($1, $2, $3, 'photos', $4, 1204)`, [photos, hour, id, size]);
    }
    await query(`UPDATE accounts SET bucket_storage_notice = 80 WHERE id = $1`, [id]);

    const page = await service.detail(id);

    expect(page.buckets).toEqual([
      { name: `photos-${id}`, storeName: 'ff-0123456789abcdef0123456a', status: 'active', sizeBytes: 161_480_253, objects: 1_204, measuredAt: new Date('2026-10-22T09:00:00Z'), site: true, createdAt: new Date('2026-10-20T10:00:00Z') },
      { name: `zz-new-${id}`, storeName: 'ff-0123456789abcdef0123456b', status: 'active', sizeBytes: null, objects: null, measuredAt: null, site: false, createdAt: new Date('2026-10-21T10:00:00Z') },
    ]);
    expect(page.account.bucketStorageNotice).toBe(80);
  });

  it("shows the account's queues on its page, their messages counted now, what they hold, their dead-letter queue, and the plan's room for them all", async () => {
    const id = await account({ status: AccountStatus.ACTIVE });
    await query(`INSERT INTO queues (account_id, name, kind, created_at) VALUES ($1, 'orders-dlq', 'customer', '2026-10-21T10:00:00Z')`, [id]);
    const [{ id: orders }] = await query<Array<{ id: string }>>(
      `INSERT INTO queues (account_id, name, kind, redrive_policy, created_at) VALUES ($1, 'orders', 'customer', $2, '2026-10-20T10:00:00Z') RETURNING id`,
      [id, { deadLetterTargetArn: `arn:aws:sqs:tn-tunis-1:${id}:orders-dlq`, maxReceiveCount: 3 }],
    );
    // One waiting, one received and hidden, one delayed; and one expired, which no count has, but whose bytes are held until retention's sweep deletes it.
    for (const [visibleAt, receives, expiresAt] of [
      ['-1 minute', 0, '+1 day'],
      ['+1 minute', 1, '+1 day'],
      ['+1 minute', 0, '+1 day'],
      ['-1 minute', 0, '-1 second'],
    ] as const) {
      await query(
        `INSERT INTO queue_messages (queue_id, message_id, body, size_bytes, visible_at, receive_count, expires_at) VALUES ($1, gen_random_uuid(), 'x', 100, now() + $2::interval, $3, now() + $4::interval)`,
        [orders, visibleAt, receives, expiresAt],
      );
    }

    const page = await service.detail(id);

    expect(page.queues).toEqual([
      { name: 'orders', messages: { available: 1, inFlight: 1, delayed: 1 }, sizeBytes: 400, deadLetterQueue: 'orders-dlq', createdAt: new Date('2026-10-20T10:00:00Z') },
      { name: 'orders-dlq', messages: { available: 0, inFlight: 0, delayed: 0 }, sizeBytes: 0, deadLetterQueue: null, createdAt: new Date('2026-10-21T10:00:00Z') },
    ]);
    expect(page.queueStorage).toEqual({ bytes: 400, limitMb: BETA_LIMITS.queueStorageMb });
  });

  it('changes nothing when the cluster refuses the NetworkPolicy; the value the account has writes nothing, but applies it again', async () => {
    const id = await account({ status: AccountStatus.ACTIVE });

    failLimitsOf = id;
    await expect(service.setEgress(id, true, 'Calls a payment API')).rejects.toThrow('the cluster refused the NetworkPolicy');
    expect([(await service.detail(id)).account.internetEgress, await entriesOf(id)]).toEqual([false, []]);
    failLimitsOf = null;
    await service.setEgress(id, false, 'Retry');

    expect(await entriesOf(id)).toEqual([]);
    expect(applied).toEqual([{ accountId: id, tenant: { quota: BETA_LIMITS.quota, internetEgress: false } }]);
  });

  it("pages the account's whole log, operators named", async () => {
    const id = await account();
    await service.changeStatus(id, 'approve', 'one');
    await service.changeStatus(id, 'suspend', 'two');

    const first = await service.auditLog(id, { limit: 1 });
    const second = await service.auditLog(id, { limit: 1, before: first.next as string });

    expect([...first.entries, ...second.entries].map((entry) => [entry.action, entry.actorLabel])).toEqual([
      ['account.suspend', 'operator@ff.test'],
      ['account.approve', 'operator@ff.test'],
    ]);
  });

  it('lists the plans an account can move to, with their limits', async () => {
    expect((await plans.list()).map((plan) => [plan.id, plan.limits.quota.pods])).toEqual([
      ['beta', BETA_LIMITS.quota.pods],
      ['large', 60],
    ]);
  });
});

/**
 * L2: the admin dashboard's accounts (client-readiness plan, P-71) against a
 * real PostgreSQL server, in a scratch database that is dropped after: the
 * list and its pages, search and filters; the account page; each status
 * change with its audit entry, its e-mails and what it does to the functions;
 * two operators at once; the plan and internet egress.
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
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { FunctionInvocation } from '../functions/entities/function-invocation.entity';
import { Function, FunctionStatus, Runtime } from '../functions/entities/function.entity';
import { Mail, MailService } from '../mail/mail.service';
import { FunctionWorkload, Orchestrator, TenantLimits } from '../orchestrator/orchestrator.types';
import { BETA_LIMITS } from '../plans/test-fixtures';
import { PlansService } from '../plans/plans.service';
import { UsageRecord } from '../usage/usage-record.entity';
import { UsageService } from '../usage/usage.service';
import { AdminAccountsService } from './admin-accounts.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const OPERATOR = { id: 'operator:kc-op-1', label: 'operator@ff.test' };
const CONSOLE = 'https://console.ff.example';

run('accounts, for operators (L2, P-71)', () => {
  let db: ScratchDatabase;
  let service: AdminAccountsService;
  let plans: PlansService;
  const sent: Mail[] = [];
  /** [function ID, replicas] of each scale call. */
  const scaled: Array<[string, number]> = [];
  const applied: Array<{ accountId: string; tenant: TenantLimits }> = [];
  let failScaleOf: string | null = null;
  const orchestrator = {
    scale: async (fn: FunctionWorkload, replicas: number) => {
      if (fn.id === failScaleOf) throw new Error('the cluster refused');
      scaled.push([fn.id, replicas]);
    },
    applyTenantLimits: async (accountId: string, tenant: TenantLimits) => void applied.push({ accountId, tenant }),
  } as unknown as Orchestrator;
  let n = 0;

  const query = <T = unknown>(sql: string, parameters?: unknown[]) => db.dataSource.query<T>(sql, parameters);
  async function user(email: string, name: string | null = null): Promise<User> {
    return db.dataSource.getRepository(User).save({ oidcSub: `kc-${email}`, email, name });
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
    const mail = { send: async (message: Mail) => sent.push(message) > 0 } as unknown as MailService;
    service = new AdminAccountsService(
      ds.getRepository(Account),
      ds.getRepository(Membership),
      ds.getRepository(Function),
      ds.getRepository(FunctionInvocation),
      orchestrator,
      audit,
      plans,
      usage,
      mail,
      config,
    );
  });

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(() => {
    sent.length = 0;
    scaled.length = 0;
    applied.length = 0;
    failScaleOf = null;
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

  it("gives the account page: owners and members, functions with their last call, this month's usage, the status history", async () => {
    const owner = await user('page-owner@ff.test', 'Page Owner');
    const developer = await user('page-dev@ff.test');
    const id = await account({ name: 'Page', taxId: '1234567A', useCase: 'invoices' }, [[owner, 'owner'], [developer, 'developer']]);
    await db.dataSource.getRepository(AuditEntry).save({ accountId: id, actor: `user:${owner.id}`, actorLabel: owner.email, action: 'account.create', resource: `account:${id}` });
    await service.changeStatus(id, 'approve', 'Use case checked');
    const used = await fn(id, { name: 'used' });
    await fn(id, { name: 'never-called', minInstances: 1 });
    for (const secondsAgo of [120, 60]) {
      await query(
        `INSERT INTO function_invocations (function_id, input, status, created_at, updated_at) VALUES ($1, '{}', 'COMPLETED', now() - make_interval(secs => $2), now())`,
        [used.id, secondsAgo],
      );
    }
    await query(`SELECT ff_ensure_month_partition('usage_records', date_trunc('month', now())::date)`);
    await query(
      `INSERT INTO usage_records (request_id, started_at, ended_at, account_id, function_id, function_name, runtime, memory_mb, duration_ms, billed_ms, status)
       VALUES (gen_random_uuid(), now(), now(), $1, $2, 'used', 'nodejs', 128, 100, 100, 'success')`,
      [id, used.id],
    );
    const [{ newest }] = await query<Array<{ newest: Date }>>('SELECT max(created_at) AS newest FROM function_invocations WHERE function_id = $1', [used.id]);

    const page = await service.detail(id);

    expect(page.account).toMatchObject({ id, name: 'Page', status: 'active', taxId: '1234567A', useCase: 'invoices', owners: [{ email: 'page-owner@ff.test', name: 'Page Owner' }] });
    expect(page.members.map((m) => [m.email, m.role])).toEqual([['page-owner@ff.test', 'owner'], ['page-dev@ff.test', 'developer']]);
    expect(page.functions.map((f) => [f.name, f.minInstances, f.lastInvokedAt])).toEqual([['used', 0, newest], ['never-called', 1, null]]);
    expect(page.usage).toMatchObject({ month: new Date().toISOString().slice(0, 7), totals: { requests: 1, billedMs: 100 } });
    expect(page.statusHistory.map((e) => [e.status, e.by, e.reason])).toEqual([
      ['pending', 'page-owner@ff.test', null],
      ['active', 'operator@ff.test', 'Use case checked'],
    ]);
  });

  describe('the status changes', () => {
    it("approve a pending account: active, with the operator, the reason and from → to in its audit log, and an e-mail to each owner", async () => {
      const id = await account({ name: 'To approve' }, [
        [await user('approve-1@ff.test'), 'owner'],
        [await user('approve-2@ff.test'), 'owner'],
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
        ['approve-2@ff.test', 'Your FF account is approved: To approve'],
      ]);
      expect(sent[0].text).toContain(`The console: ${CONSOLE}`);
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

    it('suspend: working functions scaled to zero; reactivate: warm instances back, the others left to their next call', async () => {
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

    it('close an account from any status but closed, its functions scaled to zero', async () => {
      const id = await account({ status: AccountStatus.REJECTED });
      const left = await fn(id);

      await service.changeStatus(id, 'close', 'Owner asked');
      expect([await statusOf(id), scaled]).toEqual(['closed', [[left.id, 0]]]);
      await expect(service.changeStatus(id, 'close', 'Owner asked')).rejects.toThrow(new ConflictException(`Account ${id} is already closed`));
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
    expect(applied).toEqual([{ accountId: id, tenant: { quota: { pods: 60, cpu: '24', memory: '24Gi' } } }]);
    expect((await entriesOf(id)).map((entry) => [entry.action, entry.actor, entry.details])).toEqual([
      ['account.plan', 'operator:kc-op-1', { reason: 'Needs more room', changes: { planId: { from: 'beta', to: 'large' } } }],
    ]);
  });

  it('turns internet egress on, with from → to in the log; the value it has already writes nothing', async () => {
    const id = await account({ status: AccountStatus.ACTIVE });

    expect((await service.setEgress(id, true, 'Calls a payment API')).account.internetEgress).toBe(true);
    await service.setEgress(id, true, 'Calls a payment API');

    expect((await entriesOf(id)).map((entry) => [entry.action, entry.details])).toEqual([
      ['account.egress', { reason: 'Calls a payment API', changes: { internetEgress: { from: false, to: true } } }],
    ]);
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

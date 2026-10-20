/**
 * L2: support for FF's operators against a real PostgreSQL server, in a
 * scratch database dropped after: the search by each thing support is asked
 * about, a function's page without its customer's data, and that data given
 * only for a reason, each look in the customer's audit log, where the
 * customer reads it as FF's. The log store and the cluster are stand-ins.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { Membership } from '../accounts/entities/membership.entity';
import { User } from '../accounts/entities/user.entity';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService, asCustomerSees } from '../audit/audit.service';
import { CreditService } from '../billing/credit.service';
import { LedgerEvents } from '../billing/ledger/ledger-events';
import { LedgerService } from '../billing/ledger/ledger.service';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { FunctionInvocation, InvocationStatus } from '../functions/entities/function-invocation.entity';
import { Function, FunctionStatus, Runtime } from '../functions/entities/function.entity';
import { FunctionsService } from '../functions/functions.service';
import { capturingMail } from '../mail/capturing-mail';
import { Orchestrator } from '../orchestrator/orchestrator.types';
import { PlansService } from '../plans/plans.service';
import { UsageRecord } from '../usage/usage-record.entity';
import { UsageService } from '../usage/usage.service';
import { AdminAccountsService } from './admin-accounts.service';
import { AdminCreditsService } from './admin-credits.service';
import { AdminSupportService } from './admin-support.service';
import { PlatformSetting } from './platform-setting.entity';
import { PlatformSettingsService } from './platform-settings.service';
import { Plan } from '../accounts/entities/plan.entity';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const OPERATOR = { id: 'operator:kc-op-1', label: 'operator@ff.test' };
/** What the customer's users sent and got back: it must appear nowhere but in a look given for a reason. */
const PRIVATE = 'amira@example.tn';

run('support, for operators (L2)', () => {
  let db: ScratchDatabase;
  let support: AdminSupportService;
  let audit: AuditService;
  const logs = jest.fn(async () => ({ lines: [], next: null }));
  let n = 0;

  const query = <T = unknown>(sql: string, parameters?: unknown[]) => db.dataSource.query<T>(sql, parameters);
  async function account(name: string, ownerEmail: string): Promise<string> {
    const id = String(500000000000 + ++n);
    await db.dataSource.getRepository(Account).save({ id, name, planId: 'beta', status: AccountStatus.ACTIVE });
    const user = await db.dataSource.getRepository(User).save({ oidcSub: `kc-${ownerEmail}`, email: ownerEmail, name: null });
    await db.dataSource.getRepository(Membership).save({ accountId: id, userId: user.id, role: 'owner' });
    return id;
  }
  const fn = (accountId: string, name: string) =>
    db.dataSource.getRepository(Function).save({
      name,
      accountId,
      runtime: Runtime.NODEJS,
      code: 'export const handler = async (event) => ({ hello: event.body.email });',
      memory: 256,
      timeout: 10,
      minInstances: 1,
      maxInstances: 3,
      status: FunctionStatus.ACTIVE,
    });
  /** A call `secondsAgo` before the database's now, with its usage record; `kept` false: only its record, as after the history's purge. */
  async function called(f: Function, secondsAgo: number, status: InvocationStatus, error: string | null = null, kept = true): Promise<string> {
    const [{ id }] = await query<Array<{ id: string }>>('SELECT gen_random_uuid() AS id');
    if (kept) {
      await query(
        `INSERT INTO function_invocations (id, function_id, input, output, status, error, duration, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 12.5, now() - make_interval(secs => $7), now() - make_interval(secs => $7))`,
        [id, f.id, JSON.stringify({ email: PRIVATE }), JSON.stringify({ hello: PRIVATE }), status, error, secondsAgo],
      );
    }
    await query(`SELECT ff_ensure_month_partition('usage_records', date_trunc('month', (now() - make_interval(secs => $1)) AT TIME ZONE 'UTC')::date)`, [secondsAgo]);
    const usageStatus = { COMPLETED: 'success', ERROR: 'error', TIMEOUT: 'timeout', THROTTLED: 'throttled', LOST: 'lost' }[status as string] ?? 'success';
    await query(
      `INSERT INTO usage_records (request_id, started_at, ended_at, account_id, function_id, function_name, runtime, memory_mb, duration_ms, billed_ms, status)
       VALUES ($1, now() - make_interval(secs => $2), now() - make_interval(secs => $2), $3, $4, $5, 'nodejs', 256, 12.5, 13, $6)`,
      [id, secondsAgo, f.accountId, f.id, f.name, usageStatus],
    );
    return id;
  }
  const entriesOf = (accountId: string) => db.dataSource.getRepository(AuditEntry).find({ where: { accountId }, order: { id: 'ASC' } });

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    const ds = db.dataSource;
    audit = new AuditService(ds.getRepository(AuditEntry));
    // As the request context would name the operator: the audit service takes the actor from it.
    const record = audit.record.bind(audit);
    jest.spyOn(audit, 'record').mockImplementation((event, manager) => record({ actor: OPERATOR, ...event }, manager));
    const orchestrator = {} as Orchestrator;
    const config = { get: (_key: string, fallback?: unknown) => fallback, getOrThrow: () => ({ consoleUrl: 'https://console.ff.example' }) } as unknown as ConfigService;
    const mail = capturingMail([]);
    const plans = new PlansService(ds.getRepository(Plan), ds.getRepository(Account), orchestrator, audit);
    const ledger = new LedgerService(ds);
    const settings = new PlatformSettingsService(ds.getRepository(PlatformSetting), audit);
    const credits = new AdminCreditsService(ds, ledger, new CreditService(ds, settings, new LedgerEvents(ds)), settings, audit, mail, config);
    const accounts = new AdminAccountsService(
      ds.getRepository(Account),
      ds.getRepository(Membership),
      ds.getRepository(Function),
      orchestrator,
      audit,
      plans,
      new UsageService(ds.getRepository(UsageRecord), ds, config),
      ledger,
      mail,
      config,
      credits,
      settings,
    );
    support = new AdminSupportService(ds.getRepository(Function), ds.getRepository(FunctionInvocation), accounts, { logs } as unknown as FunctionsService, audit);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await db?.drop();
  });

  beforeEach(() => logs.mockClear());

  it("finds an account by a member's e-mail, a function by its ID or a part of its name, and a call by its request ID, from the history or, once purged, from its usage record", async () => {
    const id = await account('Support Labs', 'owner@support-labs.test');
    const invoices = await fn(id, 'invoice_pdf');
    await fn(id, 'invoiceXpdf'); // what "_" would match, were it a pattern
    const kept = await called(invoices, 60, InvocationStatus.COMPLETED);
    const purged = await called(invoices, 40 * 86_400, InvocationStatus.ERROR, null, false);

    const byEmail = await support.search('OWNER@support-labs');
    expect([byEmail.accounts.map((a) => a.id), byEmail.functions, byEmail.calls]).toEqual([[id], [], []]);

    const byId = await support.search(invoices.id.toUpperCase());
    expect(byId.functions).toEqual([{ id: invoices.id, name: 'invoice_pdf', runtime: 'nodejs', status: 'ACTIVE', accountId: id, accountName: 'Support Labs' }]);
    expect(byId.calls).toEqual([]);
    // The name in part; "_" as itself, not as any character.
    expect((await support.search('ice_p')).functions.map((f) => f.id)).toEqual([invoices.id]);
    expect((await support.search('ice-p')).functions).toEqual([]);

    expect((await support.search(kept)).calls).toEqual([
      { requestId: kept, functionId: invoices.id, functionName: 'invoice_pdf', accountId: id, status: 'COMPLETED', at: expect.any(Date), inHistory: true, functionExists: true },
    ]);
    expect((await support.search(` ${purged.toUpperCase()} `)).calls).toEqual([
      { requestId: purged, functionId: invoices.id, functionName: 'invoice_pdf', accountId: id, status: 'ERROR', at: expect.any(Date), inHistory: false, functionExists: true },
    ]);
    // Searching is no look at the customer's data: nothing recorded.
    expect(await entriesOf(id)).toEqual([]);
  });

  it("finds a call whose function was deleted since, by its usage record, which keeps the function's name", async () => {
    const id = await account('Gone Labs', 'owner@gone-labs.test');
    const gone = await fn(id, 'old-report');
    const call = await called(gone, 120, InvocationStatus.TIMEOUT);
    await db.dataSource.getRepository(Function).delete({ id: gone.id });

    expect((await support.search(call)).calls).toEqual([
      { requestId: call, functionId: gone.id, functionName: 'old-report', accountId: id, status: 'TIMEOUT', at: expect.any(Date), inHistory: false, functionExists: false },
    ]);
  });

  it("gives a function's page: its settings, its account, its recent calls and failures with their error types, and none of its customer's data", async () => {
    const id = await account('Page Labs', 'owner@page-labs.test');
    const f = await fn(id, 'checkout');
    const calls = [];
    for (let i = 0; i < 22; i++) calls.push(await called(f, 3000 - i * 10, InvocationStatus.COMPLETED));
    const failed = await called(f, 5, InvocationStatus.ERROR, `ValidationError: no account for ${PRIVATE}`);
    const timedOut = await called(f, 2, InvocationStatus.TIMEOUT, 'Sandbox.Timedout: Task timed out after 10.00 seconds');

    const page = await support.functionPage(f.id);

    expect(page.function).toEqual({
      id: f.id,
      name: 'checkout',
      runtime: 'nodejs',
      memory: 256,
      timeout: 10,
      minInstances: 1,
      maxInstances: 3,
      status: 'ACTIVE',
      error: null,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    expect([page.account.id, page.account.owners.map((o) => o.email)]).toEqual([id, ['owner@page-labs.test']]);
    expect(page.recentCalls.map((c) => c.id)).toEqual([timedOut, failed, ...calls.slice(-18).reverse()]);
    expect(page.recentErrors.map((c) => [c.id, c.status, c.errorType])).toEqual([
      [timedOut, 'TIMEOUT', 'Sandbox.Timedout'],
      [failed, 'ERROR', 'ValidationError'],
    ]);
    expect(Object.keys(page.recentCalls[0]).sort()).toEqual(['createdAt', 'duration', 'errorType', 'id', 'memoryUsed', 'status']);
    expect(JSON.stringify(page)).not.toContain(PRIVATE);
    expect(JSON.stringify(page)).not.toContain('export const handler');
    expect(await entriesOf(id)).toEqual([]);
    await expect(support.functionPage('00000000-0000-4000-8000-000000000000')).rejects.toThrow(NotFoundException);
  });

  it("gives the code, a call's data and the logs for a reason, each look in the customer's audit log, which the customer reads as FF's with the reason", async () => {
    const id = await account('Look Labs', 'owner@look-labs.test');
    const f = await fn(id, 'mailer');
    const call = await called(f, 30, InvocationStatus.ERROR, `ValidationError: no account for ${PRIVATE}`);

    expect(await support.viewCode(f.id, 'The customer asked us to check their handler')).toEqual({ runtime: 'nodejs', code: f.code });
    expect(await support.viewCall(f.id, call, 'Ticket 42: why this call failed')).toMatchObject({
      id: call,
      status: 'ERROR',
      errorType: 'ValidationError',
      input: { email: PRIVATE },
      output: { hello: PRIVATE },
      error: `ValidationError: no account for ${PRIVATE}`,
      inputTruncated: false,
      outputTruncated: false,
      errorTruncated: false,
    });
    expect(await support.viewLogs(f.id, 'Ticket 42: its lines', { requestId: call, sinceSeconds: 3600 })).toEqual({ lines: [], next: null });
    expect(logs).toHaveBeenCalledWith(id, f.id, { requestId: call, sinceSeconds: 3600 });

    const entries = await entriesOf(id);
    expect(entries.map((e) => [e.action, e.actor, e.resource, e.details])).toEqual([
      ['support.view_code', OPERATOR.id, `function:${f.id}`, { reason: 'The customer asked us to check their handler' }],
      ['support.view_invocation', OPERATOR.id, `invocation:${call}`, { reason: 'Ticket 42: why this call failed', functionId: f.id }],
      ['support.view_logs', OPERATOR.id, `function:${f.id}`, { reason: 'Ticket 42: its lines', requestId: call, sinceSeconds: 3600 }],
    ]);
    // GET /audit-log, as the account's owner reads it.
    const { entries: seen } = await audit.list(id, { limit: 10 });
    expect(seen.map(asCustomerSees).map((e) => [e.action, e.actor, e.actorLabel, e.ip])).toEqual([
      ['support.view_logs', 'operator', 'FF', null],
      ['support.view_invocation', 'operator', 'FF', null],
      ['support.view_code', 'operator', 'FF', null],
    ]);
  });

  it("refuses a call of another function, one still running, and a function that doesn't exist, recording nothing", async () => {
    const id = await account('Refused Labs', 'owner@refused-labs.test');
    const f = await fn(id, 'a');
    const other = await fn(id, 'b');
    const otherCall = await called(other, 30, InvocationStatus.COMPLETED);
    const running = await called(f, 1, InvocationStatus.RUNNING);

    await expect(support.viewCall(f.id, otherCall, 'Checking')).rejects.toThrow(new NotFoundException(`The history has no call ${otherCall} of function ${f.id}`));
    await expect(support.viewCall(f.id, running, 'Checking')).rejects.toThrow(NotFoundException);
    await expect(support.viewCode('00000000-0000-4000-8000-000000000000', 'Checking')).rejects.toThrow(NotFoundException);
    expect(await entriesOf(id)).toEqual([]);
  });

  it("gives nothing when the look can't be recorded", async () => {
    const id = await account('Unrecorded Labs', 'owner@unrecorded-labs.test');
    const f = await fn(id, 'secret');
    await query(`
      CREATE FUNCTION refuse_look() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'no audit today'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER refuse_look BEFORE INSERT ON audit_log FOR EACH ROW WHEN (NEW.action LIKE 'support.%') EXECUTE FUNCTION refuse_look();`);
    try {
      await expect(support.viewCode(f.id, 'Checking')).rejects.toThrow('no audit today');
    } finally {
      await query('DROP TRIGGER refuse_look ON audit_log; DROP FUNCTION refuse_look();');
    }
  });
});

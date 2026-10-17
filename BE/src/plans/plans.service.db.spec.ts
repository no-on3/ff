/**
 * L2: plans and their limits against a real PostgreSQL server (client-readiness
 * plan, P-15, D5), in a scratch database that is dropped after: the beta plan
 * as the migration leaves it, each account's plan, plan changes, and the
 * number of functions a plan allows when creates arrive at once.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { Plan } from '../accounts/entities/plan.entity';
import { databaseConfiguration } from '../config/configuration';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { FunctionInvocation } from '../functions/entities/function-invocation.entity';
import { Function, Runtime } from '../functions/entities/function.entity';
import { FunctionsService } from '../functions/functions.service';
import { Orchestrator, TenantLimits } from '../orchestrator/orchestrator.types';
import { PLAN_CACHE_MS, PlansService } from './plans.service';
import { BETA_LIMITS } from './test-fixtures';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;

run('plans (L2, P-15)', () => {
  let db: ScratchDatabase;
  let plans: PlansService;
  let audit: AuditService;
  const applied: Array<{ accountId: string; tenant: TenantLimits }> = [];
  const orchestrator = {
    applyTenantLimits: async (accountId: string, tenant: TenantLimits) => void applied.push({ accountId, tenant }),
    deploy: async () => undefined,
    waitUntilReady: async () => undefined,
  } as unknown as Orchestrator;
  let n = 0;

  /** A new active account on the plan. */
  async function account(planId = 'beta'): Promise<string> {
    const id = String(200000000000 + ++n);
    await db.dataSource.getRepository(Account).save({ id, name: `Account ${n}`, planId, status: AccountStatus.ACTIVE });
    return id;
  }
  const addPlan = (id: string, limits: object) =>
    db.dataSource.getRepository(Plan).save({ id, name: id[0].toUpperCase() + id.slice(1), limits: limits as Record<string, unknown> });
  const planOf = async (id: string) => (await db.dataSource.getRepository(Account).findOneByOrFail({ id })).planId;

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    audit = new AuditService(db.dataSource.getRepository(AuditEntry));
    plans = new PlansService(db.dataSource.getRepository(Plan), db.dataSource.getRepository(Account), orchestrator, audit);
  });

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(() => {
    applied.length = 0;
  });

  it("reads the beta plan's limits as the migration wrote them", async () => {
    await expect(plans.get('beta')).resolves.toEqual({ id: 'beta', name: 'Beta', limits: BETA_LIMITS });
  });

  it("finds an account's plan, and several accounts' plans in one query", async () => {
    await addPlan('pro', { ...BETA_LIMITS, functions: 100 });
    const onBeta = await account();
    const onPro = await account('pro');

    await expect(plans.forAccount(onPro)).resolves.toMatchObject({ id: 'pro', limits: { functions: 100 } });
    const found = await plans.forAccounts([onBeta, onPro, onBeta, '999999999999']);
    expect(Object.fromEntries([...found].map(([id, plan]) => [id, plan.id]))).toEqual({ [onBeta]: 'beta', [onPro]: 'pro' });
    await expect(plans.forAccount('999999999999')).rejects.toThrow(new NotFoundException('Account 999999999999 not found'));
  });

  it('refuses to use a plan whose limits are wrong, naming the plan and the limit', async () => {
    await addPlan('broken', { ...BETA_LIMITS, memoryMb: 'lots' });

    await expect(plans.get('broken')).rejects.toThrow(
      'The plan "broken" has invalid limits: memoryMb: Invalid input: expected number, received string',
    );
  });

  it('sees a change to a plan within a minute, or at once when it reads the plan fresh', async () => {
    await addPlan('changing', BETA_LIMITS);
    const t0 = Date.now();
    await plans.get('changing', { now: t0 });
    await db.dataSource.getRepository(Plan).update('changing', { limits: { ...BETA_LIMITS, functions: 7 } });

    await expect(plans.get('changing', { now: t0 + PLAN_CACHE_MS - 1 })).resolves.toMatchObject({ limits: { functions: 25 } });
    await expect(plans.get('changing', { now: t0 + 1, fresh: true })).resolves.toMatchObject({ limits: { functions: 7 } });
    await db.dataSource.getRepository(Plan).update('changing', { limits: { ...BETA_LIMITS, functions: 8 } });
    await expect(plans.get('changing', { now: t0 + 1 + PLAN_CACHE_MS })).resolves.toMatchObject({ limits: { functions: 8 } });
  });

  it("moves an account to another plan, and applies the new plan's quota to its namespace at once", async () => {
    await addPlan('large', { ...BETA_LIMITS, quota: { pods: 60, cpu: '24', memory: '24Gi' } });
    const id = await account();

    await expect(plans.assign(id, 'large')).resolves.toMatchObject({ id: 'large', name: 'Large' });

    expect(await planOf(id)).toBe('large');
    expect(applied).toEqual([{ accountId: id, tenant: { quota: { pods: 60, cpu: '24', memory: '24Gi' } } }]);
  });

  it("refuses a plan or an account that doesn't exist, and changes nothing", async () => {
    const id = await account();

    await expect(plans.assign(id, 'imaginary')).rejects.toThrow(new NotFoundException('Plan imaginary not found'));
    await expect(plans.assign('999999999999', 'beta')).rejects.toThrow(new NotFoundException('Account 999999999999 not found'));
    expect(await planOf(id)).toBe('beta');
    expect(applied).toEqual([]);
  });

  it("lets only one of several creates at once take an account's last function", async () => {
    await addPlan('two', { ...BETA_LIMITS, functions: 2 });
    const id = await account('two');
    const functions = new FunctionsService(
      db.dataSource.getRepository(Function),
      db.dataSource.getRepository(FunctionInvocation),
      { uploadCode: async () => undefined } as never,
      orchestrator,
      { get: (_key: string, fallback?: unknown) => fallback } as never,
      {} as never,
      plans,
      audit,
      {} as never, // creates only: no usage
    );
    const create = (name: string) => functions.create(id, { name, runtime: Runtime.NODEJS, code: 'x', memory: 128, timeout: 5 });
    await create('first');
    // Each insert now takes 200 ms, so creates that didn't wait for each other would all count 1 before any insert lands.
    await db.dataSource.query(`
      CREATE FUNCTION slow_insert() RETURNS trigger AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER slow_insert BEFORE INSERT ON functions FOR EACH ROW EXECUTE FUNCTION slow_insert();`);

    const outcomes = await Promise.allSettled([create('a'), create('b'), create('c')]);
    await db.dataSource.query('DROP TRIGGER slow_insert ON functions; DROP FUNCTION slow_insert();');

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const refusals = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    expect(refusals.map((refusal) => refusal.reason)).toEqual([
      new BadRequestException('The Two plan allows 2 functions per account: delete one first'),
      new BadRequestException('The Two plan allows 2 functions per account: delete one first'),
    ]);
    expect(await db.dataSource.getRepository(Function).countBy({ accountId: id })).toBe(2);
  });
});

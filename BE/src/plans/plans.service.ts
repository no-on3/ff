import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isDeepStrictEqual } from 'node:util';
import { In, QueryFailedError, Repository } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { Plan } from '../accounts/entities/plan.entity';
import { AuditService } from '../audit/audit.service';
import { ORCHESTRATOR, Orchestrator, TenantLimits } from '../orchestrator/orchestrator.types';
import { describeError } from '../common/describe-error';
import { PlanLimits, PlanView, parsePlanLimits, planLimitsSchema } from './plan-limits';

/** How long a plan read from the database is used: a change (P-73) applies within this time. */
export const PLAN_CACHE_MS = 60_000;

/** What the scheduler applies to the whole account: its plan's quota, and the account's own internet egress. */
export const tenantLimits = (limits: PlanLimits, internetEgress: boolean): TenantLimits => ({ quota: limits.quota, internetEgress });

/**
 * Plans and their limits (D5). Every account has one, `beta` to start. A plan
 * is read once a minute at most, so checking limits on each request costs no
 * query; an account's plan ID is read with the account.
 */
@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);
  private readonly cache = new Map<string, { plan: PlanView; until: number }>();

  constructor(
    @InjectRepository(Plan) private readonly plans: Repository<Plan>,
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
    @Inject(ORCHESTRATOR) private readonly orchestrator: Orchestrator,
    private readonly audit: AuditService,
  ) {}

  /** A plan, with its limits checked. A plan that doesn't exist, or whose limits are wrong, is a platform failure. */
  async get(planId: string, { fresh = false, now = Date.now() } = {}): Promise<PlanView> {
    const cached = this.cache.get(planId);
    if (!fresh && cached && cached.until > now) return cached.plan;
    const row = await this.plans.findOne({ where: { id: planId } });
    if (!row) throw new Error(`The plan "${planId}" doesn't exist`);
    const plan: PlanView = { id: row.id, name: row.name, limits: parsePlanLimits(row.id, row.limits) };
    this.cache.set(planId, { plan, until: now + PLAN_CACHE_MS });
    return plan;
  }

  /** The plan of an account. */
  async forAccount(accountId: string): Promise<PlanView> {
    const account = await this.accounts.findOne({ where: { id: accountId }, select: { id: true, planId: true } });
    if (!account) throw new NotFoundException(`Account ${accountId} not found`);
    return this.get(account.planId);
  }

  /**
   * Runs `write`, a deploy or anything else that writes the account's namespace, with what the scheduler applies
   * to the account as a whole: its plan's quota and its internet egress, read under a share lock on the account.
   * An operator's change to either holds the account for update while it applies its own, so it waits for a write
   * under way, and a write that read the old value can't put it back after the change.
   */
  async withTenant<T>(accountId: string, write: (tenant: TenantLimits) => Promise<T>): Promise<T> {
    return this.accounts.manager.transaction(async (manager) => {
      const account = await manager.findOne(Account, {
        where: { id: accountId },
        select: { id: true, planId: true, internetEgress: true },
        lock: { mode: 'pessimistic_read' },
      });
      if (!account) throw new NotFoundException(`Account ${accountId} not found`);
      return write(tenantLimits((await this.get(account.planId)).limits, account.internetEgress));
    });
  }

  /** The plans of several accounts, in one query: the idle sweep needs each function's. */
  async forAccounts(accountIds: string[]): Promise<Map<string, PlanView>> {
    const ids = [...new Set(accountIds)];
    const accounts = ids.length ? await this.accounts.find({ where: { id: In(ids) }, select: { id: true, planId: true } }) : [];
    const plans = new Map<string, PlanView>();
    for (const account of accounts) plans.set(account.id, await this.get(account.planId));
    return plans;
  }

  /**
   * PUT /admin/plans/:id (P-73): new limits, and maybe a new name, for an
   * operator's reason, in one transaction with the audit entry that says each
   * change, from what to what. They apply at once: this process reads the plan
   * fresh, and a changed quota goes to every account on the plan (an account
   * without a namespace gets it with its first deploy). Unchanged, nothing is
   * written. Each account's quota is applied under a lock on the account, as
   * withTenant explains.
   */
  async update(planId: string, change: { name?: string; limits: unknown }, reason: string): Promise<{ plan: PlanView; quota: { applied: number; failed: number } }> {
    const limits = checkedLimits(change.limits);
    const quotaChanged = await this.plans.manager.transaction(async (manager) => {
      const row = await manager.findOne(Plan, { where: { id: planId }, lock: { mode: 'pessimistic_write' } });
      if (!row) throw new NotFoundException(`Plan ${planId} not found`);
      const before = row.limits;
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (change.name !== undefined && change.name !== row.name) changes.name = { from: row.name, to: change.name };
      for (const [key, value] of Object.entries(limits)) if (!isDeepStrictEqual(before[key], value)) changes[key] = { from: before[key] ?? null, to: value };
      if (Object.keys(changes).length === 0) return false;
      await manager.save(Plan, { ...row, name: change.name ?? row.name, limits: limits });
      await this.audit.record({ accountId: null, action: 'plan.update', resource: `plan:${planId}`, details: { reason, changes } }, manager);
      return 'quota' in changes;
    });
    const quota = { applied: 0, failed: 0 };
    // Read fresh, which also puts the new limits in this process's cache at once, for withTenant.
    const plan = await this.get(planId, { fresh: true });
    if (quotaChanged) {
      for (const account of await this.accounts.find({ where: { planId }, select: { id: true } })) {
        try {
          await this.withTenant(account.id, (tenant) => this.orchestrator.applyTenantLimits(account.id, tenant));
          quota.applied++;
        } catch (error) {
          quota.failed++;
          this.logger.error(`Could not apply plan ${planId}'s quota to account ${account.id}: ${describeError(error)}`);
        }
      }
    }
    return { plan, quota };
  }

  /** POST /admin/plans (P-73): a plan accounts can be moved to, with its audit entry. */
  async create(id: string, name: string, limits: unknown, reason: string): Promise<PlanView> {
    const checked = checkedLimits(limits);
    const taken = `Plan ${id} exists already`;
    try {
      await this.plans.manager.transaction(async (manager) => {
        if (await manager.exists(Plan, { where: { id } })) throw new ConflictException(taken);
        await manager.save(Plan, manager.create(Plan, { id, name, limits: checked as unknown as Record<string, unknown> }));
        await this.audit.record({ accountId: null, action: 'plan.create', resource: `plan:${id}`, details: { reason, name, limits: checked } }, manager);
      });
    } catch (error) {
      // Two at once: the primary key took the other one.
      if (error instanceof QueryFailedError && (error as QueryFailedError & { code?: string }).code === '23505') throw new ConflictException(taken);
      throw error;
    }
    return this.get(id, { fresh: true });
  }

  /** Every plan, by ID: the admin dashboard's choice of plans (P-71). */
  async list(): Promise<PlanView[]> {
    const rows = await this.plans.find({ order: { id: 'ASC' } });
    return Promise.all(rows.map((row) => this.get(row.id, { fresh: true })));
  }

  /**
   * Moves an account to another plan, for an operator's reason (P-71), in one
   * transaction with the audit entry, and applies the plan's quota to the
   * account's namespace at once, under the account's lock: a deploy under
   * way can't put the old quota back (withTenant), and if the cluster refuses
   * it, nothing changes. The same plan writes nothing, but applies the quota
   * again: a retry after the cluster refused it.
   */
  async assign(accountId: string, planId: string, reason: string): Promise<PlanView> {
    if (!(await this.plans.exists({ where: { id: planId } }))) throw new NotFoundException(`Plan ${planId} not found`);
    const plan = await this.get(planId, { fresh: true });
    await this.accounts.manager.transaction(async (manager) => {
      const account = await manager.findOne(Account, { where: { id: accountId }, lock: { mode: 'pessimistic_write' } });
      if (!account) throw new NotFoundException(`Account ${accountId} not found`);
      if (account.planId !== planId) {
        await manager.update(Account, { id: accountId }, { planId });
        await this.audit.record(
          { accountId, action: 'account.plan', resource: `account:${accountId}`, details: { reason, changes: { planId: { from: account.planId, to: planId } } } },
          manager,
        );
      }
      await this.orchestrator.applyTenantLimits(accountId, tenantLimits(plan.limits, account.internetEgress));
    });
    return plan;
  }
}

/** Limits as D5 has them, or 400 naming each one that doesn't fit. */
function checkedLimits(limits: unknown): PlanLimits {
  const parsed = planLimitsSchema.safeParse(limits);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((issue) => `limits.${issue.path.join('.')}: ${issue.message}`));
  return parsed.data;
}

import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { Plan } from '../accounts/entities/plan.entity';
import { AuditService } from '../audit/audit.service';
import { ORCHESTRATOR, Orchestrator, TenantLimits } from '../orchestrator/orchestrator.types';
import { PlanLimits, PlanView, parsePlanLimits } from './plan-limits';

/** How long a plan read from the database is used: a change (P-73) applies within this time. */
export const PLAN_CACHE_MS = 60_000;

/** What the scheduler applies to the whole account, from its plan. */
export const tenantLimits = (limits: PlanLimits): TenantLimits => ({ quota: limits.quota });

/**
 * Plans and their limits (D5). Every account has one, `beta` to start. A plan
 * is read once a minute at most, so checking limits on each request costs no
 * query; an account's plan ID is read with the account.
 */
@Injectable()
export class PlansService {
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

  /** The plans of several accounts, in one query: the idle sweep needs each function's. */
  async forAccounts(accountIds: string[]): Promise<Map<string, PlanView>> {
    const ids = [...new Set(accountIds)];
    const accounts = ids.length ? await this.accounts.find({ where: { id: In(ids) }, select: { id: true, planId: true } }) : [];
    const plans = new Map<string, PlanView>();
    for (const account of accounts) plans.set(account.id, await this.get(account.planId));
    return plans;
  }

  /** Every plan, by ID: the admin dashboard's choice of plans (P-71). */
  async list(): Promise<PlanView[]> {
    const rows = await this.plans.find({ order: { id: 'ASC' } });
    return Promise.all(rows.map((row) => this.get(row.id, { fresh: true })));
  }

  /**
   * Moves an account to another plan, for an operator's reason (P-71), in one
   * transaction with the audit entry, then applies the plan's quota to the
   * account's namespace at once (D5). The same plan writes nothing, but
   * applies the quota again: a retry after the cluster refused it.
   */
  async assign(accountId: string, planId: string, reason: string): Promise<PlanView> {
    if (!(await this.plans.exists({ where: { id: planId } }))) throw new NotFoundException(`Plan ${planId} not found`);
    const plan = await this.get(planId, { fresh: true });
    await this.accounts.manager.transaction(async (manager) => {
      const account = await manager.findOne(Account, { where: { id: accountId }, lock: { mode: 'pessimistic_write' } });
      if (!account) throw new NotFoundException(`Account ${accountId} not found`);
      if (account.planId === planId) return;
      await manager.update(Account, { id: accountId }, { planId });
      await this.audit.record(
        { accountId, action: 'account.plan', resource: `account:${accountId}`, details: { reason, changes: { planId: { from: account.planId, to: planId } } } },
        manager,
      );
    });
    await this.orchestrator.applyTenantLimits(accountId, tenantLimits(plan.limits));
    return plan;
  }
}

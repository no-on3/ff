import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { Membership } from '../accounts/entities/membership.entity';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditPage, AuditService } from '../audit/audit.service';
import { LedgerService } from '../billing/ledger/ledger.service';
import { formatMinor } from '../billing/money';
import { describeError } from '../common/describe-error';
import { DatabasesService } from '../databases/databases.service';
import { frenchTime } from '../common/french';
import { likeLiteral } from '../common/like';
import { Function, FunctionStatus } from '../functions/entities/function.entity';
import { Language, recipientsOf } from '../mail/language';
import { Mail, MailService } from '../mail/mail.service';
import { ORCHESTRATOR, Orchestrator } from '../orchestrator/orchestrator.types';
import { PlansService, tenantLimits } from '../plans/plans.service';
import { UsageService } from '../usage/usage.service';
import { AdminCreditsService } from './admin-credits.service';
import { PlatformSettingsService } from './platform-settings.service';
import { STATUS_CHANGES, StatusChange, statusChangeProblem, stopsFunctions } from './account-status-changes';
import {
  ACCOUNTS_CURSOR,
  AccountPersonView,
  AdminAccountPageView,
  AdminAccountSummaryView,
  AdminAccountView,
  AdminStatusEventView,
} from './admin-accounts.dto';

/** GET /admin/accounts' filters; every one given must match. */
export interface AccountsFilter {
  /** Part of the account's ID or name, or of a member's e-mail, in any case. */
  q?: string;
  status?: AccountStatus;
  planId?: string;
}

const person = (membership: Membership): AccountPersonView => ({ email: membership.user?.email ?? '', name: membership.user?.name ?? null });

function summary(account: Account, owners: AccountPersonView[]): AdminAccountSummaryView {
  const { id, name, status, planId, country, taxId, useCase, internetEgress, createdAt, dataDeletionDueAt, dataDeletedAt } = account;
  return { id, name, status, planId, country: country.trim(), taxId, useCase, internetEgress, createdAt, dataDeletionDueAt, dataDeletedAt, owners };
}

const DAY_MS = 86_400_000;

/** A time, to the minute, as e-mails write it: "2026-11-17 at 10:32 UTC". */
export const utcMinute = (at: Date): string => `${at.toISOString().slice(0, 16).replace('T', ' at ')} UTC`;

/** A status the account went through, from its audit entry: its creation, or an operator's change. */
function statusEvent(entry: AuditEntry): AdminStatusEventView {
  const change = entry.action.slice('account.'.length) as StatusChange;
  return {
    at: entry.at,
    action: entry.action,
    status: entry.action === 'account.create' ? AccountStatus.PENDING : STATUS_CHANGES[change].to,
    by: entry.actorLabel,
    reason: typeof entry.details?.reason === 'string' ? entry.details.reason : null,
  };
}

/**
 * The e-mail an account's owners get when an operator changes its status, in
 * their language. A refusal, a suspension and a closure say why: the owners
 * also read the reason in their audit log.
 */
export function ownerMail(
  account: Pick<Account, 'id' | 'name' | 'dataDeletionDueAt'>,
  change: StatusChange,
  reason: string,
  consoleUrl: string,
  language: Language,
): Omit<Mail, 'to'> {
  if (language === 'fr') return frenchOwnerMail(account, change, reason, consoleUrl);
  const which = `Your account "${account.name}" (${account.id})`;
  // A closed account's data is deleted once its notice period has passed; until then its members can still read it.
  const deletion = account.dataDeletionDueAt
    ? [
        '',
        `Its functions, their invocation history and their logs will be deleted on ${utcMinute(account.dataDeletionDueAt)}. Until then, its members can read them in the console: ${consoleUrl}`,
        'Its usage, payments and invoices are kept, as the law requires.',
      ]
    : [];
  const lines: Record<StatusChange, [string, string[]]> = {
    approve: ['is approved', [`${which} is approved: you can deploy and invoke functions now.`, '', `The console: ${consoleUrl}`]],
    reject: ['was not approved', [`${which} was not approved.`, `Why: ${reason}`]],
    suspend: [
      'is suspended',
      [`${which} is suspended: its functions are stopped, and can't be deployed or invoked until it is reactivated. Nothing is deleted.`, `Why: ${reason}`],
    ],
    reactivate: ['is active again', [`${which} is active again: you can deploy and invoke functions.`, '', `The console: ${consoleUrl}`]],
    close: ['is closed', [`${which} is closed: its functions are stopped, and can't be deployed or invoked.`, `Why: ${reason}`, ...deletion]],
  };
  const [what, text] = lines[change];
  return { subject: `Your FF account ${what}: ${account.name}`, text: text.join('\n') };
}

function frenchOwnerMail(account: Pick<Account, 'id' | 'name' | 'dataDeletionDueAt'>, change: StatusChange, reason: string, consoleUrl: string): Omit<Mail, 'to'> {
  const which = `Votre compte « ${account.name} » (${account.id})`;
  const deletion = account.dataDeletionDueAt
    ? [
        '',
        `Ses fonctions, l'historique de leurs invocations et leurs journaux seront supprimés le ${frenchTime(account.dataDeletionDueAt)}. D'ici là, ses membres peuvent les consulter dans la console : ${consoleUrl}`,
        'Sa consommation, ses paiements et ses factures sont conservés, comme la loi l\'exige.',
      ]
    : [];
  const lines: Record<StatusChange, [string, string[]]> = {
    approve: ['est approuvé', [`${which} est approuvé : vous pouvez déployer et invoquer des fonctions dès maintenant.`, '', `La console : ${consoleUrl}`]],
    reject: ["n'a pas été approuvé", [`${which} n'a pas été approuvé.`, `Motif : ${reason}`]],
    suspend: [
      'est suspendu',
      [
        `${which} est suspendu : ses fonctions sont arrêtées, et ne peuvent être ni déployées ni invoquées jusqu'à sa réactivation. Rien n'est supprimé.`,
        `Motif : ${reason}`,
      ],
    ],
    reactivate: ['est de nouveau actif', [`${which} est de nouveau actif : vous pouvez déployer et invoquer des fonctions.`, '', `La console : ${consoleUrl}`]],
    close: ['est fermé', [`${which} est fermé : ses fonctions sont arrêtées, et ne peuvent être ni déployées ni invoquées.`, `Motif : ${reason}`, ...deletion]],
  };
  const [what, text] = lines[change];
  return { subject: `Votre compte FF ${what} : ${account.name}`, text: text.join('\n') };
}

/**
 * Accounts, for FF's operators (P-71, D2, D12): the list and the approvals
 * queue, the account page, and the changes an operator makes, each with its
 * reason in the audit log under the account, so its owners see it too.
 */
@Injectable()
export class AdminAccountsService {
  private readonly logger = new Logger(AdminAccountsService.name);

  constructor(
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
    @InjectRepository(Membership) private readonly memberships: Repository<Membership>,
    @InjectRepository(Function) private readonly functions: Repository<Function>,
    @Inject(ORCHESTRATOR) private readonly orchestrator: Orchestrator,
    private readonly audit: AuditService,
    private readonly plans: PlansService,
    private readonly usage: UsageService,
    private readonly ledger: LedgerService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    private readonly credits: AdminCreditsService,
    private readonly settings: PlatformSettingsService,
    private readonly databases: DatabasesService,
  ) {}

  /** GET /admin/accounts: newest first, a page at a time, each with its owners. */
  async list(filter: AccountsFilter, { limit, before }: { limit: number; before?: string }): Promise<AdminAccountPageView> {
    const query = this.accounts
      .createQueryBuilder('account')
      // The cursor keeps PostgreSQL's microseconds, which a JavaScript Date would round off.
      .addSelect(`to_char(account.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`, 'cursor_at')
      .orderBy('account.createdAt', 'DESC')
      .addOrderBy('account.id', 'DESC')
      .limit(limit + 1);
    if (filter.status) query.andWhere('account.status = :status', { status: filter.status });
    if (filter.planId) query.andWhere('account.planId = :planId', { planId: filter.planId });
    const q = filter.q?.trim();
    if (q) {
      query.andWhere(
        `(account.id LIKE :q ESCAPE '\\' OR account.name ILIKE :q ESCAPE '\\' OR account.id IN (
           SELECT m.account_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email ILIKE :q ESCAPE '\\'))`,
        { q: `%${likeLiteral(q)}%` },
      );
    }
    const cursor = before ? ACCOUNTS_CURSOR.exec(before) : null;
    if (cursor) {
      query.andWhere(`(account.created_at, account.id) < (CAST(:beforeAt AS timestamp) AT TIME ZONE 'UTC', :beforeId)`, {
        beforeAt: cursor[1],
        beforeId: cursor[2],
      });
    }
    const { entities, raw } = await query.getRawAndEntities<{ cursor_at: string }>();
    const page = entities.slice(0, limit);
    const owners = await this.ownersOf(page.map((account) => account.id));
    const last = entities.length > limit ? limit - 1 : -1;
    return {
      accounts: page.map((account) => summary(account, owners.get(account.id) ?? [])),
      next: last >= 0 ? `${raw[last].cursor_at}_${page[last].id}` : null,
    };
  }

  /** An account as the list shows it, with its owners: for the pages that name an account, such as a function's. */
  async summaryOf(id: string): Promise<AdminAccountSummaryView> {
    const account = await this.accounts.findOne({ where: { id } });
    if (!account) throw new NotFoundException(`Account ${id} not found`);
    return summary(account, (await this.ownersOf([id])).get(id) ?? []);
  }

  /** GET /admin/accounts/:id: the account page. */
  async detail(id: string): Promise<AdminAccountView> {
    const account = await this.accounts.findOne({ where: { id } });
    if (!account) throw new NotFoundException(`Account ${id} not found`);
    const memberships = await this.memberships.find({ where: { accountId: id }, relations: { user: true }, order: { createdAt: 'ASC' } });
    const functions = await this.functions.find({ where: { accountId: id }, order: { createdAt: 'ASC' } });
    const lastInvoked = await this.usage.lastCalls(functions.map((function_) => function_.id));
    const month = new Date().toISOString().slice(0, 7);
    const { totals } = await this.usage.monthly(id, month);
    return {
      account: summary(account, memberships.filter((membership) => membership.role === 'owner').map(person)),
      members: memberships.map((membership) => ({ userId: membership.userId, ...person(membership), role: membership.role, joinedAt: membership.createdAt })),
      functions: functions.map(({ id: functionId, name, runtime, memory, status, minInstances }) => ({
        id: functionId,
        name,
        runtime,
        memory,
        status,
        minInstances,
        lastInvokedAt: lastInvoked.get(functionId) ?? null,
      })),
      usage: { month, totals },
      balances: (await this.ledger.balances(id)).map(({ currency, exponent, balanceMinor }) => ({ currency, balance: formatMinor(balanceMinor, exponent) })),
      credit: await this.credits.view(id),
      statusHistory: (await this.audit.statusHistory(id)).map(statusEvent),
    };
  }

  /** GET /admin/accounts/:id/audit-log: everything in the account's log, operators named. */
  async auditLog(id: string, page: { limit: number; before?: string }): Promise<AuditPage> {
    if (!(await this.accounts.exists({ where: { id } }))) throw new NotFoundException(`Account ${id} not found`);
    return this.audit.list(id, page);
  }

  /**
   * An operator's status change, with its reason: in one transaction with its
   * audit entry, the account locked so that two operators' changes go one
   * after the other. Then, once committed, what it means for the account's
   * functions, and an e-mail to each owner.
   */
  async changeStatus(id: string, change: StatusChange, reason: string): Promise<AdminAccountView> {
    const rule = STATUS_CHANGES[change];
    // Closing sets the day the account's data is deleted, by the notice period set at that moment; the owners' e-mail gives it.
    const noticeDays = rule.to === AccountStatus.CLOSED ? (await this.settings.get()).closedAccountDeletionDays : undefined;
    const account = await this.accounts.manager.transaction(async (manager) => {
      const current = await manager.findOne(Account, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!current) throw new NotFoundException(`Account ${id} not found`);
      const problem = statusChangeProblem(change, id, current.status);
      if (problem) throw new ConflictException(problem);
      const dataDeletionDueAt = noticeDays === undefined ? null : new Date(Date.now() + noticeDays * DAY_MS);
      await manager.update(Account, { id }, dataDeletionDueAt ? { status: rule.to, dataDeletionDueAt } : { status: rule.to });
      await this.audit.record(
        {
          accountId: id,
          action: `account.${change}`,
          resource: `account:${id}`,
          details: { reason, changes: { status: { from: current.status, to: rule.to } }, ...(dataDeletionDueAt ? { dataDeletionDueAt } : {}) },
        },
        manager,
      );
      return { ...current, status: rule.to, dataDeletionDueAt: dataDeletionDueAt ?? current.dataDeletionDueAt };
    });
    if (stopsFunctions(rule.to)) {
      await this.scaleFunctions(id, () => 0, `its account is ${rule.to}`);
      // Its databases' users can't log in, and their sessions end: a closed account's go at its data deletion date.
      await this.databases.suspendAccount(id);
    }
    // Warm instances come back; the other functions start at their next call.
    if (change === 'reactivate') {
      await this.scaleFunctions(id, (function_) => function_.minInstances, 'its account is active again', (function_) => function_.minInstances > 0);
      await this.databases.reactivateAccount(id);
    }
    await this.tellOwners(account, change, reason);
    return this.detail(id);
  }

  /** PUT /admin/accounts/:id/plan: PlansService.assign, which also applies the plan's quota (P-15). */
  async changePlan(id: string, planId: string, reason: string): Promise<AdminAccountView> {
    await this.plans.assign(id, planId, reason);
    return this.detail(id);
  }

  /**
   * PUT /admin/accounts/:id/egress: whether the account's functions may reach
   * the internet, recorded with its audit entry and written into the
   * account's NetworkPolicy at once, under the account's lock: a deploy under
   * way can't put the old value back (PlansService.withTenant), and if the
   * cluster refuses the policy, nothing changes. The value the account has
   * already writes nothing, but applies the policy again: a retry.
   */
  async setEgress(id: string, internetEgress: boolean, reason: string): Promise<AdminAccountView> {
    await this.accounts.manager.transaction(async (manager) => {
      const current = await manager.findOne(Account, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!current) throw new NotFoundException(`Account ${id} not found`);
      if (current.internetEgress !== internetEgress) {
        await manager.update(Account, { id }, { internetEgress });
        await this.audit.record(
          {
            accountId: id,
            action: 'account.egress',
            resource: `account:${id}`,
            details: { reason, changes: { internetEgress: { from: current.internetEgress, to: internetEgress } } },
          },
          manager,
        );
      }
      const plan = await this.plans.get(current.planId);
      await this.orchestrator.applyTenantLimits(id, tenantLimits(plan.limits, internetEgress));
    });
    return this.detail(id);
  }

  private async ownersOf(accountIds: string[]): Promise<Map<string, AccountPersonView[]>> {
    const owners = new Map<string, AccountPersonView[]>();
    if (accountIds.length === 0) return owners;
    const rows = await this.memberships.find({
      where: { accountId: In(accountIds), role: 'owner' },
      relations: { user: true },
      order: { createdAt: 'ASC' },
    });
    for (const row of rows) owners.set(row.accountId, [...(owners.get(row.accountId) ?? []), person(row)]);
    return owners;
  }

  /**
   * Scales the account's working functions, each on its own: a failure is
   * logged, and the minute's hold (MetricsService) brings a stopped account's
   * functions to zero anyway.
   */
  private async scaleFunctions(
    accountId: string,
    replicas: (function_: Function) => number,
    why: string,
    which: (function_: Function) => boolean = () => true,
  ): Promise<void> {
    const functions = (await this.functions.find({ where: { accountId, status: FunctionStatus.ACTIVE } })).filter(which);
    for (const function_ of functions) {
      try {
        await this.orchestrator.scale(function_, replicas(function_));
      } catch (error) {
        this.logger.error(`Could not scale function ${function_.id} to ${replicas(function_)} (${why}): ${describeError(error)}`);
      }
    }
    if (functions.length) this.logger.log(`Scaled ${functions.length} function(s) of account ${accountId}: ${why}`);
  }

  private async tellOwners(account: Account, change: StatusChange, reason: string): Promise<void> {
    const { consoleUrl } = this.config.getOrThrow<{ consoleUrl: string }>('mail');
    const owners = await this.memberships.find({ where: { accountId: account.id, role: 'owner' }, relations: { user: true } });
    await this.mail.sendEach(recipientsOf(owners), (language) => ownerMail(account, change, reason, consoleUrl, language));
  }
}

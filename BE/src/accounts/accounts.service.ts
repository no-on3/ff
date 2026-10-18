import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomInt } from 'node:crypto';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { ACCOUNT_ID, Principal } from '../auth/principal';
import { Identity } from '../auth/token-verifier';
import { MailService } from '../mail/mail.service';
import { DEFAULT_PLAN } from '../plans/plan-limits';
import { PlansService } from '../plans/plans.service';
import { AccountView, CreateAccountDto, MeView, UpdateAccountDto } from './dto/account.dto';
import { Account, AccountStatus } from './entities/account.entity';
import { Membership } from './entities/membership.entity';
import { User } from './entities/user.entity';


/** Who a request acts for, or why it can't act for any account. */
export type AccountChoice = { principal: Principal } | { problem: BadRequestException | ForbiddenException | NotFoundException };

function view(account: Account, role: Membership['role']): AccountView {
  const { id, name, status, planId, country, taxId, internetEgress, useCase, createdAt } = account;
  return { id, name, status, role, planId, country: country.trim(), taxId, internetEgress, useCase, createdAt };
}

/**
 * Accounts, users and memberships (client-readiness plan, P-12, D1 to D4). A
 * user record is created on the user's first authenticated call. A user
 * creates accounts, and is their owner; a new account waits for approval.
 */
@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);

  constructor(
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Membership) private readonly memberships: Repository<Membership>,
    private readonly dataSource: DataSource,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    private readonly plans: PlansService,
    private readonly audit: AuditService,
  ) {}

  /** The user of a valid token: found by its subject, or created on the first call. */
  async userFor(identity: Identity): Promise<User> {
    const existing = await this.users.findOne({ where: { oidcSub: identity.userId } });
    if (existing) {
      if (identity.email && existing.email !== identity.email) {
        existing.email = identity.email; // changed in Keycloak
        return this.users.save(existing);
      }
      return existing;
    }
    try {
      return await this.users.save(
        this.users.create({ oidcSub: identity.userId, email: identity.email ?? '', name: identity.name ?? null }),
      );
    } catch (error) {
      // Two first calls at once: the other one created it.
      if (error instanceof QueryFailedError) {
        const created = await this.users.findOne({ where: { oidcSub: identity.userId } });
        if (created) return created;
      }
      throw error;
    }
  }

  /**
   * The account a user's request acts for (D4): the one X-FF-Account names, or
   * the user's only one. Several and no header: 400. Named but not a member:
   * 404, as for an account that doesn't exist. None: 403.
   */
  async choose(user: User, header: string | string[] | undefined): Promise<AccountChoice> {
    const memberships = await this.memberships.find({ where: { userId: user.id }, relations: { account: true } });
    const principal = (membership: Membership): Principal => ({
      accountId: membership.accountId,
      accountStatus: (membership.account as Account).status,
      planId: (membership.account as Account).planId,
      userId: user.id,
      role: membership.role,
    });
    if (header !== undefined) {
      if (typeof header !== 'string' || !ACCOUNT_ID.test(header)) {
        return { problem: new BadRequestException('X-FF-Account must be an account ID: 12 digits') };
      }
      const named = memberships.find((membership) => membership.accountId === header);
      return named ? { principal: principal(named) } : { problem: new NotFoundException(`Account ${header} not found`) };
    }
    if (memberships.length === 1) return { principal: principal(memberships[0]) };
    if (memberships.length === 0) {
      return { problem: new ForbiddenException('This user has no account yet: create one with POST /accounts') };
    }
    return { problem: new BadRequestException('This user belongs to several accounts: name one in the X-FF-Account header') };
  }

  /** Development mode's account: created, active, the first time it is used (FF_DEV_ACCOUNT_ID, X-FF-Dev-Account). */
  async developmentAccount(id: string): Promise<Account> {
    const existing = await this.accounts.findOne({ where: { id } });
    if (existing) return existing;
    await this.accounts
      .createQueryBuilder()
      .insert()
      .values({ id, name: `Development account ${id}`, status: AccountStatus.ACTIVE, planId: DEFAULT_PLAN })
      .orIgnore()
      .execute();
    return this.accounts.findOneOrFail({ where: { id } });
  }

  /** GET /me. */
  async me(user: User): Promise<MeView> {
    const memberships = await this.memberships.find({
      where: { userId: user.id },
      relations: { account: true },
      order: { createdAt: 'ASC' },
    });
    const accounts = [];
    for (const { account, role } of memberships) {
      const { id, name, status, planId, dataDeletionDueAt, dataDeletedAt } = account as Account;
      accounts.push({ id, name, status, role, plan: await this.plans.get(planId), dataDeletionDueAt, dataDeletedAt });
    }
    return { user: { id: user.id, email: user.email, name: user.name, locale: user.locale }, accounts };
  }

  /** GET /me in development mode: its account, as owner. */
  async developmentMe(principal: Principal): Promise<MeView> {
    const { id, name, status, planId, dataDeletionDueAt, dataDeletedAt } = await this.developmentAccount(principal.accountId);
    return { user: null, accounts: [{ id, name, status, role: 'owner', plan: await this.plans.get(planId), dataDeletionDueAt, dataDeletedAt }] };
  }

  /**
   * POST /accounts: a pending account, with its creator as owner, and an e-mail
   * to you to approve it. One account at a time may wait for approval per user.
   */
  async create(user: User, dto: CreateAccountDto): Promise<AccountView> {
    const waiting = await this.memberships.exists({
      where: { userId: user.id, role: 'owner', account: { status: AccountStatus.PENDING } },
    });
    if (waiting) throw new BadRequestException('You already have an account waiting for approval');

    const account = await this.dataSource.transaction(async (manager) => {
      const created = manager.create(Account, {
        id: await this.newAccountId(),
        name: dto.name,
        useCase: dto.useCase ?? null,
        country: dto.country ?? 'TN',
        taxId: dto.taxId ?? null,
        planId: DEFAULT_PLAN,
        status: AccountStatus.PENDING,
      });
      await manager.save(created);
      await manager.save(manager.create(Membership, { accountId: created.id, userId: user.id, role: 'owner' }));
      await this.audit.record(
        { accountId: created.id, action: 'account.create', resource: `account:${created.id}`, details: { name: created.name, planId: created.planId } },
        manager,
      );
      return created;
    });
    await this.tellOperators(user, account);
    return view(account, 'owner');
  }

  /** GET /accounts/:id, for its members; anyone else gets 404. */
  async get(user: User, id: string): Promise<AccountView> {
    const { account, role } = await this.membership(user, id);
    return view(account, role);
  }

  /** PATCH /accounts/:id: the owner's only. */
  async update(user: User, id: string, dto: UpdateAccountDto): Promise<AccountView> {
    const { account, role } = await this.membership(user, id);
    if (role !== 'owner') throw new ForbiddenException(`The ${role} role can't change the account`);
    const changes: Record<string, { from: string | null; to: string | null }> = {};
    if (dto.name !== undefined && dto.name !== account.name) changes.name = { from: account.name, to: dto.name };
    if (dto.taxId !== undefined && dto.taxId !== account.taxId) changes.taxId = { from: account.taxId, to: dto.taxId };
    if (dto.name !== undefined) account.name = dto.name;
    if (dto.taxId !== undefined) account.taxId = dto.taxId;
    const saved = await this.accounts.save(account);
    if (Object.keys(changes).length) await this.audit.record({ accountId: id, action: 'account.update', resource: `account:${id}`, details: changes });
    return view(saved, role);
  }

  private async membership(user: User, id: string): Promise<{ account: Account; role: Membership['role'] }> {
    const membership = await this.memberships.findOne({ where: { userId: user.id, accountId: id }, relations: { account: true } });
    if (!membership) throw new NotFoundException(`Account ${id} not found`);
    return { account: membership.account as Account, role: membership.role };
  }

  /** 12 random digits that no account has yet (ADR 0004). */
  private async newAccountId(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = String(randomInt(1e12)).padStart(12, '0');
      if (!(await this.accounts.exists({ where: { id } }))) return id;
    }
    throw new Error('Could not find a free account ID');
  }

  /** Each new account waits for your approval: the e-mail says who, what for, and where to approve it. */
  private async tellOperators(user: User, account: Account): Promise<void> {
    const { operatorEmail, adminUrl } = this.config.getOrThrow<{ operatorEmail: string; adminUrl: string }>('mail');
    if (!operatorEmail) {
      this.logger.log(`Account ${account.id} is waiting for approval (FF_OPERATOR_EMAIL is not set)`);
      return;
    }
    await this.mail.send({
      to: operatorEmail,
      subject: `New account waiting for approval: ${account.name} (${account.id})`,
      text: [
        `${user.email} created the account "${account.name}" (${account.id}), in ${account.country}.`,
        `What they plan to build: ${account.useCase ?? '(not given)'}`,
        '',
        `Approve or reject it: ${adminUrl}/accounts?status=pending`,
      ].join('\n'),
    });
  }
}

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, MoreThan, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { Role } from '../auth/principal';
import { MailService } from '../mail/mail.service';
import { InvitationView, InviteMemberDto, MemberView, MembersView } from './dto/member.dto';
import { invitationMail } from './invitation-mail';
import { Account } from './entities/account.entity';
import { Invitation } from './entities/invitation.entity';
import { Membership } from './entities/membership.entity';
import { User } from './entities/user.entity';

/** How long an invitation can be accepted (P-16). */
export const INVITATION_DAYS = 7;
/** Open invitations per account: each sends an e-mail. */
export const MAX_OPEN_INVITATIONS = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

function invitationView(invitation: Invitation, now: Date): InvitationView {
  const { id, email, role, invitedBy, createdAt, expiresAt } = invitation;
  return { id, email, role, invitedBy, createdAt, expiresAt, expired: expiresAt.getTime() <= now.getTime() };
}

function memberView(membership: Membership): MemberView {
  const user = membership.user as User;
  return { userId: membership.userId, email: user.email, name: user.name, role: membership.role, joinedAt: membership.createdAt };
}

/**
 * An account's members and invitations (client-readiness plan, P-16, D4).
 * Owners invite people by e-mail with a role; whoever next calls the API
 * with a login for that address joins, within seven days. Owners change roles
 * and remove members, but an account always keeps an owner: those changes
 * lock the account's row, so two at once can't remove the last two owners.
 */
@Injectable()
export class MembersService {
  private readonly logger = new Logger(MembersService.name);

  constructor(
    @InjectRepository(Membership) private readonly memberships: Repository<Membership>,
    @InjectRepository(Invitation) private readonly invitations: Repository<Invitation>,
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
    private readonly dataSource: DataSource,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  /** GET /members. */
  async list(accountId: string, now = new Date()): Promise<MembersView> {
    const members = await this.memberships.find({ where: { accountId }, relations: { user: true }, order: { createdAt: 'ASC' } });
    const invitations = await this.invitations.find({ where: { accountId, acceptedAt: IsNull() }, order: { createdAt: 'ASC' } });
    return { members: members.map(memberView), invitations: invitations.map((invitation) => invitationView(invitation, now)) };
  }

  /**
   * POST /members: invites an address, or sends its open invitation again with
   * the new role and seven more days. The invitee gets an e-mail.
   */
  async invite(accountId: string, inviter: User, dto: InviteMemberDto, now = new Date()): Promise<InvitationView> {
    const email = dto.email.trim().toLowerCase();
    const member = await this.memberships
      .createQueryBuilder('membership')
      .innerJoin('membership.user', 'user')
      .where('membership.account_id = :accountId AND lower(user.email) = :email', { accountId, email })
      .getExists();
    if (member) throw new BadRequestException(`${email} is already a member of this account`);

    const reopened = await this.invitations.exists({ where: { accountId, email, acceptedAt: IsNull() } });
    const open = await this.invitations.count({ where: { accountId, acceptedAt: IsNull(), expiresAt: MoreThan(now) } });
    if (!reopened && open >= MAX_OPEN_INVITATIONS) {
      throw new BadRequestException(`An account has at most ${MAX_OPEN_INVITATIONS} open invitations: cancel one first`);
    }
    const expiresAt = new Date(now.getTime() + INVITATION_DAYS * DAY_MS);
    // One open invitation per address: inviting again renews it, even when two invitations cross.
    const [saved] = await this.invitations.query<Array<{ id: string }>>(
      `INSERT INTO "invitations" ("account_id", "email", "role", "invited_by", "expires_at") VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT ("account_id", "email") WHERE "accepted_at" IS NULL
       DO UPDATE SET "role" = EXCLUDED."role", "invited_by" = EXCLUDED."invited_by", "expires_at" = EXCLUDED."expires_at"
       RETURNING "id"`,
      [accountId, email, dto.role, inviter.id, expiresAt],
    );
    const invitation = await this.invitations.findOneByOrFail({ id: saved.id });
    await this.audit.record({
      accountId,
      action: 'member.invite',
      resource: `invitation:${invitation.id}`,
      details: { email, role: dto.role, renewed: reopened },
    });
    await this.sendInvitation(invitation, inviter);
    return invitationView(invitation, now);
  }

  /** The invitation's e-mail, in the language of the invitee when they already have a login, else in the inviter's. */
  private async sendInvitation(invitation: Invitation, inviter: User): Promise<void> {
    const account = await this.accounts.findOneByOrFail({ id: invitation.accountId });
    const { consoleUrl } = this.config.getOrThrow<{ consoleUrl: string }>('mail');
    const [invitee] = await this.dataSource.query<Array<{ locale: string }>>(
      `SELECT "locale" FROM "users" WHERE lower("email") = $1 ORDER BY "created_at" DESC LIMIT 1`,
      [invitation.email],
    );
    await this.mail.sendEach([{ email: invitation.email, locale: invitee?.locale ?? inviter.locale }], (language) =>
      invitationMail({ inviter, account, role: invitation.role, expiresAt: invitation.expiresAt, consoleUrl }, language),
    );
  }

  /** DELETE /members/invitations/:id: an invitation nobody has accepted yet. */
  async cancelInvitation(accountId: string, id: string): Promise<void> {
    const invitation = await this.invitations.findOneBy({ id, accountId, acceptedAt: IsNull() });
    const { affected } = invitation ? await this.invitations.delete({ id, accountId, acceptedAt: IsNull() }) : { affected: 0 };
    if (!invitation || !affected) throw new NotFoundException(`Invitation ${id} not found`);
    await this.audit.record({
      accountId,
      action: 'member.invitation_cancel',
      resource: `invitation:${id}`,
      details: { email: invitation.email, role: invitation.role },
    });
  }

  /** PATCH /members/:userId. */
  async changeRole(accountId: string, userId: string, role: Role): Promise<MemberView> {
    return this.withAccountLocked(accountId, async (manager) => {
      const membership = await this.memberOf(manager, accountId, userId);
      if (membership.role === 'owner' && role !== 'owner') await this.keepAnOwner(manager, accountId);
      await manager.update(Membership, { accountId, userId }, { role });
      const email = (membership.user as User).email;
      await this.audit.record(
        { accountId, action: 'member.role', resource: `user:${userId}`, details: { email, from: membership.role, to: role } },
        manager,
      );
      return memberView({ ...membership, role });
    });
  }

  /** DELETE /members/:userId. Their API keys stop working at once (P-13). */
  async remove(accountId: string, userId: string): Promise<void> {
    await this.withAccountLocked(accountId, async (manager) => {
      const membership = await this.memberOf(manager, accountId, userId);
      if (membership.role === 'owner') await this.keepAnOwner(manager, accountId);
      await manager.delete(Membership, { accountId, userId });
      await this.audit.record(
        { accountId, action: 'member.remove', resource: `user:${userId}`, details: { email: (membership.user as User).email, role: membership.role } },
        manager,
      );
    });
  }

  /**
   * The user joins the accounts that invited the user's address, if the
   * invitation hasn't expired. The global guard calls this for every request
   * with a token: Keycloak verified the address. A membership the user already
   * has stays as it is.
   */
  async acceptInvitations(user: User, now = new Date(), request: { ip?: string; requestId?: string } = {}): Promise<void> {
    if (!user.email) return;
    const open = await this.invitations.find({ where: { email: user.email.toLowerCase(), acceptedAt: IsNull(), expiresAt: MoreThan(now) } });
    for (const invitation of open) {
      await this.dataSource.transaction(async (manager) => {
        await manager
          .createQueryBuilder()
          .insert()
          .into(Membership)
          .values({ accountId: invitation.accountId, userId: user.id, role: invitation.role })
          .orIgnore()
          .execute();
        const { affected } = await manager.update(Invitation, { id: invitation.id, acceptedAt: IsNull() }, { acceptedAt: now, acceptedBy: user.id });
        if (!affected) return; // another request of the same user took it
        // In the guard, before the request context exists: the joining user is the actor.
        await this.audit.record(
          {
            accountId: invitation.accountId,
            action: 'member.join',
            resource: `user:${user.id}`,
            details: { email: user.email, role: invitation.role, invitation: invitation.id, invitedBy: invitation.invitedBy },
            actor: { id: `user:${user.id}`, label: user.email },
            ip: request.ip,
            requestId: request.requestId,
          },
          manager,
        );
      });
      this.logger.log(`User ${user.id} joined account ${invitation.accountId} as ${invitation.role}, invited by ${invitation.invitedBy}`);
    }
  }

  private withAccountLocked<T>(accountId: string, work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT 1 FROM "accounts" WHERE "id" = $1 FOR NO KEY UPDATE', [accountId]);
      return work(manager);
    });
  }

  private async memberOf(manager: EntityManager, accountId: string, userId: string): Promise<Membership> {
    const membership = await manager.findOne(Membership, { where: { accountId, userId }, relations: { user: true } });
    if (!membership) throw new NotFoundException(`Member ${userId} not found`);
    return membership;
  }

  private async keepAnOwner(manager: EntityManager, accountId: string): Promise<void> {
    if ((await manager.countBy(Membership, { accountId, role: 'owner' })) <= 1) {
      throw new BadRequestException('An account needs an owner: make another member owner first');
    }
  }
}

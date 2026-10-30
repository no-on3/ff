import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { Membership } from '../accounts/entities/membership.entity';
import { AuditService } from '../audit/audit.service';
import { EmailAccountService } from '../email/email-account.service';
import { EmailIdentitiesService } from '../email/email-identities.service';
import { EmailSending, EnforcementStatus } from '../email/email-sending.entity';
import { Language, recipientsOf } from '../mail/language';
import { Mail, MailService } from '../mail/mail.service';
import { AdminEmailView } from './admin-email.dto';

/** What an operator changes of an account's sending: any of the three. */
export interface SendingChanges {
  productionAccess?: boolean;
  sendingEnabled?: boolean;
  enforcementStatus?: EnforcementStatus;
}

type Sending = Pick<EmailSending, 'productionAccess' | 'sendingEnabled' | 'enforcementStatus'>;

/**
 * The e-mail an account's owners get when an operator changes its sending, in
 * their language: out of the sandbox or back in it, paused or on again, its
 * enforcement cleared after a review; the reason with each.
 */
export function sendingMail(account: Pick<Account, 'id' | 'name'>, before: Sending, after: Sending, reason: string, consoleUrl: string, language: Language): Omit<Mail, 'to'> {
  const french = language === 'fr';
  const lines: string[] = [];
  if (before.productionAccess !== after.productionAccess) {
    lines.push(
      after.productionAccess
        ? french
          ? "Votre compte sort du bac à sable : son courrier peut aller à toute adresse, dans les quotas de son offre."
          : "Your account is out of the sandbox: its mail may go to any address, within its plan's quotas."
        : french
          ? "Votre compte revient dans le bac à sable : son courrier ne va plus qu'aux adresses et domaines qu'il a prouvés."
          : 'Your account is back in the sandbox: its mail goes only to the addresses and domains it proved.',
    );
  }
  if (before.sendingEnabled !== after.sendingEnabled) {
    lines.push(
      after.sendingEnabled
        ? french
          ? "L'envoi de courrier de votre compte est réactivé."
          : "Your account's sending is on again."
        : french
          ? "FF a suspendu l'envoi de courrier de votre compte : le point d'accès SES refuse ses messages (SendingPausedException)."
          : "FF paused your account's sending: the SES endpoint refuses its messages (SendingPausedException).",
    );
  }
  if (before.enforcementStatus !== after.enforcementStatus) {
    lines.push(
      french
        ? `L'état de votre courrier, après examen de ses rebonds et plaintes, est maintenant ${after.enforcementStatus}.`
        : `Your mail's standing, after a review of its bounces and complaints, is now ${after.enforcementStatus}.`,
    );
  }
  const which = french ? `votre compte « ${account.name} » (${account.id})` : `your account "${account.name}" (${account.id})`;
  return {
    subject: french ? `Le courrier de votre compte FF : ${account.name}` : `Your FF account's mail: ${account.name}`,
    text: [
      french ? `FF a modifié l'envoi de courrier de ${which} :` : `FF changed the sending of ${which}:`,
      ...lines,
      french ? `Motif : ${reason}` : `Why: ${reason}`,
      '',
      french ? `La console : ${consoleUrl}/email` : `The console: ${consoleUrl}/email`,
    ].join('\n'),
  };
}

/**
 * An account's sending, for FF's operators (ADR 0012): its sandbox, which an
 * operator lifts once the account says what it sends; its switch; its
 * enforcement, which its rates raise and only an operator clears. Each change
 * with its reason in the account's audit log, and an e-mail to its owners.
 */
@Injectable()
export class AdminEmailService {
  constructor(
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
    @InjectRepository(Membership) private readonly memberships: Repository<Membership>,
    private readonly sending: EmailAccountService,
    private readonly identities: EmailIdentitiesService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  /** GET /admin/accounts/:id/email: its sending as GetAccount says it, why it was last changed, and its identities. */
  async view(id: string): Promise<AdminEmailView> {
    if (!(await this.accounts.existsBy({ id }))) throw new NotFoundException(`Account ${id} not found`);
    const row = await this.accounts.manager.findOneBy(EmailSending, { accountId: id });
    const identities = await this.identities.list(id);
    return {
      ...(await this.sending.state(id)),
      reason: row?.reason ?? null,
      updatedAt: row?.updatedAt ?? null,
      identities: identities.map(({ identity, type, status }) => ({ identity, type, status })),
    };
  }

  /**
   * PUT /admin/accounts/:id/email: the changes, under the account's lock, with
   * their audit entry; its owners told of a change. The values it has already
   * change nothing and tell no one: a retry.
   */
  async change(id: string, changes: SendingChanges, reason: string): Promise<AdminEmailView> {
    const changed = await this.accounts.manager.transaction(async (manager) => {
      const account = await manager.findOne(Account, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!account) throw new NotFoundException(`Account ${id} not found`);
      const before: Sending = await this.sending.sendingOf(id);
      const given = Object.entries(changes).filter(([, value]) => value !== undefined);
      const after: Sending = { ...before, ...Object.fromEntries(given) };
      const differences = (Object.keys(after) as Array<keyof Sending>).filter((key) => after[key] !== before[key]);
      if (differences.length === 0) return null;
      await manager.upsert(EmailSending, { accountId: id, ...after, reason }, ['accountId']);
      await this.audit.record(
        {
          accountId: id,
          action: 'account.email',
          resource: `account:${id}`,
          details: { reason, changes: Object.fromEntries(differences.map((key) => [key, { from: before[key], to: after[key] }])) },
        },
        manager,
      );
      return { account, before, after };
    });
    if (changed) {
      const { consoleUrl } = this.config.getOrThrow<{ consoleUrl: string }>('mail');
      const owners = await this.memberships.find({ where: { accountId: id, role: 'owner' }, relations: { user: true } });
      await this.mail.sendEach(recipientsOf(owners), (language) => sendingMail(changed.account, changed.before, changed.after, reason, consoleUrl, language));
    }
    return this.view(id);
  }
}

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { PlansService } from '../plans/plans.service';
import { EmailSending, EnforcementStatus } from './email-sending.entity';

const DAY_MS = 24 * 60 * 60 * 1000;

/** An account's sending, as SES v2's GetAccount says it. */
export interface EmailAccountState {
  /** In the sandbox, as SES's: mail goes only to the account's proved addresses. */
  sandbox: boolean;
  sendingEnabled: boolean;
  /** As SES's EnforcementStatus: HEALTHY, or reviewed past its bounce or complaint rate, or stopped. */
  enforcementStatus: EnforcementStatus;
  /** The plan's: messages a day, each recipient one, and a second. */
  max24HourSend: number;
  maxSendRate: number;
  /** What it sent in the last 24 hours, each recipient one. */
  sentLast24Hours: number;
}

/** An account's sending without a row of its own: in the sandbox, sending, healthy. */
const NEW_ACCOUNT: Pick<EmailSending, 'productionAccess' | 'sendingEnabled' | 'enforcementStatus'> = { productionAccess: false, sendingEnabled: true, enforcementStatus: 'HEALTHY' };

/**
 * An account's sending (ADR 0012): its quotas, the plan's; whether it is in
 * the sandbox, as every new account is until an operator lets it out; paused,
 * or reviewed, then stopped, past its rates; and what it sent, each recipient
 * once, as SES counts them.
 */
@Injectable()
export class EmailAccountService {
  constructor(
    private readonly plans: PlansService,
    @InjectRepository(EmailSending) private readonly sending: Repository<EmailSending>,
  ) {}

  /** The account's sending, as its row says, or a new account's. */
  async sendingOf(accountId: string): Promise<Pick<EmailSending, 'productionAccess' | 'sendingEnabled' | 'enforcementStatus'>> {
    return (await this.sending.findOneBy({ accountId })) ?? NEW_ACCOUNT;
  }

  /** The recipients of the account's messages since then, each once, a suppressed one too. */
  async sentSince(accountId: string, since: Date, manager: EntityManager = this.sending.manager): Promise<number> {
    const [{ sent }] = await manager.query<Array<{ sent: number }>>(
      `SELECT coalesce(sum("recipient_count"), 0)::int AS "sent" FROM "email_messages" WHERE "account_id" = $1 AND "created_at" > $2`,
      [accountId, since],
    );
    return sent;
  }

  async state(accountId: string, now = new Date()): Promise<EmailAccountState> {
    const { limits } = await this.plans.forAccount(accountId);
    const sending = await this.sendingOf(accountId);
    return {
      sandbox: !sending.productionAccess,
      sendingEnabled: sending.sendingEnabled,
      enforcementStatus: sending.enforcementStatus,
      max24HourSend: limits.emailsPerDay,
      maxSendRate: limits.emailsPerSecond,
      sentLast24Hours: await this.sentSince(accountId, new Date(now.getTime() - DAY_MS)),
    };
  }
}

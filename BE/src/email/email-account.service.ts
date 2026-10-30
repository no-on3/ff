import { Injectable } from '@nestjs/common';
import { PlansService } from '../plans/plans.service';

/** An account's sending, as SES v2's GetAccount says it. */
export interface EmailAccountState {
  /** In the sandbox, as SES's: mail goes only to the account's proved addresses. */
  sandbox: boolean;
  sendingEnabled: boolean;
  /** As SES's EnforcementStatus: HEALTHY, or reviewed past its bounce or complaint rate, or stopped. */
  enforcementStatus: 'HEALTHY' | 'PROBATION' | 'SHUTDOWN';
  /** The plan's: messages a day, each recipient one, and a second. */
  max24HourSend: number;
  maxSendRate: number;
  /** What it sent in the last 24 hours, each recipient one. */
  sentLast24Hours: number;
}

/**
 * An account's sending (ADR 0012): its quotas, the plan's, and whether it is
 * in the sandbox, as every new account is until an operator lets it out.
 */
@Injectable()
export class EmailAccountService {
  constructor(private readonly plans: PlansService) {}

  async state(accountId: string): Promise<EmailAccountState> {
    const { limits } = await this.plans.forAccount(accountId);
    return { sandbox: true, sendingEnabled: true, enforcementStatus: 'HEALTHY', max24HourSend: limits.emailsPerDay, maxSendRate: limits.emailsPerSecond, sentLast24Hours: 0 };
  }
}

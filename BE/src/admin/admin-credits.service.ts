import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { Membership } from '../accounts/entities/membership.entity';
import { AuditService } from '../audit/audit.service';
import { billingCurrency } from '../billing/billing-currency';
import { CreditService } from '../billing/credit.service';
import { LedgerTransactionKind } from '../billing/ledger/ledger-transaction.entity';
import { IdempotencyKeyConflictException, LedgerService } from '../billing/ledger/ledger.service';
import { formatMinor, parseMinor } from '../billing/money';
import { monthBounds } from '../billing/pricing.service';
import { HOUR_MS } from '../billing/rating-hours';
import { describeError } from '../common/describe-error';
import { recipientsOf } from '../mail/language';
import { MailService } from '../mail/mail.service';
import { AdminCreditView } from './admin-accounts.dto';
import { AdminGrantView } from './admin-credits.dto';
import { GRANT_ACTIONS, GrantFacts, GrantKind, confirmationProblem, grantKey, grantMail, grantProblem } from './credit-grants';
import { PlatformSettingsService } from './platform-settings.service';

/** A grant as the operator asks for it (P-74). */
export interface GrantInput {
  kind: GrantKind;
  /** Signed: below 0, a correction that takes credit away. */
  amount: string;
  reason: string;
  /** The client's, made once per grant. */
  idempotencyKey: string;
  /** The amount typed again, above the large-credit threshold. */
  confirmAmount?: string;
  /** A correction that takes credit away may leave a debt. */
  allowDebt?: boolean;
}

/** Accounts that get no promotion, which would be a mistake; a correction can still settle their balance. */
const NO_PROMOTION: AccountStatus[] = [AccountStatus.REJECTED, AccountStatus.CLOSED];

/** An amount the operator typed, in minor units; refused with the field's name. */
function amountOf(name: string, text: string, exponent: number): bigint {
  try {
    return parseMinor(text, exponent);
  } catch (error) {
    throw new BadRequestException(`${name}: ${describeError(error)}`);
  }
}

/**
 * Credit FF gives, for its operators (P-74, D12): promotional credit, or a
 * correction either way, each with a reason. One transaction writes the
 * ledger posting, against FF's promotional credit, and the audit entry; the
 * client's key makes a retried request grant once. Above the large-credit
 * threshold the amount is typed again. A correction takes the credit left at
 * most, unless the operator means to leave a debt. The owners get an e-mail.
 */
@Injectable()
export class AdminCreditsService {
  private readonly logger = new Logger(AdminCreditsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
    private readonly credit: CreditService,
    private readonly settings: PlatformSettingsService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  /** POST /admin/accounts/:id/credits: the grant, or, for a key granted before, the first grant again. */
  async grant(accountId: string, input: GrantInput, now = new Date()): Promise<AdminGrantView> {
    const { currency, exponent } = await billingCurrency(this.dataSource.manager, now);
    const amountMinor = amountOf('amount', input.amount, exponent);
    const problem = grantProblem(input.kind, amountMinor, exponent, currency);
    if (problem) throw new BadRequestException(problem);
    const confirmMinor = input.confirmAmount === undefined ? undefined : amountOf('confirmAmount', input.confirmAmount, exponent);
    const thresholdMinor = parseMinor((await this.settings.get()).largeCreditThreshold, exponent);
    const unconfirmed = confirmationProblem(amountMinor, confirmMinor, thresholdMinor, exponent, currency);
    if (unconfirmed) throw new BadRequestException(unconfirmed);
    // A debt is left only on purpose, and only by a correction that takes credit away.
    const leavesDebt = input.allowDebt === true && amountMinor < 0n;

    const { account, posted, balanceMinor } = await this.dataSource.transaction(async (manager) => {
      const found = await manager.findOneBy(Account, { id: accountId });
      if (!found) throw new NotFoundException(`Account ${accountId} not found`);
      if (input.kind === LedgerTransactionKind.PROMO && NO_PROMOTION.includes(found.status)) {
        throw new ConflictException(`Account ${accountId} is ${found.status}: it gets no promotional credit. A correction can still settle its balance`);
      }
      const posted = await this.ledger
        .grantCreditIn(
          manager,
          {
            accountId,
            currency,
            amountMinor,
            kind: input.kind,
            idempotencyKey: grantKey(input.idempotencyKey),
            metadata: { reason: input.reason, ...(leavesDebt ? { allowDebt: true } : {}) },
          },
          amountMinor < 0n && !leavesDebt ? { floorMinor: 0n } : {},
        )
        .catch((error: unknown) => {
          if (!(error instanceof IdempotencyKeyConflictException)) throw error;
          throw new ConflictException(`idempotencyKey ${input.idempotencyKey} was used for another grant: nothing was written. Each grant takes a key of its own`);
        });
      // The wallet is locked until the commit: this is the balance the grant left.
      const balanceMinor = await this.ledger.balance(accountId, currency, manager);
      // A replay wrote nothing: the first grant has its audit entry.
      if (posted.created) {
        await this.audit.record(
          {
            accountId,
            action: GRANT_ACTIONS[input.kind],
            resource: `ledger_transaction:${posted.transaction.id}`,
            details: {
              reason: input.reason,
              kind: input.kind,
              currency,
              amount: formatMinor(amountMinor, exponent),
              balance: formatMinor(balanceMinor, exponent),
              ...(leavesDebt ? { allowDebt: true } : {}),
            },
          },
          manager,
        );
      }
      return { account: found, posted, balanceMinor };
    });
    if (posted.created) await this.tellOwners(account, { kind: input.kind, amountMinor, balanceMinor, currency, exponent, reason: input.reason });
    return {
      id: posted.transaction.id,
      kind: input.kind,
      currency,
      amount: formatMinor(amountMinor, exponent),
      balance: formatMinor(balanceMinor, exponent),
      createdAt: posted.transaction.createdAt,
      replayed: !posted.created,
    };
  }

  /**
   * The account page's credit: the balance as it is now, not as the invoke
   * check cached it, whether invokes go on, and this month's charges, debited
   * and only rated apart, as shadow mode may have changed during the month.
   */
  async view(accountId: string, now = new Date()): Promise<AdminCreditView> {
    const { standing, policy, decision } = await this.credit.view(accountId, now, { fresh: true });
    const month = now.toISOString().slice(0, 7);
    const { from, to } = monthBounds(month);
    const [row] = await this.dataSource.query<Array<{ debited: string; rated_only: string; latest: Date | null }>>(
      `SELECT coalesce(sum("amount_minor") FILTER (WHERE NOT "shadow"), 0)::text AS "debited",
              coalesce(sum("amount_minor") FILTER (WHERE "shadow"), 0)::text AS "rated_only",
              (SELECT max("hour") FROM "rating_runs") AS "latest"
         FROM "usage_charges"
        WHERE "account_id" = $1 AND "currency" = $2 AND "hour" >= $3 AND "hour" < $4`,
      [accountId, standing.currency, from, to],
    );
    const money = (minor: bigint) => formatMinor(minor, standing.exponent);
    const { largeCreditThreshold } = await this.settings.get();
    return {
      currency: standing.currency,
      balance: money(standing.balanceMinor),
      state: {
        state: decision.state,
        buffer: money(policy.bufferMinor),
        belowBufferSince: policy.shadow ? null : standing.belowBufferSince,
        invokesStopAt: decision.invokesStopAt,
      },
      shadowMode: policy.shadow,
      month,
      debited: money(BigInt(row.debited)),
      ratedOnly: money(BigInt(row.rated_only)),
      ratedUntil: row.latest ? new Date(row.latest.getTime() + HOUR_MS) : null,
      largeCreditThreshold: money(parseMinor(largeCreditThreshold, standing.exponent)),
    };
  }

  /** E-mails each owner, once the grant has committed; a failure is logged, never the request's. */
  private async tellOwners(account: Account, grant: Omit<GrantFacts, 'account' | 'consoleUrl'>): Promise<void> {
    try {
      const { consoleUrl } = this.config.getOrThrow<{ consoleUrl: string }>('mail');
      const owners = await this.dataSource.getRepository(Membership).find({ where: { accountId: account.id, role: 'owner' }, relations: { user: true } });
      await this.mail.sendEach(recipientsOf(owners), (language) => grantMail({ ...grant, account, consoleUrl }, language));
    } catch (error) {
      this.logger.error(`Could not e-mail the owners of account ${account.id} about a grant: ${describeError(error)}`);
    }
  }
}

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { Membership } from '../accounts/entities/membership.entity';
import { PlatformSettingsService } from '../admin/platform-settings.service';
import { describeError } from '../common/describe-error';
import { MailService } from '../mail/mail.service';
import { creditPolicy } from './credit-policy';
import { LedgerEvents } from './ledger/ledger-events';
import { LedgerService } from './ledger/ledger.service';
import { lowBalanceMail, sharesReached } from './low-balance';

/** What raises a wallet as credit, not as a correction of a charge: the base of the low-balance shares. */
const CREDIT_KINDS = ['topup', 'payment', 'promo', 'adjustment'];

/**
 * The low-balance e-mails (P-33): after each write to a wallet, each share of
 * the last credit that the balance has fallen to (the owners', else the
 * platform's lowBalancePercents) is e-mailed once to the owners, the lowest
 * share named when several are reached at once. The next credit starts again.
 * Every backend hears the write; the share's row, written once, lets only one
 * send.
 */
@Injectable()
export class LowBalanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LowBalanceService.name);
  private unsubscribe?: () => void;

  constructor(
    private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
    private readonly settings: PlatformSettingsService,
    private readonly mail: MailService,
    private readonly events: LedgerEvents,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.events.subscribe(
      (accountId) => void this.check(accountId).catch((error: unknown) => this.logger.error(`Low-balance check of ${accountId} failed: ${describeError(error)}`)),
    );
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  /** Looks at the account's balance against its last credit; e-mails the owners for a share newly reached. Answers the share e-mailed, or null. */
  async check(accountId: string): Promise<number | null> {
    const account = await this.dataSource.getRepository(Account).findOneBy({ id: accountId });
    if (!account) return null;
    const settings = await this.settings.get();
    const percents = account.lowBalancePercents ?? settings.lowBalancePercents;
    if (percents.length === 0) return null;
    const [credit] = await this.dataSource.query<Array<{ id: string; created_at: Date; amount: string; currency: string; exponent: number }>>(
      `SELECT t."id", t."created_at", e."amount_minor"::text AS "amount", a."currency", c."exponent"
         FROM "ledger_entries" e
         JOIN "ledger_accounts" a ON a."id" = e."ledger_account_id"
         JOIN "ledger_transactions" t ON t."id" = e."transaction_id"
         JOIN "currencies" c ON c."code" = a."currency"
        WHERE a."account_id" = $1 AND a."type" = 'wallet' AND e."amount_minor" > 0 AND t."kind" = ANY($2::text[])
        ORDER BY t."created_at" DESC, t."id" DESC LIMIT 1`,
      [accountId, CREDIT_KINDS],
    );
    if (!credit) return null;
    const balanceMinor = await this.ledger.balance(accountId, credit.currency);
    const notified = await this.dataSource.query<Array<{ percent: number }>>(
      `SELECT "percent" FROM "low_balance_notices" WHERE "account_id" = $1 AND "credit_transaction_id" = $2`,
      [accountId, credit.id],
    );
    const reached = sharesReached(balanceMinor, BigInt(credit.amount), percents, new Set(notified.map((row) => row.percent)));
    if (reached.length === 0) return null;
    // Each share once: the backend whose rows go in sends; another one, at the same moment, finds them taken.
    const recorded = await this.dataSource.query<Array<{ percent: number }>>(
      `INSERT INTO "low_balance_notices" ("account_id", "credit_transaction_id", "percent", "balance_minor")
       SELECT $1, $2, unnest($3::int[]), $4 ON CONFLICT DO NOTHING RETURNING "percent"`,
      [accountId, credit.id, reached, balanceMinor.toString()],
    );
    if (recorded.length === 0) return null;
    const percent = Math.min(...recorded.map((row) => row.percent));
    const { consoleUrl } = this.config.getOrThrow<{ consoleUrl: string }>('mail');
    const mail = lowBalanceMail({
      account,
      percent,
      balanceMinor,
      creditMinor: BigInt(credit.amount),
      creditAt: credit.created_at,
      currency: credit.currency,
      exponent: credit.exponent,
      policy: creditPolicy(settings, credit.exponent),
      consoleUrl,
    });
    const owners = await this.dataSource.getRepository(Membership).find({ where: { accountId, role: 'owner' }, relations: { user: true } });
    for (const owner of owners) if (owner.user?.email) await this.mail.send({ to: owner.user.email, ...mail });
    return percent;
  }
}

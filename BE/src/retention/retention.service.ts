import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, IsNull, LessThanOrEqual } from 'typeorm';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { Plan } from '../accounts/entities/plan.entity';
import { AuditService } from '../audit/audit.service';
import { describeError } from '../common/describe-error';
import { Function } from '../functions/entities/function.entity';
import { FunctionsService } from '../functions/functions.service';
import { ORCHESTRATOR, Orchestrator } from '../orchestrator/orchestrator.types';
import { parsePlanLimits } from '../plans/plan-limits';

const DAY_SECONDS = 86_400;
/** Invocations deleted per statement: each a short transaction, holding few locks. */
export const PURGE_BATCH = 1_000;

/**
 * What FF keeps only for a while, deleted by one job, at start and then every
 * FF_RETENTION_INTERVAL_SECONDS (an hour):
 * - the invocation history: its inputs and outputs are the personal data of
 *   the customer's own users, so it is kept only for the account's plan's
 *   historyRetentionDays;
 * - a closed account's functions, their history and logs, once the notice
 *   period its closure set has passed.
 * Usage records, the ledger, invoices and the audit log are not touched: the
 * law requires keeping them for years.
 */
@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionService.name);
  private timer?: NodeJS.Timeout;
  /** The run under way: a slow one isn't started again when the next interval comes. */
  private running?: Promise<void>;

  constructor(
    private readonly dataSource: DataSource,
    private readonly functions: FunctionsService,
    @Inject(ORCHESTRATOR) private readonly orchestrator: Orchestrator,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.config.get<number>('retention.intervalSeconds', 3600) * 1000;
    // At start, in the background, then at each interval.
    this.runInBackground();
    this.timer = setInterval(() => this.runInBackground(), intervalMs);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** The history's purge, then the closed accounts: a failure of either is logged, and the next run tries again. */
  private runInBackground(): void {
    if (this.running) return;
    this.running = (async () => {
      await this.purgeHistory().catch((error: unknown) => this.logger.error(`Could not purge the invocation history: ${describeError(error)}`));
      await this.deleteClosedAccounts().catch((error: unknown) => this.logger.error(`Could not look for closed accounts to delete: ${describeError(error)}`));
    })().finally(() => (this.running = undefined));
  }

  /**
   * Deletes the invocations older than their account's plan's history
   * retention: days of 24 hours, before the database's now (or `now`), a batch
   * at a time. A call still RUNNING is left, whatever its age, to the reaper
   * that marks LOST the calls the backend stopped during (UsageService). A plan whose limits can't be read keeps its accounts' history, and
   * is logged. Returns how many invocations were deleted.
   */
  async purgeHistory(now?: Date, batch = PURGE_BATCH): Promise<number> {
    const plans = await this.dataSource.getRepository(Plan).find({ order: { id: 'ASC' } });
    let deleted = 0;
    for (const plan of plans) {
      let days: number;
      try {
        days = parsePlanLimits(plan.id, plan.limits).historyRetentionDays;
      } catch (error) {
        this.logger.error(`The history of plan ${plan.id}'s accounts is kept: its retention can't be read: ${describeError(error)}`);
        continue;
      }
      for (;;) {
        // Each function's oldest first, through its (function_id, created_at) index: the work
        // grows with what is deleted, not with the history (a plain join scanned all of it).
        const [, count] = await this.dataSource.query<[unknown[], number]>(
          `DELETE FROM "function_invocations" WHERE "id" IN (
             SELECT old."id" FROM "accounts" a
               JOIN "functions" f ON f."account_id" = a."id"
               CROSS JOIN LATERAL (
                 SELECT i."id" FROM "function_invocations" i
                  WHERE i."function_id" = f."id" AND i."status" <> 'RUNNING'
                    AND i."created_at" < coalesce($2::timestamptz, now()) - make_interval(secs => $3)
                  ORDER BY i."created_at" LIMIT $4) old
              WHERE a."plan_id" = $1
              LIMIT $4)`,
          [plan.id, now ?? null, days * DAY_SECONDS, batch],
        );
        deleted += count;
        if (count < batch) break;
      }
    }
    if (deleted) this.logger.log(`Deleted ${deleted} invocation(s) past their plan's history retention`);
    return deleted;
  }

  /**
   * Deletes the data of each closed account whose notice period has passed by
   * `now`, the earliest first. An account that fails is logged and left for
   * the next run; the others go on. Returns how many accounts were done.
   */
  async deleteClosedAccounts(now = new Date()): Promise<number> {
    const due = await this.dataSource.getRepository(Account).find({
      where: { status: AccountStatus.CLOSED, dataDeletedAt: IsNull(), dataDeletionDueAt: LessThanOrEqual(now) },
      order: { dataDeletionDueAt: 'ASC' },
    });
    let done = 0;
    for (const { id } of due) {
      try {
        await this.deleteAccountData(id);
        done++;
      } catch (error) {
        this.logger.error(`Could not delete the data of closed account ${id}; the next run tries again: ${describeError(error)}`);
      }
    }
    return done;
  }

  /**
   * A closed account's data: each function, with its objects, its code in
   * object storage, its row and its history (FunctionsService.remove(), which
   * records each in the audit log); then its namespace, so that nothing writes
   * more of its lines; then its lines in the log store. Then the account is
   * marked, with an entry in its audit log, once. Each step may run again, so
   * a run that failed part way is finished by the next.
   */
  private async deleteAccountData(accountId: string): Promise<void> {
    const functions = await this.dataSource.getRepository(Function).find({ where: { accountId }, order: { createdAt: 'ASC' } });
    for (const fn of functions) await this.functions.remove(accountId, fn.id);
    await this.orchestrator.removeTenant(accountId);
    await this.orchestrator.deleteLogs(accountId);
    await this.dataSource.transaction(async (manager) => {
      const marked = await manager.update(Account, { id: accountId, dataDeletedAt: IsNull() }, { dataDeletedAt: new Date() });
      if (!marked.affected) return;
      await this.audit.record(
        { accountId, action: 'account.data_delete', resource: `account:${accountId}`, details: { functions: functions.length } },
        manager,
      );
    });
    this.logger.log(`Deleted the functions, history and logs of closed account ${accountId}, its notice period over: ${functions.length} function(s)`);
  }
}

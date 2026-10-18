import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Plan } from '../accounts/entities/plan.entity';
import { describeError } from '../common/describe-error';
import { parsePlanLimits } from '../plans/plan-limits';

export const HOUR_MS = 3_600_000;
const DAY_SECONDS = 86_400;
/** Invocations deleted per statement: each a short transaction, holding few locks. */
export const PURGE_BATCH = 1_000;

/**
 * What FF keeps only for a while (client-readiness plan, P-45). The invocation
 * history holds the personal data of the customer's own users (parent §9.2):
 * it is kept for the account's plan's historyRetentionDays, then deleted
 * within the hour. Usage records, the ledger, invoices and the audit log are
 * not touched: they are kept for the legal retention.
 */
@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionService.name);
  private timer?: NodeJS.Timeout;
  /** The purge under way: a slow one isn't started again when the next hour comes. */
  private purging?: Promise<number>;

  constructor(private readonly dataSource: DataSource) {}

  onModuleInit(): void {
    // At start, in the background, then every hour.
    this.purgeInBackground();
    this.timer = setInterval(() => this.purgeInBackground(), HOUR_MS);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  private purgeInBackground(): void {
    if (this.purging) return;
    this.purging = this.purgeHistory()
      .catch((error: unknown) => {
        this.logger.error(`Could not purge the invocation history: ${describeError(error)}`);
        return 0;
      })
      .finally(() => (this.purging = undefined));
  }

  /**
   * Deletes the invocations older than their account's plan's history
   * retention: days of 24 hours, before the database's now (or `now`), a batch
   * at a time. A call still RUNNING is left to the reaper (P-20), whatever its
   * age. A plan whose limits can't be read keeps its accounts' history, and
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
}

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
import { PackagesService } from '../packages/packages.service';
import { CachesService } from '../caches/caches.service';
import { DatabasesService } from '../databases/databases.service';
import { BucketsService } from '../storage/buckets.service';
import { parsePlanLimits } from '../plans/plan-limits';
import { QueueStore } from '../queues/queue-store';

const DAY_SECONDS = 86_400;
/** Invocations deleted per statement: each a short transaction, holding few locks. */
export const PURGE_BATCH = 1_000;
/** How long a notification's deliveries are kept, to show how they went. */
export const DELIVERY_DAYS = 30;
/** How long customers' messages are kept: what became of each recipient, which the reputation's 14 days are judged on. */
export const EMAIL_DAYS = 30;

/**
 * What FF keeps only for a while, deleted by one job, at start and then every
 * FF_RETENTION_INTERVAL_SECONDS (an hour):
 * - the invocation history: its inputs and outputs are the personal data of
 *   the customer's own users, so it is kept only for the account's plan's
 *   historyRetentionDays;
 * - notification deliveries, kept 30 days to show how they went; customers'
 *   messages too, to show what became of each recipient, their bounces and
 *   complaints reviewed over the last 14 (ADR 0012);
 * - queues' messages past their expiry: an asynchronous call an hour past
 *   the longest age a function may give it, which its worker hasn't seen;
 * - packages that no function names, an hour after their upload;
 * - a closed account's functions, their history and logs, its packages, its
 *   databases, its caches, its queues, its alarms, notification deliveries and
 *   webhook secret, its mail's domains and addresses with their DKIM keys, its
 *   messages and its suppression list, once the notice period its closure set
 *   has passed.
 * Usage records, the ledger, invoices and the audit log are not touched: the
 * law requires keeping them for years. Last, the same job makes again the code
 * images the registry has lost (FunctionsService.restoreCodeImages): hourly,
 * and at once when the backend restarts.
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
    private readonly packages: PackagesService,
    private readonly databases: DatabasesService,
    private readonly buckets: BucketsService,
    @Inject(ORCHESTRATOR) private readonly orchestrator: Orchestrator,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly queues: QueueStore,
    private readonly caches: CachesService,
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

  /** The purges, then the closed accounts, then the lost code images: a failure of any is logged, and the next run tries again. */
  private runInBackground(): void {
    if (this.running) return;
    this.running = (async () => {
      await this.purgeHistory().catch((error: unknown) => this.logger.error(`Could not purge the invocation history: ${describeError(error)}`));
      await this.purgeDeliveries().catch((error: unknown) => this.logger.error(`Could not purge the notification deliveries: ${describeError(error)}`));
      await this.purgeMessages().catch((error: unknown) => this.logger.error(`Could not purge the expired messages: ${describeError(error)}`));
      await this.purgeEmails().catch((error: unknown) => this.logger.error(`Could not purge the customers' old mail: ${describeError(error)}`));
      await this.packages.purgeUnused().catch((error: unknown) => this.logger.error(`Could not purge the unused packages: ${describeError(error)}`));
      await this.deleteClosedAccounts().catch((error: unknown) => this.logger.error(`Could not look for closed accounts to delete: ${describeError(error)}`));
      await this.functions.restoreCodeImages().catch((error: unknown) => this.logger.error(`Could not restore the lost code images: ${describeError(error)}`));
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

  /** Deletes the notification deliveries made more than 30 days before the database's now (or `now`), a batch at a time. */
  async purgeDeliveries(now?: Date, batch = PURGE_BATCH): Promise<number> {
    let deleted = 0;
    for (;;) {
      const [, count] = await this.dataSource.query<[unknown[], number]>(
        `DELETE FROM "notification_deliveries" WHERE "id" IN (
           SELECT "id" FROM "notification_deliveries" WHERE "created_at" < coalesce($1::timestamptz, now()) - make_interval(days => $2) LIMIT $3)`,
        [now ?? null, DELIVERY_DAYS, batch],
      );
      deleted += count;
      if (count < batch) break;
    }
    if (deleted) this.logger.log(`Deleted ${deleted} notification deliveries older than ${DELIVERY_DAYS} days`);
    return deleted;
  }

  /** Deletes customers' messages sent more than 30 days before the database's now (or `now`), a batch at a time. */
  async purgeEmails(now?: Date, batch = PURGE_BATCH): Promise<number> {
    let deleted = 0;
    for (;;) {
      const [, count] = await this.dataSource.query<[unknown[], number]>(
        `DELETE FROM "email_messages" WHERE "id" IN (
           SELECT "id" FROM "email_messages" WHERE "created_at" < coalesce($1::timestamptz, now()) - make_interval(days => $2) LIMIT $3)`,
        [now ?? null, EMAIL_DAYS, batch],
      );
      deleted += count;
      if (count < batch) break;
    }
    if (deleted) this.logger.log(`Deleted ${deleted} customers' message(s) older than ${EMAIL_DAYS} days`);
    return deleted;
  }

  /** Deletes the queues' messages past their expiry, before the database's now (or `now`); returns how many. */
  async purgeMessages(now?: Date): Promise<number> {
    const deleted = await this.queues.purgeExpired(now, PURGE_BATCH);
    if (deleted) this.logger.log(`Deleted ${deleted} message(s) past their expiry`);
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
   * records each in the audit log); then its packages; then its databases, from
   * customers' database server, and its caches, from customers' cache server;
   * then its buckets, emptied, and its access keys, revoked; then its
   * namespace, so that nothing writes more of its lines; then its lines in the
   * log store. Then, at once, its queues with their messages, its alarms,
   * notification deliveries and webhook secret, its mail and what its keys used
   * go, and the account is marked, with an entry in its audit log, once. Each
   * step may run again, so a run that failed part way is finished by the next.
   */
  private async deleteAccountData(accountId: string): Promise<void> {
    const functions = await this.dataSource.getRepository(Function).find({ where: { accountId }, order: { createdAt: 'ASC' } });
    for (const fn of functions) await this.functions.remove(accountId, fn.id);
    const packages = await this.packages.deleteAll(accountId);
    // Its databases, with their data, from customers' database server (ADR 0008).
    const databases = await this.databases.deleteAll(accountId);
    // Its caches, with their keys, from customers' cache server (ADR 0013).
    const caches = await this.caches.deleteAll(accountId);
    // Its buckets, with their files, from the store, and its keys to them (ADR 0009).
    const buckets = await this.buckets.deleteAll(accountId);
    await this.orchestrator.removeTenant(accountId);
    await this.orchestrator.deleteLogs(accountId);
    await this.dataSource.transaction(async (manager) => {
      await manager.query(`DELETE FROM "notification_deliveries" WHERE "account_id" = $1`, [accountId]);
      await manager.query(`DELETE FROM "webhook_secrets" WHERE "account_id" = $1`, [accountId]);
      await manager.query(`DELETE FROM "alarms" WHERE "account_id" = $1`, [accountId]);
      // Its mail (ADR 0012): its domains' and addresses' DKIM keys with them, its messages, its suppression list.
      for (const table of ['email_messages', 'email_sending', 'email_identities', 'email_suppressions']) {
        await manager.query(`DELETE FROM "${table}" WHERE "account_id" = $1`, [accountId]);
      }
      // Its functions' own went with them; any other goes with its messages.
      await manager.query(`DELETE FROM "queues" WHERE "account_id" = $1`, [accountId]);
      // What its keys used, which no export reads any more.
      await manager.query(`DELETE FROM "key_uses" WHERE "account_id" = $1`, [accountId]);
      const marked = await manager.update(Account, { id: accountId, dataDeletedAt: IsNull() }, { dataDeletedAt: new Date() });
      if (!marked.affected) return;
      await this.audit.record(
        { accountId, action: 'account.data_delete', resource: `account:${accountId}`, details: { functions: functions.length, packages, databases, caches, buckets } },
        manager,
      );
    });
    this.logger.log(`Deleted the functions, history, logs and notifications of closed account ${accountId}, its notice period over: ${functions.length} function(s)`);
  }
}

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { hourOf } from '../billing/rating-hours';
import { describeError } from '../common/describe-error';
import { BYTES_PER_MB, StorageShare } from '../databases/storage-notice';
import { NotificationsService } from '../notifications/notifications.service';
import { PlanView } from '../plans/plan-limits';
import { PlansService } from '../plans/plans.service';
import { Bucket, BucketStatus } from './bucket.entity';
import { BucketStorageStep, bucketStorageMail, bucketStorageStep } from './bucket-storage';
import { StoreBuckets } from './store-buckets';

const MINUTE_MS = 60_000;
/** One backend measures at a time: the others skip their turn. */
const SAMPLE_LOCK = `hashtext('ff_bucket_samples')`;

/** An account to measure, as its row was read: what it was last told of its buckets' storage. */
interface DueAccount {
  id: string;
  notice: StorageShare | null;
}

/**
 * Customers' buckets measured every hour (ADR 0009, §8): each one's listing,
 * its sizes summed and its objects counted, into bucket_samples, which the
 * bill prices and the metrics read. Each minute, every account with a bucket
 * not measured yet in the hour has all its buckets measured, so that they are
 * weighed together against its plan's storage: all of them at the hour's
 * start, and a new one within a minute. An account whose buckets are full is
 * measured every minute, so that deleting files lets its uploads in again
 * within a minute. A closed account's are not measured: their files wait for
 * its deletion date, unbilled.
 */
@Injectable()
export class BucketSamplesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BucketSamplesService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly dataSource: DataSource,
    private readonly store: StoreBuckets,
    private readonly plans: PlansService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const turn = () => void this.sampleDue().catch((error: unknown) => this.logger.error(`The buckets' hourly measure failed: ${describeError(error)}`));
    turn();
    this.timer = setInterval(turn, MINUTE_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /**
   * Measures the buckets due in the hour of `now`, and answers how many
   * samples it wrote. A turn that comes while another runs, here or in
   * another backend, does nothing: one holds PostgreSQL's advisory lock.
   */
  async sampleDue(now = new Date()): Promise<number> {
    const hour = hourOf(now);
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      const [{ locked }] = (await runner.query(`SELECT pg_try_advisory_lock(${SAMPLE_LOCK}) AS "locked"`)) as Array<{ locked: boolean }>;
      if (!locked) return 0;
      try {
        // A bucket not measured in the hour; or the account full; or told of its storage, with no bucket left to hold any.
        const due = await this.dataSource.query<Array<{ id: string; notice: number | null }>>(
          `SELECT a."id", a."bucket_storage_notice" AS "notice" FROM "accounts" a
            WHERE a."status" <> 'closed'
              AND (a."bucket_storage_notice" = 100
                   OR EXISTS (SELECT 1 FROM "buckets" b WHERE b."account_id" = a."id" AND b."status" = $2
                                AND NOT EXISTS (SELECT 1 FROM "bucket_samples" s WHERE s."bucket_id" = b."id" AND s."hour" = $1))
                   OR (a."bucket_storage_notice" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "buckets" b WHERE b."account_id" = a."id" AND b."status" = $2)))
            ORDER BY a."id"`,
          [hour, BucketStatus.ACTIVE],
        );
        if (due.length === 0) return 0;
        const plans = await this.plans.forAccounts(due.map((account) => account.id));
        let written = 0;
        for (const account of due) {
          const plan = plans.get(account.id);
          if (!plan) {
            this.logger.warn(`The buckets of account ${account.id} weren't measured: its account has no plan`);
            continue;
          }
          try {
            written += await this.measureAccount({ id: account.id, notice: account.notice as StorageShare | null }, plan, hour, now);
          } catch (error) {
            this.logger.error(`The buckets of account ${account.id} weren't measured: ${describeError(error)}`);
          }
        }
        return written;
      } finally {
        await runner.query(`SELECT pg_advisory_unlock(${SAMPLE_LOCK})`);
      }
    } finally {
      await runner.release();
    }
  }

  /**
   * All of an account's active buckets measured: each one's sample of the hour
   * written unless it has one; then, from their total, its owners told and its
   * uploads let in or made to wait, in the same transaction. Answers how many
   * samples it wrote.
   */
  private async measureAccount(account: DueAccount, plan: PlanView, hour: Date, now: Date): Promise<number> {
    const buckets = await this.dataSource.getRepository(Bucket).find({ where: { accountId: account.id, status: BucketStatus.ACTIVE }, order: { name: 'ASC' } });
    const measured: Array<{ bucket: Bucket; sizeBytes: bigint; objects: bigint }> = [];
    for (const bucket of buckets) measured.push({ bucket, ...(await this.store.measure(bucket.storeName)) });
    const total = measured.reduce((sum, { sizeBytes }) => sum + sizeBytes, 0n);
    const step = bucketStorageStep(account.notice, total, plan.limits.bucketStorageMb);
    return this.dataSource.transaction(async (manager) => {
      let written = 0;
      for (const { bucket, sizeBytes, objects } of measured) {
        const rows = await manager.query<unknown[]>(
          `INSERT INTO "bucket_samples" ("bucket_id", "hour", "account_id", "name", "size_bytes", "objects") VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT DO NOTHING RETURNING "bucket_id"`,
          [bucket.id, hour, account.id, bucket.name, sizeBytes.toString(), objects.toString()],
        );
        written += rows.length;
      }
      // Changed only from the state it was read in: a measure that raced another keeps the other's.
      const { affected } = await manager
        .getRepository(Account)
        .update({ id: account.id, bucketStorageNotice: account.notice ?? IsNull() }, { bucketStorageNotice: step.notice });
      if (affected && step.notify) await this.notify(manager, account.id, step, total, plan, now);
      return written;
    });
  }

  /** The owners' e-mail, delivered and retried as notifications are, with its facts for the deliveries' list. */
  private async notify(manager: EntityManager, accountId: string, step: BucketStorageStep, sizeBytes: bigint, plan: PlanView, now: Date): Promise<void> {
    const account = await manager.getRepository(Account).findOneByOrFail({ id: accountId });
    const { consoleUrl } = this.config.getOrThrow<{ consoleUrl: string }>('mail');
    const share = step.notify as StorageShare;
    const storageMb = plan.limits.bucketStorageMb;
    await this.notifications.notify(
      {
        accountId,
        kind: 'bucket.storage',
        data: {
          share,
          sizeBytes: Number(sizeBytes),
          storageLimitBytes: Number(BigInt(storageMb) * BYTES_PER_MB),
          uploadsRefused: share === 100,
          at: now.toISOString(),
        },
        email: (language) => bucketStorageMail({ account: { id: account.id, name: account.name }, share, sizeBytes, storageMb, planName: plan.name, consoleUrl }, language),
      },
      manager,
    );
  }
}

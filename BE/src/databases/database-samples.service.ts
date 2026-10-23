import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { hourOf } from '../billing/rating-hours';
import { describeError } from '../common/describe-error';
import { NotificationsService } from '../notifications/notifications.service';
import { PlanView } from '../plans/plan-limits';
import { PlansService } from '../plans/plans.service';
import { DATA_SERVER, DataServer, DatabaseUse } from './data-server';
import { Database, DatabaseStatus } from './database.entity';
import { BYTES_PER_MB, StorageStep, storageMail, storageStep } from './storage-notice';

const MINUTE_MS = 60_000;
/** One backend samples at a time: the others skip their turn. */
const SAMPLE_LOCK = `hashtext('ff_database_samples')`;
/** The databases an hourly sample measures: those that exist on the server, their users able to log in or not. */
const SAMPLED = [DatabaseStatus.ACTIVE, DatabaseStatus.READ_ONLY, DatabaseStatus.SUSPENDED];

/**
 * Customers' databases measured every hour (ADR 0008): each one's size and
 * sessions, as the server counts them, into database_samples, which the bill
 * prices and the metrics read. Each minute, every database not measured yet
 * in the hour is: all of them at the hour's start, and a new one within a
 * minute. A closed account's are not: their data waits for its deletion
 * date, unbilled. At each sample, past 80% and 100% of the plan's storage its
 * owners are told, and past 100% its new sessions start read-only until it is
 * back under (storageStep()).
 */
@Injectable()
export class DatabaseSamplesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseSamplesService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly dataSource: DataSource,
    @Inject(DATA_SERVER) private readonly server: DataServer | null,
    private readonly plans: PlansService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (!this.server) return;
    const turn = () => void this.sampleDue().catch((error: unknown) => this.logger.error(`The databases' hourly sample failed: ${describeError(error)}`));
    turn();
    this.timer = setInterval(turn, MINUTE_MS);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /**
   * Measures every database not measured yet in the hour of `now`, and
   * answers how many it measured. A turn that comes while another runs, here
   * or in another backend, does nothing: one holds PostgreSQL's advisory lock.
   */
  async sampleDue(now = new Date()): Promise<number> {
    const server = this.server;
    if (!server) return 0;
    const hour = hourOf(now);
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      const [{ locked }] = (await runner.query(`SELECT pg_try_advisory_lock(${SAMPLE_LOCK}) AS "locked"`)) as Array<{ locked: boolean }>;
      if (!locked) return 0;
      try {
        const due = await this.dataSource
          .getRepository(Database)
          .createQueryBuilder('d')
          .innerJoin(Account, 'a', 'a.id = d.accountId')
          .where('d.status IN (:...sampled)', { sampled: SAMPLED })
          .andWhere(`a.status <> 'closed'`)
          .andWhere(`NOT EXISTS (SELECT 1 FROM "database_samples" s WHERE s."database_id" = d."id" AND s."hour" = :hour)`, { hour })
          .orderBy('d.accountId')
          .addOrderBy('d.name')
          .getMany();
        if (due.length === 0) return 0;
        const use = await server.use(due.map((row) => row.dbName));
        const plans = await this.plans.forAccounts([...new Set(due.map((row) => row.accountId))]);
        let sampled = 0;
        for (const row of due) {
          const measured = use.get(row.dbName);
          const plan = plans.get(row.accountId);
          if (!measured || !plan) {
            this.logger.warn(`Database ${row.id} of account ${row.accountId} wasn't measured: ${measured ? 'its account has no plan' : 'the server has no such database'}`);
            continue;
          }
          try {
            if (await this.sampleOne(server, row, measured, plan, hour, now)) sampled++;
          } catch (error) {
            this.logger.error(`Database ${row.id} of account ${row.accountId} wasn't measured: ${describeError(error)}`);
          }
        }
        return sampled;
      } finally {
        await runner.query(`SELECT pg_advisory_unlock(${SAMPLE_LOCK})`);
      }
    } finally {
      await runner.release();
    }
  }

  /** One database's sample: the signal on the server as its size says, then the sample, its row and the owners' notice together. */
  private async sampleOne(server: DataServer, row: Database, measured: DatabaseUse, plan: PlanView, hour: Date, now: Date): Promise<boolean> {
    const storageMb = plan.limits.databaseStorageMb;
    let step = storageStep(row, measured.sizeBytes, storageMb);
    try {
      if (step.signal === 'start') await server.setReadOnly(row.dbName, true);
      else if (step.signal === 'again') await server.setReadOnly(row.dbName, true, false);
      else if (step.signal === 'end') await server.setReadOnly(row.dbName, false);
    } catch (error) {
      // Measured all the same; the signal and its notice wait for the next hour's sample.
      this.logger.warn(`Could not set database ${row.id}'s read-only signal: ${describeError(error)}`);
      step = { notify: null, notice: row.storageNotice, signal: null, status: row.status };
    }
    return this.dataSource.transaction(async (manager) => {
      const written = await manager.query<unknown[]>(
        `INSERT INTO "database_samples" ("database_id", "hour", "account_id", "name", "size_bytes", "connections") VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING RETURNING "database_id"`,
        [row.id, hour, row.accountId, row.name, measured.sizeBytes.toString(), measured.connections],
      );
      if (written.length === 0) return false;
      // Changed only from the state it was read in: a database deleted or suspended meanwhile keeps what that wrote.
      const { affected } = await manager
        .getRepository(Database)
        .update({ id: row.id, status: row.status, storageNotice: row.storageNotice ?? IsNull() }, { status: step.status, storageNotice: step.notice });
      if (affected && step.notify) await this.notify(manager, row, step, measured.sizeBytes, plan, now);
      return true;
    });
  }

  /** The owners' e-mail, delivered and retried as notifications are, with its facts for the deliveries' list. */
  private async notify(manager: EntityManager, row: Database, step: StorageStep, sizeBytes: bigint, plan: PlanView, now: Date): Promise<void> {
    const account = await manager.getRepository(Account).findOneByOrFail({ id: row.accountId });
    const { consoleUrl } = this.config.getOrThrow<{ consoleUrl: string }>('mail');
    const storageMb = plan.limits.databaseStorageMb;
    const facts = {
      account: { id: account.id, name: account.name },
      database: { id: row.id, name: row.name },
      share: step.notify as 80 | 100,
      sizeBytes,
      storageMb,
      planName: plan.name,
      readOnly: step.status === DatabaseStatus.READ_ONLY,
      consoleUrl,
    };
    await this.notifications.notify(
      {
        accountId: row.accountId,
        kind: 'database.storage',
        data: {
          database: facts.database,
          share: facts.share,
          sizeBytes: Number(sizeBytes),
          storageLimitBytes: Number(BigInt(storageMb) * BYTES_PER_MB),
          readOnly: facts.readOnly,
          at: now.toISOString(),
        },
        email: (language) => storageMail(facts, language),
      },
      manager,
    );
  }
}

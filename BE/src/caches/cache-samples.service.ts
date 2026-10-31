import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { hourOf } from '../billing/rating-hours';
import { describeError } from '../common/describe-error';
import { CACHE_SERVER, CacheServer } from './cache-server';
import { Cache, CacheStatus } from './cache.entity';

const MINUTE_MS = 60_000;
/** One backend samples at a time: the others skip their turn. */
const SAMPLE_LOCK = `hashtext('ff_cache_samples')`;
/** The caches an hourly sample measures: those running on the server, their users let in or not. */
const SAMPLED = [CacheStatus.ACTIVE, CacheStatus.SUSPENDED];

/**
 * Customers' caches measured every hour (ADR 0013): each one's memory, the
 * plan's, which the hour is billed for, and what its server counts of it, into
 * cache_samples, which the bill prices and the metrics read. Each minute,
 * every cache not measured yet in the hour is: all of them at the hour's
 * start, and a new one within a minute. A closed account's are not: they wait
 * for its data deletion date, unbilled. A cache the server doesn't measure is
 * tried again the next minute; an hour it never is in isn't billed.
 */
@Injectable()
export class CacheSamplesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheSamplesService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly dataSource: DataSource,
    @Inject(CACHE_SERVER) private readonly server: CacheServer | null,
  ) {}

  onModuleInit(): void {
    if (!this.server) return;
    const turn = () => void this.sampleDue().catch((error: unknown) => this.logger.error(`The caches' hourly sample failed: ${describeError(error)}`));
    turn();
    this.timer = setInterval(turn, MINUTE_MS);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /**
   * Measures every cache not measured yet in the hour of `now`, and answers
   * how many it measured. A turn that comes while another runs, here or in
   * another backend, does nothing: one holds PostgreSQL's advisory lock.
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
          .getRepository(Cache)
          .createQueryBuilder('c')
          .innerJoin(Account, 'a', 'a.id = c.accountId')
          .where('c.status IN (:...sampled)', { sampled: SAMPLED })
          .andWhere(`a.status <> 'closed'`)
          .andWhere(`NOT EXISTS (SELECT 1 FROM "cache_samples" s WHERE s."cache_id" = c."id" AND s."hour" = :hour)`, { hour })
          .orderBy('c.accountId')
          .addOrderBy('c.name')
          .getMany();
        if (due.length === 0) return 0;
        const use = await server.use(due.map((row) => row.serverName));
        let sampled = 0;
        for (const row of due) {
          const measured = use.get(row.serverName);
          if (!measured) {
            this.logger.warn(`Cache ${row.id} of account ${row.accountId} wasn't measured: the server doesn't run it now`);
            continue;
          }
          const written = await this.dataSource.query<unknown[]>(
            `INSERT INTO "cache_samples" ("cache_id", "hour", "account_id", "name", "memory_mb", "bytes_used", "connections", "hits", "misses", "evictions", "process_started_at")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT DO NOTHING RETURNING "cache_id"`,
            [
              row.id,
              hour,
              row.accountId,
              row.name,
              row.memoryMb,
              measured.bytesUsedForCache,
              measured.currConnections,
              measured.cacheHits,
              measured.cacheMisses,
              measured.evictions,
              new Date(now.getTime() - measured.uptimeSeconds * 1000),
            ],
          );
          if (written.length > 0) sampled++;
        }
        return sampled;
      } finally {
        await runner.query(`SELECT pg_advisory_unlock(${SAMPLE_LOCK})`);
      }
    } finally {
      await runner.release();
    }
  }
}

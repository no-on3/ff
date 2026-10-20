import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { describeError } from '../common/describe-error';
import { ORCHESTRATOR, Orchestrator } from '../orchestrator/orchestrator.types';

const MINUTE_MS = 60_000;
/** How far into each minute the sample is taken. */
const OFFSET_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Milliseconds until the next sample: 5 s into a minute, this one's if it is still to come. */
export function nextSampleDelay(nowMs: number): number {
  const into = nowMs % MINUTE_MS;
  return into < OFFSET_MS ? OFFSET_MS - into : MINUTE_MS - into + OFFSET_MS;
}

/**
 * Capacity samples (client-readiness plan, P-21, D6): once a minute, every
 * function with a ready instance gets a row with how many, its minInstances and
 * its memory. D8's cost model weighs that capacity against what is billed, and
 * D8 bills minInstances as provisioned time from it. Runs in every backend
 * replica: a minute sampled twice keeps its first row.
 */
@Injectable()
export class CapacityService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CapacityService.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    @Inject(ORCHESTRATOR) private readonly orchestrator: Orchestrator,
    private readonly dataSource: DataSource,
  ) {}

  onModuleInit(): void {
    this.schedule();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** The next sample, then the one after: a sample that runs late skips a minute rather than doubling one. */
  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.sample()
        .catch((error: unknown) => this.logger.error(`Could not sample capacity: ${describeError(error)}`))
        .finally(() => this.schedule());
    }, nextSampleDelay(Date.now()));
  }

  /**
   * Samples one minute, by the database's clock unless `at` names it: the ready
   * instances from one call to the orchestrator, written with each function's
   * account, minInstances and memory in one statement. A function the
   * database doesn't know (deleted meanwhile) is skipped, and a minute already
   * sampled keeps its rows. Returns how many rows it wrote.
   */
  async sample(at?: Date): Promise<number> {
    const ready = [...(await this.orchestrator.readyInstancesByFunction())].filter(([functionId]) => UUID.test(functionId));
    if (ready.length === 0) return 0;
    const written = await this.dataSource.query<Array<{ function_id: string }>>(
      `INSERT INTO "capacity_samples" ("function_id", "minute", "account_id", "instances", "min_instances", "memory_mb")
       SELECT f."id", date_trunc('minute', coalesce($3::timestamptz, now()) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
              f."account_id", r."instances", f."min_instances", f."memory"
         FROM unnest($1::uuid[], $2::int[]) AS r("function_id", "instances")
         JOIN "functions" f ON f."id" = r."function_id"
       ON CONFLICT DO NOTHING
       RETURNING "function_id"`,
      [ready.map(([functionId]) => functionId), ready.map(([, instances]) => instances), at ?? null],
    );
    return written.length;
  }
}

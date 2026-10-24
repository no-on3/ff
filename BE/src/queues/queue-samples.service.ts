import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { describeError } from '../common/describe-error';
import { nextSampleDelay } from '../usage/capacity.service';

/**
 * Customers' queues sampled once a minute (ADR 0010), as CloudWatch has SQS's
 * approximate metrics: every queue holding a message gets a row with its
 * messages that can be received, those received and hidden, those waiting for
 * their delay, and the age of its oldest, in one statement over the messages.
 * A queue with none has no row: its metrics read a minute without one as an
 * empty queue. Runs in every backend: a minute sampled twice keeps its first
 * row.
 */
@Injectable()
export class QueueSamples implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueSamples.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly dataSource: DataSource) {}

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
        .catch((error: unknown) => this.logger.error(`Could not sample the queues: ${describeError(error)}`))
        .finally(() => this.schedule());
    }, nextSampleDelay(Date.now()));
    this.timer.unref();
  }

  /**
   * Samples one minute, by the database's clock unless `at` names it: each
   * customer's queue holding a message, its messages counted as SQS's
   * attributes count them and its oldest message's age in seconds. A minute
   * already sampled keeps its rows. Returns how many rows it wrote.
   */
  async sample(at?: Date): Promise<number> {
    const written = await this.dataSource.query<Array<{ queue_id: string }>>(
      `WITH "now" AS (SELECT coalesce($1::timestamptz, now()) AS "at")
       INSERT INTO "queue_samples" ("queue_id", "minute", "account_id", "visible", "not_visible", "delayed", "oldest_age_seconds")
       SELECT m."queue_id", date_trunc('minute', n."at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', q."account_id",
              count(*) FILTER (WHERE m."visible_at" <= n."at"),
              count(*) FILTER (WHERE m."visible_at" > n."at" AND m."receive_count" > 0),
              count(*) FILTER (WHERE m."visible_at" > n."at" AND m."receive_count" = 0),
              greatest(floor(extract(epoch FROM n."at" - min(m."sent_at"))), 0)::int
         FROM "queue_messages" m JOIN "queues" q ON q."id" = m."queue_id" AND q."kind" = 'customer', "now" n
        WHERE m."expires_at" > n."at"
        GROUP BY m."queue_id", q."account_id", n."at"
       ON CONFLICT DO NOTHING
       RETURNING "queue_id"`,
      [at ?? null],
    );
    return written.length;
  }
}

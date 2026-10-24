import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { describeError } from '../common/describe-error';
import { minuteOf } from '../storage/request-tally';
import { QueueRequestCount } from './queue-request-count.entity';
import { QueueTally, QueueUse, TalliedQueueMinute } from './queue-tally';

const MINUTE_MS = 60_000;

/**
 * Customers' queues' requests, counted in memory and written once a minute: a
 * row per queue and minute, each minute once it is over, and what is left
 * when the backend stops. Each is counted in the minute it was answered, not
 * the one it began in: a long poll of 20 s answered after its first minute
 * was written would otherwise write that minute a second time, which its key
 * refuses. Rows that can't be written go back in memory, for the next turn.
 */
@Injectable()
export class QueueRequestCounts implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueRequestCounts.name);
  private readonly tally = new QueueTally();
  /** This process, as the rows it writes name it. */
  readonly writer = randomUUID();
  private timer?: NodeJS.Timeout;

  constructor(@InjectRepository(QueueRequestCount) private readonly counts: Repository<QueueRequestCount>) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.flush(minuteOf(new Date())), MINUTE_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }

  /** What a request did to its queue, counted in this minute. */
  count(use: QueueUse): void {
    this.tally.add(use, new Date());
  }

  /** Writes the minutes that started before `before`, or all of them; answers how many rows went. */
  async flush(before?: Date): Promise<number> {
    const rows = this.tally.take(before);
    if (rows.length === 0) return 0;
    try {
      await this.counts.insert(rows.map((row) => this.entity(row)));
      return rows.length;
    } catch (error) {
      this.tally.restore(rows);
      this.logger.warn(`Could not write ${rows.length} minute(s) of queues' requests, kept for the next try: ${describeError(error)}`);
      return 0;
    }
  }

  private entity(row: TalliedQueueMinute): QueueRequestCount {
    return Object.assign(new QueueRequestCount(), { ...row, writer: this.writer });
  }
}

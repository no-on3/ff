import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { describeError } from '../common/describe-error';
import { CountedRequest, RequestTally, TalliedMinute, minuteOf } from './request-tally';
import { StorageRequestCount } from './storage-request-count.entity';

const MINUTE_MS = 60_000;

/**
 * Buckets' requests, counted by the front door in memory and written once a
 * minute (ADR 0009, §7): a row per bucket, minute and class, each minute once
 * it is over, and what is left when the backend stops. Rows that can't be
 * written go back in memory, for the next minute's turn.
 */
@Injectable()
export class StorageRequestCountsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StorageRequestCountsService.name);
  private readonly tally = new RequestTally();
  /** This process, as the rows it writes name it. */
  readonly writer = randomUUID();
  private timer?: NodeJS.Timeout;
  /** The minutes before this one are written, or being written. */
  private writtenBefore?: Date;

  constructor(@InjectRepository(StorageRequestCount) private readonly counts: Repository<StorageRequestCount>) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.flush(minuteOf(new Date())), MINUTE_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }

  count(request: CountedRequest): void {
    // A request that began in a minute written since, such as an upload answered after its minute's turn, counts in
    // the first minute not written: the key of the one it began in would refuse that minute a second time.
    const late = this.writtenBefore !== undefined && request.at < this.writtenBefore;
    this.tally.add(late ? { ...request, at: this.writtenBefore as Date } : request);
  }

  /** Writes the minutes that started before `before`, or all of them; answers how many rows went. */
  async flush(before?: Date): Promise<number> {
    if (before && !(this.writtenBefore && this.writtenBefore >= before)) this.writtenBefore = before;
    const rows = this.tally.take(before);
    if (rows.length === 0) return 0;
    try {
      await this.counts.insert(rows.map((row) => this.entity(row)));
      return rows.length;
    } catch (error) {
      this.tally.restore(rows);
      this.logger.warn(`Could not write ${rows.length} minute(s) of buckets' requests, kept for the next try: ${describeError(error)}`);
      return 0;
    }
  }

  private entity(row: TalliedMinute): StorageRequestCount {
    return Object.assign(new StorageRequestCount(), {
      bucketId: row.bucketId,
      minute: row.minute,
      class: row.class,
      writer: this.writer,
      accountId: row.accountId,
      name: row.name,
      requests: row.requests,
      gets: row.gets,
      puts: row.puts,
      errors4xx: row.errors4xx,
      errors5xx: row.errors5xx,
      bytesIn: row.bytesIn,
      bytesOut: row.bytesOut,
    });
  }
}

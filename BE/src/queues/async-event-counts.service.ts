import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { describeError } from '../common/describe-error';
import { minuteOf } from '../storage/request-tally';
import { AsyncEventCount } from './async-event-count.entity';

const MINUTE_MS = 60_000;

/** What happened to a function's asynchronous calls, as Lambda's metrics count it. */
export interface AsyncEventUse {
  functionId: string;
  accountId: string;
  /** Events kept for it. */
  received?: number;
  /** Events that ended without its success, past their retries or their age. */
  dropped?: number;
  /** Records its destination didn't take. */
  destinationFailures?: number;
  /** An attempt's age: from its event's keeping to the attempt. */
  ageMs?: number;
}

type Minute = Omit<AsyncEventCount, 'writer'>;

const keyOf = (functionId: string, minute: Date) => `${functionId}|${minute.toISOString()}`;

/**
 * Functions' asynchronous calls, counted in memory and written once a minute:
 * a row per function and minute, each minute once it is over, and what is
 * left when the backend stops; each counted in the minute it happened, so
 * that a minute written takes nothing more. Rows that can't be written go
 * back in memory, for the next turn.
 */
@Injectable()
export class AsyncEventCounts implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AsyncEventCounts.name);
  private readonly minutes = new Map<string, Minute>();
  /** This process, as the rows it writes name it. */
  readonly writer = randomUUID();
  private timer?: NodeJS.Timeout;

  constructor(@InjectRepository(AsyncEventCount) private readonly counts: Repository<AsyncEventCount>) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.flush(minuteOf(new Date())), MINUTE_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }

  /** What happened to a function's call, counted in this minute. */
  count(use: AsyncEventUse): void {
    this.add({
      functionId: use.functionId,
      minute: minuteOf(new Date()),
      accountId: use.accountId,
      received: use.received ?? 0,
      dropped: use.dropped ?? 0,
      destinationFailures: use.destinationFailures ?? 0,
      attempts: use.ageMs === undefined ? 0 : 1,
      ageMsSum: BigInt(Math.round(use.ageMs ?? 0)),
      ageMsMax: Math.round(use.ageMs ?? 0),
    });
  }

  /** Writes the minutes that started before `before`, or all of them; answers how many rows went. */
  async flush(before?: Date): Promise<number> {
    const rows = [...this.minutes.values()].filter((row) => !before || row.minute < before);
    if (rows.length === 0) return 0;
    for (const row of rows) this.minutes.delete(keyOf(row.functionId, row.minute));
    try {
      await this.counts.insert(rows.map((row) => Object.assign(new AsyncEventCount(), { ...row, writer: this.writer })));
      return rows.length;
    } catch (error) {
      for (const row of rows) this.add(row);
      this.logger.warn(`Could not write ${rows.length} minute(s) of functions' asynchronous calls, kept for the next try: ${describeError(error)}`);
      return 0;
    }
  }

  /** A minute's counts, added to those of the same function and minute. */
  private add(row: Minute): void {
    const id = keyOf(row.functionId, row.minute);
    const current = this.minutes.get(id);
    if (!current) {
      this.minutes.set(id, { ...row });
      return;
    }
    current.received += row.received;
    current.dropped += row.dropped;
    current.destinationFailures += row.destinationFailures;
    current.attempts += row.attempts;
    current.ageMsSum += row.ageMsSum;
    current.ageMsMax = Math.max(current.ageMsMax, row.ageMsMax);
  }
}

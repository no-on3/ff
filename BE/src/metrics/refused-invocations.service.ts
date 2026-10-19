import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { describeError } from '../common/describe-error';

const MINUTE_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The most functions and minutes held between two writes: a flood of made-up IDs can't fill the memory. */
export const MAX_HELD = 10_000;

interface Held {
  accountId: string;
  functionId: string;
  minute: Date;
  count: number;
}

/**
 * Counts the invocations an account's rate limit refuses, for the Throttles
 * metric. They are counted in memory and written once a minute, so that a
 * burst of refused calls, perhaps an attack, doesn't become a database write
 * each. A count for a function that isn't the account's is dropped then. A
 * crash loses at most a minute of counts.
 */
@Injectable()
export class RefusedInvocationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RefusedInvocationsService.name);
  private held = new Map<string, Held>();
  private timer?: NodeJS.Timeout;

  constructor(private readonly dataSource: DataSource) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.flush(), MINUTE_MS);
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }

  /** One refused call of the function, at `at`. An ID that isn't one is ignored: the request named no function. */
  count(accountId: string, functionId: string | undefined, at = new Date()): void {
    if (!functionId || !UUID.test(functionId)) return;
    const minute = new Date(Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS);
    // The account too: a refusal is counted for the function only if it is the account's, which the write checks.
    const key = `${accountId}:${functionId.toLowerCase()}:${minute.getTime()}`;
    const held = this.held.get(key);
    if (held) held.count++;
    else if (this.held.size < MAX_HELD) this.held.set(key, { accountId, functionId: functionId.toLowerCase(), minute, count: 1 });
  }

  /** Writes what is held, adding to what the minute has already, for the account's own functions only. */
  async flush(): Promise<void> {
    const rows = [...this.held.values()];
    this.held = new Map();
    if (rows.length === 0) return;
    try {
      await this.dataSource.query(
        `INSERT INTO "rate_limited_invocations" ("function_id", "minute", "account_id", "count")
         SELECT f."id", v."minute", f."account_id", v."count"
           FROM unnest($1::uuid[], $2::timestamptz[], $3::text[], $4::int[]) AS v("function_id", "minute", "account_id", "count")
           JOIN "functions" f ON f."id" = v."function_id" AND f."account_id" = v."account_id"
         ON CONFLICT ("function_id", "minute") DO UPDATE SET "count" = "rate_limited_invocations"."count" + EXCLUDED."count"`,
        [rows.map((r) => r.functionId), rows.map((r) => r.minute), rows.map((r) => r.accountId), rows.map((r) => r.count)],
      );
    } catch (error) {
      this.logger.error(`Could not write ${rows.length} count(s) of rate-limited invocations: ${describeError(error)}`);
    }
  }
}

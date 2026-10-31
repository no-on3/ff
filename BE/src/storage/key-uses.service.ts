import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { describeError } from '../common/describe-error';
import { AwsEndpoint } from '../common/aws-endpoint';
import { KeyUse } from './key-use.entity';

const MINUTE_MS = 60_000;
/** Rows a statement writes at most: 7 parameters each, far under PostgreSQL's 65,535. */
const BATCH = 500;

/** A key's use of a bucket, a queue or the account's mail, as a front door saw it. */
export interface NotedUse {
  key: { id: string; accountId: string; functionId: string | null };
  service: AwsEndpoint;
  /** The bucket's or the queue's name, the e-mail identity or sender; '' for the account's own. */
  resource: string;
  operation: string;
}

type Row = Pick<KeyUse, 'holder' | 'service' | 'resource' | 'operation' | 'accountId' | 'firstDay' | 'lastDay'>;

/** The UTC day an instant is in, as the table keeps it. */
const dayOf = (at: Date): string => at.toISOString().slice(0, 10);

/**
 * What the account's keys use, noted by the S3 front door, the SQS endpoint and
 * the SES endpoint (KeyUse): each use once a UTC day, in memory, and written
 * at the minute's turn, and what is left when the backend stops. A row's first
 * day stays, its last moves on, never back: every backend writes the uses it
 * saw, and a turn that failed, kept for the next, may come after another's.
 */
@Injectable()
export class KeyUses implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KeyUses.name);
  /** The uses noted on `day`, written or to write, so that each is written once that day. */
  private noted = new Set<string>();
  private day = '';
  /** Those to write at the next turn. */
  private readonly pending = new Map<string, Row>();
  private timer?: NodeJS.Timeout;

  constructor(@InjectRepository(KeyUse) private readonly uses: Repository<KeyUse>) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.flush(), MINUTE_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }

  /** What a holder's keys used, as written: a function's, by its ID, or one of the account's keys, by the key's; by service, resource and operation. */
  async of(accountId: string, holder: string): Promise<Array<Pick<KeyUse, 'service' | 'resource' | 'operation' | 'firstDay' | 'lastDay'>>> {
    return this.uses.find({
      where: { accountId, holder },
      select: { service: true, resource: true, operation: true, firstDay: true, lastDay: true },
      order: { service: 'ASC', resource: 'ASC', operation: 'ASC' },
    });
  }

  /** A key's use, written at the next turn unless it was noted already today. */
  note({ key, service, resource, operation }: NotedUse, at = new Date()): void {
    const day = dayOf(at);
    if (day !== this.day) {
      this.day = day;
      this.noted = new Set();
    }
    const row: Row = { holder: key.functionId ?? key.id, service, resource, operation, accountId: key.accountId, firstDay: day, lastDay: day };
    const id = [row.holder, service, resource, operation].join('\n');
    if (this.noted.has(id)) return;
    this.noted.add(id);
    this.keep(id, row);
  }

  /** Writes the uses noted since the last turn; those that can't be written are kept for the next. Answers how many went. */
  async flush(): Promise<number> {
    if (this.pending.size === 0) return 0;
    const taken = [...this.pending];
    this.pending.clear();
    try {
      for (let start = 0; start < taken.length; start += BATCH) await this.write(taken.slice(start, start + BATCH).map(([, row]) => row));
      return taken.length;
    } catch (error) {
      for (const [id, row] of taken) this.keep(id, row);
      this.logger.warn(`Could not write ${taken.length} use(s) of the account's keys, kept for the next try: ${describeError(error)}`);
      return 0;
    }
  }

  /** A use to write at the next turn, with the one of it kept from a turn that failed, if any: the earlier first day, the later last. */
  private keep(id: string, row: Row): void {
    const kept = this.pending.get(id);
    if (!kept) return void this.pending.set(id, row);
    this.pending.set(id, { ...row, firstDay: kept.firstDay < row.firstDay ? kept.firstDay : row.firstDay, lastDay: kept.lastDay > row.lastDay ? kept.lastDay : row.lastDay });
  }

  private async write(rows: Row[]): Promise<void> {
    const values = rows.map((_, i) => `($${i * 7 + 1}, $${i * 7 + 2}::"key_uses_service_enum", $${i * 7 + 3}, $${i * 7 + 4}, $${i * 7 + 5}, $${i * 7 + 6}::date, $${i * 7 + 7}::date)`);
    await this.uses.query(
      `INSERT INTO "key_uses" ("holder", "service", "resource", "operation", "account_id", "first_day", "last_day") VALUES ${values.join(', ')}
       ON CONFLICT ("holder", "service", "resource", "operation") DO UPDATE
         SET "first_day" = LEAST("key_uses"."first_day", EXCLUDED."first_day"), "last_day" = GREATEST("key_uses"."last_day", EXCLUDED."last_day")`,
      rows.flatMap((row) => [row.holder, row.service, row.resource, row.operation, row.accountId, row.firstDay, row.lastDay]),
    );
  }
}

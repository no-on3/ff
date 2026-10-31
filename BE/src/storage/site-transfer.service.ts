import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StorageRequestCount } from './storage-request-count.entity';

/** How long an account's month, as the counts written so far have it, is used before it is read again. */
const REREAD_MS = 60_000;

const monthStart = (at: Date): Date => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));

/** What an account's sites sent this month: the counts written so far, as last read, and what this process sent since. */
interface Sent {
  month: number;
  written: bigint;
  readAt: number;
  since: bigint;
}

/**
 * What each account's sites sent out this month, in bytes, for the plan's
 * monthly limit: the minutes of their requests already written, read again at
 * most once a minute, and what this process has sent since it last read them.
 * The minutes it has counted but not written yet are left out until they are:
 * an account passes its limit a minute or two late, never early.
 */
@Injectable()
export class SiteTransfer {
  private readonly accounts = new Map<string, Sent>();

  constructor(@InjectRepository(StorageRequestCount) private readonly counts: Repository<StorageRequestCount>) {}

  /** The account's bytes sent by its sites this month, as far as this process knows. */
  async sentThisMonth(accountId: string, now = new Date()): Promise<bigint> {
    const month = monthStart(now).getTime();
    const known = this.accounts.get(accountId);
    if (known && known.month === month && now.getTime() - known.readAt < REREAD_MS) return known.written + known.since;
    const [row] = await this.counts.manager.query<Array<{ bytes: string | null }>>(
      `SELECT sum("bytes_out")::text AS "bytes" FROM "storage_request_counts" WHERE "account_id" = $1 AND "class" = 'website' AND "minute" >= $2`,
      [accountId, new Date(month)],
    );
    const sent: Sent = { month, written: BigInt(row?.bytes ?? 0), readAt: now.getTime(), since: 0n };
    this.accounts.set(accountId, sent);
    return sent.written;
  }

  /** Adds what a site's answer sent, to the account's month as this process knows it. */
  add(accountId: string, bytes: number): void {
    const known = this.accounts.get(accountId);
    if (known) known.since += BigInt(bytes);
  }
}

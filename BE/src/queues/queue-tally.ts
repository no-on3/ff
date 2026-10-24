import { minuteOf } from '../storage/request-tally';

/** The payload each request SQS bills carries: 64 KB. */
export const REQUEST_PAYLOAD_BYTES = 65_536;

/** A request as SQS bills it: each 64 KB of the messages it carries a request, one at least (a SendMessageBatch of 256 KB is 4). */
export const billedRequests = (payloadBytes: number): number => Math.max(1, Math.ceil(payloadBytes / REQUEST_PAYLOAD_BYTES));

/** What one request, or one of FF's deliveries, did to a customer's queue, as it counts. */
export interface QueueUse {
  queueId: string;
  accountId: string;
  queueName: string;
  /** Its requests as SQS bills them (billedRequests()); 0 for what isn't billed, such as FF's deletes after a function's batch. */
  requests: number;
  /** The size of each message kept, body and attributes. */
  sentSizes?: number[];
  received?: number;
  deleted?: number;
  /** 1 for a receive that answered no message. */
  emptyReceives?: number;
}

/** A queue's minute, added up. */
export interface TalliedQueueMinute {
  queueId: string;
  minute: Date;
  accountId: string;
  name: string;
  requests: number;
  sent: number;
  received: number;
  deleted: number;
  emptyReceives: number;
  sentBytes: bigint;
  sentMaxBytes: number;
}

const keyOf = (queueId: string, minute: Date) => `${queueId}|${minute.toISOString()}`;

/** Queues' requests added up in memory by queue and minute, until they are taken to be written. */
export class QueueTally {
  private readonly minutes = new Map<string, TalliedQueueMinute>();

  add(use: QueueUse, at: Date): void {
    const minute = minuteOf(at);
    const id = keyOf(use.queueId, minute);
    let row = this.minutes.get(id);
    if (!row) {
      row = { queueId: use.queueId, minute, accountId: use.accountId, name: use.queueName, requests: 0, sent: 0, received: 0, deleted: 0, emptyReceives: 0, sentBytes: 0n, sentMaxBytes: 0 };
      this.minutes.set(id, row);
    }
    const sizes = use.sentSizes ?? [];
    row.requests += use.requests;
    row.sent += sizes.length;
    row.received += use.received ?? 0;
    row.deleted += use.deleted ?? 0;
    row.emptyReceives += use.emptyReceives ?? 0;
    for (const size of sizes) {
      row.sentBytes += BigInt(size);
      row.sentMaxBytes = Math.max(row.sentMaxBytes, size);
    }
  }

  /** The minutes that started before `before`, taken out; all of them without it. */
  take(before?: Date): TalliedQueueMinute[] {
    const taken: TalliedQueueMinute[] = [];
    for (const [id, row] of this.minutes) {
      if (before && row.minute >= before) continue;
      taken.push(row);
      this.minutes.delete(id);
    }
    return taken;
  }

  /** Minutes that could not be written, back in, added to any counted since. */
  restore(rows: TalliedQueueMinute[]): void {
    for (const row of rows) {
      const id = keyOf(row.queueId, row.minute);
      const current = this.minutes.get(id);
      if (!current) {
        this.minutes.set(id, row);
        continue;
      }
      current.requests += row.requests;
      current.sent += row.sent;
      current.received += row.received;
      current.deleted += row.deleted;
      current.emptyReceives += row.emptyReceives;
      current.sentBytes += row.sentBytes;
      current.sentMaxBytes = Math.max(current.sentMaxBytes, row.sentMaxBytes);
    }
  }

  get size(): number {
    return this.minutes.size;
  }
}

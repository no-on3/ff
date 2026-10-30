import { RequestClass } from './s3-requests';

/**
 * How a bucket's request counts: by S3's classes, or as a site's (a GET of the
 * second class, counted apart for the site's own measures and the plan's
 * monthly limit on what sites send out).
 */
export type CountedClass = RequestClass | 'website';

/** One request answered in a bucket, as it counts. */
export interface CountedRequest {
  bucketId: string;
  accountId: string;
  bucketName: string;
  class: CountedClass;
  method: string;
  status: number;
  bytesIn: number;
  bytesOut: number;
  at: Date;
}

/** A bucket's requests in one minute and one class, added up. */
export interface TalliedMinute {
  bucketId: string;
  minute: Date;
  class: CountedClass;
  accountId: string;
  name: string;
  requests: number;
  gets: number;
  puts: number;
  errors4xx: number;
  errors5xx: number;
  bytesIn: bigint;
  bytesOut: bigint;
}

const MINUTE_MS = 60_000;

/** The minute an instant is in, by its start. */
export const minuteOf = (at: Date): Date => new Date(Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS);

/** Requests added up in memory by bucket, minute and class, until they are taken to be written. */
export class RequestTally {
  private readonly minutes = new Map<string, TalliedMinute>();

  add(request: CountedRequest): void {
    const minute = minuteOf(request.at);
    const id = `${request.bucketId}|${minute.toISOString()}|${request.class}`;
    let row = this.minutes.get(id);
    if (!row) {
      row = {
        bucketId: request.bucketId,
        minute,
        class: request.class,
        accountId: request.accountId,
        name: request.bucketName,
        requests: 0,
        gets: 0,
        puts: 0,
        errors4xx: 0,
        errors5xx: 0,
        bytesIn: 0n,
        bytesOut: 0n,
      };
      this.minutes.set(id, row);
    }
    row.requests += 1;
    if (request.method === 'GET') row.gets += 1;
    if (request.method === 'PUT') row.puts += 1;
    if (request.status >= 400 && request.status < 500) row.errors4xx += 1;
    if (request.status >= 500) row.errors5xx += 1;
    row.bytesIn += BigInt(request.bytesIn);
    row.bytesOut += BigInt(request.bytesOut);
  }

  /** The minutes that started before `before`, taken out; all of them without it. */
  take(before?: Date): TalliedMinute[] {
    const taken: TalliedMinute[] = [];
    for (const [id, row] of this.minutes) {
      if (before && row.minute >= before) continue;
      taken.push(row);
      this.minutes.delete(id);
    }
    return taken;
  }

  /** Minutes that could not be written, back in, added to any counted since. */
  restore(rows: TalliedMinute[]): void {
    for (const row of rows) {
      const id = `${row.bucketId}|${row.minute.toISOString()}|${row.class}`;
      const current = this.minutes.get(id);
      if (!current) {
        this.minutes.set(id, row);
        continue;
      }
      current.requests += row.requests;
      current.gets += row.gets;
      current.puts += row.puts;
      current.errors4xx += row.errors4xx;
      current.errors5xx += row.errors5xx;
      current.bytesIn += row.bytesIn;
      current.bytesOut += row.bytesOut;
    }
  }

  get size(): number {
    return this.minutes.size;
  }
}

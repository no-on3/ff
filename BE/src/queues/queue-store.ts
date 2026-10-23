import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

/** An asynchronous call's event, claimed from its function's queue: what its attempt needs. */
export interface ClaimedEvent {
  /** The message's row. */
  id: string;
  functionId: string;
  accountId: string;
  /** The event's request ID, every attempt's: the message's ID. */
  requestId: string;
  /** The event, as JSON text. */
  body: string;
  /** What the queue keeps of its attempts so far. */
  attributes: Record<string, unknown> | null;
  sentAt: Date;
  /** How many times it was claimed, this claim included. */
  receiveCount: number;
}

/** A claimed event as the claim's SQL returns it. */
interface ClaimedRow {
  id: string;
  function_id: string;
  account_id: string;
  message_id: string;
  body: string;
  attributes: Record<string, unknown> | null;
  sent_at: Date;
  receive_count: number;
}

/** A timeout for a function gone since its event was queued, should its queue outlive it: the platform's longest. */
const LONGEST_TIMEOUT_SECONDS = 900;

/**
 * The queue in FF's database (ADR 0010): every queue's messages in one table,
 * each claimed FOR UPDATE SKIP LOCKED with a lease, so that two consumers
 * never hold one at once and one that stops leaves it to come back when its
 * lease ends. What a claim does with a message afterwards names the claim, by
 * its receive count: a consumer whose lease ended, and whose message another
 * has claimed since, changes nothing.
 */
@Injectable()
export class QueueStore {
  constructor(private readonly dataSource: DataSource) {}

  /** What the account's messages hold together, in bytes: the sum of its queues', which a trigger keeps. */
  async accountBytes(accountId: string, manager: EntityManager = this.dataSource.manager): Promise<number> {
    const [{ bytes }] = await manager.query<Array<{ bytes: string }>>(`SELECT coalesce(sum("size_bytes"), 0)::text AS "bytes" FROM "queues" WHERE "account_id" = $1`, [
      accountId,
    ]);
    return Number(bytes);
  }

  /**
   * Keeps an asynchronous call of the function: its event, under its request
   * ID, in the function's own queue, made at its first call, with what its
   * origin keeps beside it. Due at once; deleted unhandled at `expiresAt`.
   * In the transaction given, else in one of its own.
   */
  async sendEvent(
    fn: { id: string; accountId: string },
    requestId: string,
    body: string,
    expiresAt: Date,
    options: { manager?: EntityManager; attributes?: Record<string, unknown> } = {},
  ): Promise<void> {
    const write = async (manager: EntityManager) => {
      await manager.query(
        `INSERT INTO "queues" ("account_id", "name", "kind", "function_id") VALUES ($1, $2::text, 'function', $2::uuid)
         ON CONFLICT ("function_id") WHERE "kind" = 'function' DO NOTHING`,
        [fn.accountId, fn.id],
      );
      await manager.query(
        `INSERT INTO "queue_messages" ("queue_id", "function_id", "message_id", "body", "attributes", "size_bytes", "expires_at")
         SELECT "id", $1, $2, $3, $4, $5, $6 FROM "queues" WHERE "function_id" = $1 AND "kind" = 'function'`,
        [fn.id, requestId, body, options.attributes ?? null, Buffer.byteLength(body), expiresAt],
      );
    };
    if (options.manager) await write(options.manager);
    else await this.dataSource.transaction(write);
  }

  /**
   * Ends a claimed event and hands its record to another function as an
   * asynchronous call, in one transaction: the record is kept exactly when the
   * event goes. False, and nothing sent, when another claim has the event since.
   */
  async deleteEventAndSend(
    event: Pick<ClaimedEvent, 'id' | 'receiveCount'>,
    target: { id: string; accountId: string },
    requestId: string,
    body: string,
    expiresAt: Date,
  ): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const [, count] = await manager.query<[unknown[], number]>(`DELETE FROM "queue_messages" WHERE "id" = $1 AND "receive_count" = $2`, [
        event.id,
        event.receiveCount,
      ]);
      if (count !== 1) return false;
      await this.sendEvent(target, requestId, body, expiresAt, { manager });
      return true;
    });
  }

  /**
   * Claims up to `limit` asynchronous calls due, of any function, the longest
   * waiting first: each counted as received and hidden for its lease, the
   * longest its attempt can take (a wait for an instance and the call, each
   * up to the function's timeout, after a cold start), and a minute more.
   */
  async claimEvents(limit: number, now: Date, coldStartSeconds: number): Promise<ClaimedEvent[]> {
    if (limit <= 0) return [];
    const [rows] = await this.dataSource.query<[ClaimedRow[], number]>(
      `UPDATE "queue_messages" m
          SET "receive_count" = m."receive_count" + 1,
              "first_received_at" = coalesce(m."first_received_at", $1),
              "visible_at" = $1::timestamptz + make_interval(secs => 2 * coalesce(f."timeout", $4) + $3 + 60)
         FROM "queues" q LEFT JOIN "functions" f ON f."id" = q."function_id"
        WHERE m."id" IN (SELECT "id" FROM "queue_messages"
                          WHERE "function_id" IS NOT NULL AND "visible_at" <= $1
                          ORDER BY "visible_at" LIMIT $2 FOR UPDATE SKIP LOCKED)
          AND q."id" = m."queue_id"
      RETURNING m."id", q."function_id", q."account_id", m."message_id", m."body", m."attributes", m."sent_at", m."receive_count"`,
      [now, limit, coldStartSeconds, LONGEST_TIMEOUT_SECONDS],
    );
    return rows.map((row) => ({
      id: row.id,
      functionId: row.function_id,
      accountId: row.account_id,
      requestId: row.message_id,
      body: row.body,
      attributes: row.attributes,
      sentAt: row.sent_at,
      receiveCount: row.receive_count,
    }));
  }

  /** Puts a claimed event back for its next attempt, at `visibleAt`, with what it keeps of its attempts; false when another claim has it since. */
  async retryEvent(event: Pick<ClaimedEvent, 'id' | 'receiveCount'>, visibleAt: Date, attributes: Record<string, unknown>): Promise<boolean> {
    const [, count] = await this.dataSource.query<[unknown[], number]>(
      `UPDATE "queue_messages" SET "visible_at" = $3, "attributes" = $4 WHERE "id" = $1 AND "receive_count" = $2`,
      [event.id, event.receiveCount, visibleAt, attributes],
    );
    return count === 1;
  }

  /** Deletes a claimed event, its attempts over; false when another claim has it since. */
  async deleteEvent(event: Pick<ClaimedEvent, 'id' | 'receiveCount'>): Promise<boolean> {
    const [, count] = await this.dataSource.query<[unknown[], number]>(`DELETE FROM "queue_messages" WHERE "id" = $1 AND "receive_count" = $2`, [
      event.id,
      event.receiveCount,
    ]);
    return count === 1;
  }

  /** Deletes the messages past their expiry, before the database's now (or `now`), a batch at a time; returns how many. */
  async purgeExpired(now?: Date, batch = 1000): Promise<number> {
    let deleted = 0;
    for (;;) {
      const [, count] = await this.dataSource.query<[unknown[], number]>(
        `DELETE FROM "queue_messages" WHERE "id" IN (
           SELECT "id" FROM "queue_messages" WHERE "expires_at" < coalesce($1::timestamptz, now()) LIMIT $2)`,
        [now ?? null, batch],
      );
      deleted += count;
      if (count < batch) return deleted;
    }
  }
}

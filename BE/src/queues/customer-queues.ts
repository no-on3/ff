import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Queue, QueueKind } from './queue.entity';
import { DEFAULT_SETTINGS, QueueCounts, QueueSettings, differentSetting, parseQueueArn } from './sqs-attributes';
import { SqsError, invalidAttributeValue, overLimit } from './sqs-error';
import { MessageAttribute, Receipt } from './sqs-messages';

/** What a customer's message keeps beside its body: its attributes as sent, its system attributes, and who sent it. */
export interface MessageMeta {
  messageAttributes?: Record<string, MessageAttribute>;
  systemAttributes?: Record<string, MessageAttribute>;
  senderId?: string;
}

/** A message to send: its ID, its body and what it keeps, its size, and how long it waits before it can be received. */
export interface Outgoing {
  messageId: string;
  body: string;
  meta: MessageMeta;
  sizeBytes: number;
  delaySeconds: number;
}

/** A message received: as it was sent, with its receive count, which its receipt handle names. */
export interface Received {
  id: string;
  messageId: string;
  body: string;
  meta: MessageMeta;
  sentAt: Date;
  receiveCount: number;
  firstReceivedAt: Date;
}

interface ReceivedRow {
  id: string;
  message_id: string;
  body: string;
  attributes: MessageMeta | null;
  sent_at: Date;
  receive_count: number;
  first_received_at: Date;
}

/** A page of the account's queues, by name, and where the next begins. */
export interface QueuePage {
  queues: Queue[];
  nextToken?: string;
}

/**
 * Customers' queues and their messages, as Amazon SQS keeps a standard
 * queue's (ADR 0010): made within the plan's limit, under the account's lock,
 * so that two at once can't both take the last place; each message kept for
 * the queue's retention, hidden for its delay, then for each receive's
 * visibility timeout; a message received more often than the queue's redrive
 * policy allows moved to its dead-letter queue as it would be received. A
 * receipt handle names one receive: an older one deletes nothing.
 */
@Injectable()
export class CustomerQueues {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Queue) private readonly queues: Repository<Queue>,
  ) {}

  /** The account's queue of that name. */
  find(accountId: string, name: string): Promise<Queue | null> {
    return this.queues.findOneBy({ accountId, name, kind: QueueKind.CUSTOMER });
  }

  /**
   * A queue made with these settings, the rest SQS's defaults; or the queue of
   * that name there is, when it has the same values for the attributes given,
   * as SQS's CreateQueue answers; else QueueNameExists, naming the first that
   * differs. Within the plan's queues, counted under the account's lock.
   */
  create(accountId: string, name: string, settings: Partial<QueueSettings>, plan: { limit: number; name: string }, region: string): Promise<Queue> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT 1 FROM "accounts" WHERE "id" = $1 FOR NO KEY UPDATE', [accountId]);
      const existing = await manager.findOneBy(Queue, { accountId, name, kind: QueueKind.CUSTOMER });
      if (existing) {
        const different = differentSetting(existing, settings);
        if (different) {
          throw new SqsError(400, 'QueueNameExists', `A queue already exists with the same name and a different value for attribute ${different}`, 'QueueAlreadyExists');
        }
        return existing;
      }
      if (settings.redrivePolicy) await this.checkDeadLetterQueue(manager, accountId, name, settings.redrivePolicy.deadLetterTargetArn, region);
      const count = await manager.countBy(Queue, { accountId, kind: QueueKind.CUSTOMER });
      if (count >= plan.limit) {
        throw overLimit(`The ${plan.name} plan allows ${plan.limit === 1 ? '1 queue' : `${plan.limit} queues`} per account: delete one first.`);
      }
      return manager.save(Queue, manager.create(Queue, { accountId, name, kind: QueueKind.CUSTOMER, functionId: null, ...DEFAULT_SETTINGS, ...settings }));
    });
  }

  /** A redrive policy's dead-letter queue: another queue of the account, there now, as SQS checks it. */
  private async checkDeadLetterQueue(manager: EntityManager, accountId: string, name: string, arn: string, region: string): Promise<void> {
    const target = parseQueueArn(arn);
    if (!target || target.region !== region || target.accountId !== accountId) throw invalidAttributeValue('Value for parameter RedrivePolicy is invalid. Reason: Dead letter target does not exist.');
    if (target.name === name) throw invalidAttributeValue("Value for parameter RedrivePolicy is invalid. Reason: A queue can't be its own dead-letter queue.");
    if (!(await manager.existsBy(Queue, { accountId, name: target.name, kind: QueueKind.CUSTOMER }))) {
      throw invalidAttributeValue('Value for parameter RedrivePolicy is invalid. Reason: Dead letter target does not exist.');
    }
  }

  /** The settings given, changed: what isn't given stays, as SQS's SetQueueAttributes. */
  async setAttributes(queue: Queue, settings: Partial<QueueSettings>, region: string): Promise<void> {
    if (Object.keys(settings).length === 0) return;
    if (settings.redrivePolicy) await this.checkDeadLetterQueue(this.dataSource.manager, queue.accountId, queue.name, settings.redrivePolicy.deadLetterTargetArn, region);
    await this.queues.update({ id: queue.id }, settings);
  }

  /** The account's queues by name, those whose name begins with `prefix`, `max` at most, after the page `nextToken` ends. */
  async list(accountId: string, prefix: string, max: number, nextToken?: string): Promise<QueuePage> {
    const after = nextToken ? Buffer.from(nextToken, 'base64url').toString('utf8') : '';
    const queues = await this.queues
      .createQueryBuilder('queue')
      .where('queue.accountId = :accountId AND queue.kind = :kind', { accountId, kind: QueueKind.CUSTOMER })
      .andWhere('starts_with(queue.name, :prefix) AND queue.name > :after', { prefix, after })
      .orderBy('queue.name', 'ASC')
      .limit(max + 1)
      .getMany();
    const page = queues.slice(0, max);
    return queues.length > max ? { queues: page, nextToken: Buffer.from(page[page.length - 1].name, 'utf8').toString('base64url') } : { queues: page };
  }

  /** Deletes the queue, its messages with it. */
  async delete(queue: Queue): Promise<void> {
    await this.queues.delete({ id: queue.id });
  }

  /** Deletes every message of the queue. */
  async purge(queue: Queue): Promise<void> {
    await this.dataSource.query('DELETE FROM "queue_messages" WHERE "queue_id" = $1', [queue.id]);
  }

  /** How many of its messages can be received now, are received and hidden, and wait for their delay, as SQS counts them, roughly. */
  async counts(queue: Queue, now: Date): Promise<QueueCounts> {
    const [row] = await this.dataSource.query<Array<{ visible: string; not_visible: string; delayed: string }>>(
      `SELECT count(*) FILTER (WHERE "visible_at" <= $2) AS "visible",
              count(*) FILTER (WHERE "visible_at" > $2 AND "receive_count" > 0) AS "not_visible",
              count(*) FILTER (WHERE "visible_at" > $2 AND "receive_count" = 0) AS "delayed"
         FROM "queue_messages" WHERE "queue_id" = $1 AND "expires_at" > $2`,
      [queue.id, now],
    );
    return { visible: Number(row.visible), notVisible: Number(row.not_visible), delayed: Number(row.delayed) };
  }

  /** Keeps the messages, in one statement: each visible after its delay, kept for the queue's retention from now. */
  async send(queue: Queue, messages: Outgoing[], now: Date): Promise<void> {
    if (messages.length === 0) return;
    const values: unknown[] = [];
    const rows = messages.map((message, n) => {
      const at = n * 6;
      values.push(message.messageId, message.body, message.meta, message.sizeBytes, new Date(now.getTime() + message.delaySeconds * 1000), new Date(now.getTime() + queue.messageRetentionSeconds * 1000));
      return `($${at + 2}::uuid, $${at + 3}, $${at + 4}::jsonb, $${at + 5}::integer, $${at + 6}::timestamptz, $${at + 7}::timestamptz)`;
    });
    await this.dataSource.query(
      `INSERT INTO "queue_messages" ("queue_id", "message_id", "body", "attributes", "size_bytes", "visible_at", "expires_at", "sent_at")
       SELECT $1::uuid, v.*, $${values.length + 2}::timestamptz FROM (VALUES ${rows.join(', ')}) AS v`,
      [queue.id, ...values, now],
    );
  }

  /**
   * Receives up to `max` messages that can be received now, the oldest first,
   * best effort, each hidden for `visibility` seconds and its receive counted.
   * A message received as often as the redrive policy allows goes to the
   * dead-letter queue first, kept there for its retention from when it was sent.
   */
  async receive(queue: Queue, max: number, visibility: number, now: Date): Promise<Received[]> {
    if (queue.redrivePolicy) await this.redrive(queue, now);
    const [rows] = await this.dataSource.query<[ReceivedRow[], number]>(
      `UPDATE "queue_messages" m
          SET "receive_count" = m."receive_count" + 1,
              "first_received_at" = coalesce(m."first_received_at", $2),
              "visible_at" = $2::timestamptz + make_interval(secs => $4)
        WHERE m."id" IN (SELECT "id" FROM "queue_messages"
                          WHERE "queue_id" = $1 AND "visible_at" <= $2 AND "expires_at" > $2
                          ORDER BY "id" LIMIT $3 FOR UPDATE SKIP LOCKED)
      RETURNING m."id", m."message_id", m."body", m."attributes", m."sent_at", m."receive_count", m."first_received_at"`,
      [queue.id, now, max, visibility],
    );
    return rows
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
      .map((row) => ({
        id: row.id,
        messageId: row.message_id,
        body: row.body,
        meta: row.attributes ?? {},
        sentAt: row.sent_at,
        receiveCount: row.receive_count,
        firstReceivedAt: row.first_received_at,
      }));
  }

  /** The messages received as often as the queue's redrive policy allows, moved to its dead-letter queue, if it is there still. */
  private async redrive(queue: Queue, now: Date): Promise<void> {
    const policy = queue.redrivePolicy as NonNullable<Queue['redrivePolicy']>;
    const target = parseQueueArn(policy.deadLetterTargetArn);
    const deadLetter = target && target.accountId === queue.accountId ? await this.find(queue.accountId, target.name) : null;
    if (!deadLetter || deadLetter.id === queue.id) return;
    await this.dataSource.query(
      `UPDATE "queue_messages" m
          SET "queue_id" = $3, "receive_count" = 0, "first_received_at" = NULL, "visible_at" = $2,
              "expires_at" = m."sent_at" + make_interval(secs => $5)
        WHERE m."id" IN (SELECT "id" FROM "queue_messages"
                          WHERE "queue_id" = $1 AND "visible_at" <= $2 AND "receive_count" >= $4
                          FOR UPDATE SKIP LOCKED)`,
      [queue.id, now, deadLetter.id, policy.maxReceiveCount, deadLetter.messageRetentionSeconds],
    );
  }

  /** Deletes the messages these receipts name, each only if its receipt is its last receive's: an older one deletes nothing, and isn't refused, as SQS's. */
  async deleteMessages(queue: Queue, receipts: Receipt[]): Promise<void> {
    for (const receipt of receipts) {
      await this.dataSource.query(`DELETE FROM "queue_messages" WHERE "id" = $1 AND "queue_id" = $2 AND "receive_count" = $3 AND "message_id" = $4`, [
        receipt.id,
        queue.id,
        receipt.receiveCount,
        receipt.messageId,
      ]);
    }
  }

  /** Hides a message received for `timeout` seconds from now; false when it is not received any more, or another receive has it. */
  async changeVisibility(queue: Queue, receipt: Receipt, timeout: number, now: Date): Promise<boolean> {
    const [, count] = await this.dataSource.query<[unknown[], number]>(
      `UPDATE "queue_messages" SET "visible_at" = $5::timestamptz + make_interval(secs => $6)
        WHERE "id" = $1 AND "queue_id" = $2 AND "receive_count" = $3 AND "message_id" = $4 AND "visible_at" > $5`,
      [receipt.id, queue.id, receipt.receiveCount, receipt.messageId, now, timeout],
    );
    return count === 1;
  }
}

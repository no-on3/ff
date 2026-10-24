import { Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { InsufficientCreditException } from '../billing/credit-policy';
import { CreditService } from '../billing/credit.service';
import { describeError } from '../common/describe-error';
import { InvocationSource } from '../functions/entities/function-invocation.entity';
import { Function, FunctionStatus } from '../functions/entities/function.entity';
import { FunctionsService } from '../functions/functions.service';
import { MAX_INPUT_BYTES } from '../functions/limits';
import { CustomerQueues, Received } from '../queues/customer-queues';
import { Queue } from '../queues/queue.entity';
import { QueueEvents } from '../queues/queue-events';
import { queueArn } from '../queues/sqs-attributes';
import { EventSourceMapping } from './event-source-mapping.entity';
import { EVENT_ENVELOPE_BYTES, SqsRecord, failedMessages, recordBytes, sqsRecord } from './sqs-event';

/** SQS's most messages one receive gives. */
const RECEIVE_MAX = 10;
/** How long a reader waits for a message before it receives again: PostgreSQL's NOTIFY ends the wait as one is written; one back from its visibility timeout, the next receive sees. */
const IDLE_WAIT_MS = 5_000;
/** The waits of one long poll, about 20 s as Lambda's poller waits on SQS: then the reader looks at its function and account again. */
const LONG_POLL_WAITS = 4;
/** How long a reader whose function or account can't take a call waits, receiving nothing, before it looks again. */
const NOT_READY_MS = 5_000;

/** A message received for a batch, with its record in SQS's event. */
interface Item {
  message: Received;
  record: SqsRecord;
}

/** A mapping being read: its settings and queue as last loaded, its batches in calls, and what waits for room. */
interface Reader {
  mapping: EventSourceMapping & { queue: Queue };
  abort: AbortController;
  inFlight: number;
  room?: () => void;
  /** Messages received that didn't fit in the last batch's event: they begin the next. */
  pending: Item[];
  /** Why it waits, said once until it reads again. */
  waiting?: string;
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

/**
 * Reads the queues functions are mapped to, as AWS Lambda's pollers read SQS
 * for an event source mapping (ADR 0010). Each enabled mapping has a reader
 * of its own, which long-polls its queue, woken by PostgreSQL as a message
 * is written; fills a batch of up to the mapping's batch size, waiting up to
 * its batching window for more, and never past an event of 6 MB; and calls
 * the function with SQS's event, as the API's invoke makes a call, its
 * history's source `sqs`. A call that succeeds deletes its batch, or, with
 * ReportBatchItemFailures, the messages its answer doesn't name; one that
 * fails deletes nothing, and its messages come back after the queue's
 * visibility timeout, counted towards its dead-letter queue as any receive.
 * Batches in calls at once: the mapping's maximum concurrency, within the
 * function's instances. A reader whose function isn't ACTIVE, or whose
 * account isn't active, has its storage off or no credit, receives nothing
 * until they can take a call. The mappings are loaded again every
 * FF_EVENT_SOURCE_REFRESH_SECONDS, and as soon as this backend changes one;
 * 0 reads none. Every backend reads every mapping: the batches of each can
 * be twice as many with two backends.
 */
@Injectable()
export class EventSourcePoller implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventSourcePoller.name);
  private readonly refreshSeconds: number;
  private readonly region: string;
  private readonly readers = new Map<string, Reader>();
  /** The calls under way, which a test may wait for. */
  private readonly running = new Set<Promise<void>>();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  /** The loads in turn: one at a time, a change made during one loaded after it. */
  private loading: Promise<void> = Promise.resolve();

  constructor(
    config: ConfigService,
    @InjectRepository(EventSourceMapping) private readonly mappings: Repository<EventSourceMapping>,
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
    private readonly queues: CustomerQueues,
    private readonly events: QueueEvents,
    private readonly functions: FunctionsService,
    private readonly credit: CreditService,
  ) {
    this.refreshSeconds = config.getOrThrow<{ refreshSeconds: number }>('eventSources').refreshSeconds;
    this.region = config.getOrThrow<{ region: string }>('sqs').region;
  }

  onModuleInit(): void {
    if (this.refreshSeconds <= 0) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshSeconds * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const reader of this.readers.values()) reader.abort.abort();
    this.readers.clear();
  }

  /** A mapping was made, changed or deleted here: the mappings loaded again at once, a disabled one's reader stopped once this resolves. */
  changed(): Promise<void> {
    return this.refreshSeconds > 0 ? this.refresh() : Promise.resolve();
  }

  /** Loads the enabled mappings: a reader started for each new one, stopped for each one disabled or gone, the others given their new settings. */
  refresh(): Promise<void> {
    this.loading = this.loading.then(
      () => this.load(),
      () => this.load(),
    );
    return this.loading.catch((error: unknown) => this.logger.error(`Could not load the event source mappings, tried again soon: ${describeError(error)}`));
  }

  /** Waits for the loads and the calls under way. */
  async settled(): Promise<void> {
    await this.loading.catch(() => undefined);
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  private async load(): Promise<void> {
    if (this.stopped) return;
    const rows = (await this.mappings.find({ where: { enabled: true }, relations: { queue: true } })) as Array<EventSourceMapping & { queue: Queue }>;
    if (this.stopped) return;
    const ids = new Set(rows.map((row) => row.id));
    for (const [id, reader] of this.readers) {
      if (ids.has(id)) continue;
      reader.abort.abort();
      this.readers.delete(id);
    }
    for (const row of rows) {
      const reader = this.readers.get(row.id);
      if (reader) reader.mapping = row;
      else this.start(row);
    }
  }

  private start(mapping: EventSourceMapping & { queue: Queue }): void {
    const reader: Reader = { mapping, abort: new AbortController(), inFlight: 0, pending: [] };
    this.readers.set(mapping.id, reader);
    void this.read(reader);
  }

  /** The reader's loop: while it may, a batch, and its call alongside the others, as many at once as the mapping allows. */
  private async read(reader: Reader): Promise<void> {
    const { signal } = reader.abort;
    while (!signal.aborted) {
      try {
        const fn = await this.ready(reader);
        if (!fn) {
          await pause(NOT_READY_MS, signal);
          continue;
        }
        if (reader.inFlight >= this.concurrencyOf(reader, fn)) {
          await new Promise<void>((resolve) => {
            const done = () => {
              signal.removeEventListener('abort', done);
              reader.room = undefined;
              resolve();
            };
            reader.room = done;
            signal.addEventListener('abort', done);
          });
          continue;
        }
        const batch = await this.gather(reader);
        if (batch.length === 0 || signal.aborted) continue;
        reader.inFlight += 1;
        const call = this.handle(reader, batch).finally(() => {
          reader.inFlight -= 1;
          reader.room?.();
          this.running.delete(call);
        });
        this.running.add(call);
      } catch (error) {
        this.logger.error(`Reading the queue ${reader.mapping.queue.name} for function ${reader.mapping.functionId} failed, tried again in 5 s: ${describeError(error)}`);
        await pause(NOT_READY_MS, signal);
      }
    }
  }

  /** The mapping's function when it and its account can take a call; else nothing, why said once. */
  private async ready(reader: Reader): Promise<Function | undefined> {
    const { mapping } = reader;
    const waits = (why: string): undefined => {
      if (reader.waiting !== why) this.logger.log(`The queue ${mapping.queue.name} waits for function ${mapping.functionId}: ${why}`);
      reader.waiting = why;
      return undefined;
    };
    const fn = await this.functions.findOne(mapping.accountId, mapping.functionId).catch((error: unknown) => {
      if (error instanceof NotFoundException) return undefined;
      throw error;
    });
    if (!fn) return waits('the function is gone');
    if (fn.status !== FunctionStatus.ACTIVE) return waits('the function is not ACTIVE');
    const account = await this.accounts.findOne({ where: { id: mapping.accountId }, select: { id: true, status: true, storageDisabledAt: true } });
    if (!account || account.status !== AccountStatus.ACTIVE) return waits('the account is not active');
    if (account.storageDisabledAt) return waits("FF turned the account's databases, buckets and queues off");
    try {
      await this.credit.admit(mapping.accountId);
    } catch (error) {
      if (error instanceof InsufficientCreditException) return waits("the account's credit has run out");
      throw error;
    }
    if (reader.waiting) this.logger.log(`The queue ${mapping.queue.name} is read again for function ${mapping.functionId}`);
    reader.waiting = undefined;
    return fn;
  }

  /** Batches in calls at once: the mapping's maximum concurrency, within the function's instances, each of which serves one call. */
  private concurrencyOf(reader: Reader, fn: Pick<Function, 'maxInstances'>): number {
    return Math.max(1, Math.min(reader.mapping.maximumConcurrency ?? fn.maxInstances, fn.maxInstances));
  }

  /**
   * A batch: one long poll for its first message, then, in the batching
   * window, receives until it is full; a message that would take the event
   * past 6 MB begins the next batch instead. Empty when the long poll ends
   * with none.
   */
  private async gather(reader: Reader): Promise<Item[]> {
    const { mapping } = reader;
    const { signal } = reader.abort;
    const { queue } = mapping;
    const arn = queueArn(this.region, queue.accountId, queue.name);
    const batch: Item[] = [];
    let bytes = EVENT_ENVELOPE_BYTES;
    let full = false;
    const take = (items: Item[]) => {
      for (const item of items) {
        const size = recordBytes(item.record);
        if (full || (batch.length > 0 && bytes + size > MAX_INPUT_BYTES)) {
          full = true;
          reader.pending.push(item);
        } else {
          batch.push(item);
          bytes += size;
        }
      }
    };
    const receive = async () => {
      const messages = await this.queues.receive(queue, Math.min(RECEIVE_MAX, mapping.batchSize - batch.length), queue.visibilityTimeout, new Date());
      take(messages.map((message) => ({ message, record: sqsRecord(message, arn, this.region) })));
      return messages.length;
    };
    take(reader.pending.splice(0));
    for (let waits = 0; batch.length === 0 && !signal.aborted; waits += 1) {
      if ((await receive()) > 0 || waits === LONG_POLL_WAITS) break;
      await this.events.wait(queue.id, IDLE_WAIT_MS, signal);
    }
    const windowEnds = Date.now() + mapping.maximumBatchingWindowInSeconds * 1000;
    while (batch.length > 0 && batch.length < mapping.batchSize && !full && !signal.aborted && Date.now() < windowEnds) {
      if ((await receive()) === 0) await this.events.wait(queue.id, Math.min(IDLE_WAIT_MS, windowEnds - Date.now()), signal);
    }
    return batch;
  }

  /** The batch's call, and the messages it handled deleted; a failure here leaves them to come back after their visibility timeout. */
  private async handle(reader: Reader, batch: Item[]): Promise<void> {
    const { mapping } = reader;
    const { queue } = mapping;
    const some = `${batch.length} ${batch.length === 1 ? 'message' : 'messages'} of the queue ${queue.name}`;
    try {
      const fn = await this.functions.findOne(mapping.accountId, mapping.functionId);
      if (fn.status !== FunctionStatus.ACTIVE) {
        this.logger.warn(`Function ${fn.name} is not ACTIVE any more: ${some} come back after the queue's visibility timeout`);
        return;
      }
      const outcome = await this.functions.call(fn, { Records: batch.map((item) => item.record) }, { source: InvocationSource.SQS });
      let handled: Item[] = batch;
      if (!outcome.ok) {
        handled = [];
        this.logger.warn(`The call of function ${fn.name} with ${some} failed, which come back after the queue's visibility timeout: ${outcome.visible}`);
      } else if (mapping.reportBatchItemFailures) {
        const failed = failedMessages(outcome.output, new Set(batch.map((item) => item.message.messageId)));
        if (failed === 'all') {
          handled = [];
          this.logger.warn(`Function ${fn.name} answered ${some} with no batch response Lambda takes: they all come back after the queue's visibility timeout`);
        } else {
          handled = batch.filter((item) => !failed.has(item.message.messageId));
        }
      }
      if (handled.length === 0) return;
      await this.queues.deleteMessages(
        queue,
        handled.map(({ message }) => ({ id: message.id, receiveCount: message.receiveCount, messageId: message.messageId })),
      );
    } catch (error) {
      this.logger.error(`The batch of ${some} for function ${mapping.functionId} failed; its messages come back after the queue's visibility timeout: ${describeError(error)}`);
    }
  }
}

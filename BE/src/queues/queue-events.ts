import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { describeError } from '../common/describe-error';

/** The channel queue_messages' trigger NOTIFYs, with the queue's ID, as each message written or moved there commits. */
export const QUEUE_CHANNEL = 'ff_queue';
const RETRY_MS = 5_000;

interface Notification {
  channel: string;
  payload?: string;
}

/** The part of the pg client that LISTEN needs. */
interface ListeningClient {
  on(event: 'notification', listener: (message: Notification) => void): unknown;
  removeListener(event: 'notification', listener: (message: Notification) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  query(sql: string): Promise<unknown>;
}

/**
 * Every message written to a queue, or moved to it, as PostgreSQL tells it:
 * the trigger NOTIFYs ff_queue with the queue's ID when the write commits,
 * whoever wrote, this backend or another. A long poll waits for its queue's
 * news rather than asking the database again and again. A lost connection is
 * opened again; what was missed meanwhile, the waits' own deadlines cover.
 */
@Injectable()
export class QueueEvents implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueEvents.name);
  private readonly subscribers = new Set<(queueId: string) => void>();
  private listening?: { runner: QueryRunner; client: ListeningClient; onNotification: (message: Notification) => void };
  private retry?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly dataSource: DataSource) {}

  /** Calls `subscriber` with each queue a message comes to; answers how to stop. */
  subscribe(subscriber: (queueId: string) => void): () => void {
    this.subscribers.add(subscriber);
    return () => void this.subscribers.delete(subscriber);
  }

  /** Waits until a message comes to the queue, or `ms` pass, or `signal` aborts. */
  wait(queueId: string, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        stop();
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      const stop = this.subscribe((id) => id === queueId && done());
      signal?.addEventListener('abort', done);
    });
  }

  onModuleInit(): Promise<void> {
    return this.listen();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retry);
    const listening = this.listening;
    this.listening = undefined;
    if (!listening) return;
    // The connection goes back to the pool: it must not listen, or tell this listener, any more.
    await listening.client.query(`UNLISTEN ${QUEUE_CHANNEL}`).catch(() => undefined);
    listening.client.removeListener('notification', listening.onNotification);
    await listening.runner.release().catch(() => undefined);
  }

  private async listen(): Promise<void> {
    if (this.stopped) return;
    const runner = this.dataSource.createQueryRunner();
    try {
      const client = (await runner.connect()) as ListeningClient;
      const onNotification = (message: Notification) => {
        if (message.channel !== QUEUE_CHANNEL || !message.payload) return;
        for (const subscriber of [...this.subscribers]) subscriber(message.payload);
      };
      client.on('notification', onNotification);
      client.on('error', (error) => this.lost(runner, error));
      await client.query(`LISTEN ${QUEUE_CHANNEL}`);
      this.listening = { runner, client, onNotification };
    } catch (error) {
      this.lost(runner, error);
    }
  }

  /** TypeORM gives a broken connection back to the pool to be closed; this opens another. */
  private lost(runner: QueryRunner, error: unknown): void {
    if (this.listening?.runner === runner) this.listening = undefined;
    void runner.release().catch(() => undefined);
    if (this.stopped) return;
    this.logger.error(`Not listening to the queues: ${describeError(error)}. Again in ${RETRY_MS / 1000} s`);
    this.retry = setTimeout(() => void this.listen(), RETRY_MS);
  }
}

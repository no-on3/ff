import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { describeError } from '../../common/describe-error';

/** The channel the ledger's trigger NOTIFYs, with the account's ID, as each wallet write commits (P-33). */
export const LEDGER_CHANNEL = 'ff_ledger';
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
 * Every wallet write, as PostgreSQL tells it (P-33): the ledger's trigger
 * NOTIFYs ff_ledger with the account's ID when the write commits, and never
 * when it rolls back, whoever wrote: a service, another backend, SQL by hand.
 * Each subscriber hears every one. A lost connection is opened again; what
 * was missed meanwhile, the cached balances' minute covers.
 */
@Injectable()
export class LedgerEvents implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LedgerEvents.name);
  private readonly subscribers = new Set<(accountId: string) => void>();
  private listening?: { runner: QueryRunner; client: ListeningClient; onNotification: (message: Notification) => void };
  private retry?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly dataSource: DataSource) {}

  /** Calls `subscriber` with each account whose wallet changed; answers how to stop. */
  subscribe(subscriber: (accountId: string) => void): () => void {
    this.subscribers.add(subscriber);
    return () => void this.subscribers.delete(subscriber);
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
    await listening.client.query(`UNLISTEN ${LEDGER_CHANNEL}`).catch(() => undefined);
    listening.client.removeListener('notification', listening.onNotification);
    await listening.runner.release().catch(() => undefined);
  }

  private async listen(): Promise<void> {
    if (this.stopped) return;
    const runner = this.dataSource.createQueryRunner();
    try {
      const client = (await runner.connect()) as ListeningClient;
      const onNotification = (message: Notification) => {
        if (message.channel !== LEDGER_CHANNEL || !message.payload) return;
        for (const subscriber of this.subscribers) subscriber(message.payload);
      };
      client.on('notification', onNotification);
      client.on('error', (error) => this.lost(runner, error));
      await client.query(`LISTEN ${LEDGER_CHANNEL}`);
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
    this.logger.error(`Not listening to the ledger: ${describeError(error)}. Again in ${RETRY_MS / 1000} s`);
    this.retry = setTimeout(() => void this.listen(), RETRY_MS);
  }
}

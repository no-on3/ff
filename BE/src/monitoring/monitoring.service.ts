import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { DataSource } from 'typeorm';
import { PricingService } from '../billing/pricing.service';
import { HOUR_MS } from '../billing/rating-hours';
import { reconcile, reconciled } from '../billing/reconciliation';
import { describeError } from '../common/describe-error';
import { alarmLagSeconds, deliveriesPending, ratingLagSeconds, reconciliationMismatches, registry } from './operator-metrics';

/** Seconds from `then` to `now`: 0 when there is no `then`, or it is still to come. */
const secondsSince = (then: Date | null, now: Date): number => (then ? Math.max(0, (now.getTime() - new Date(then).getTime()) / 1000) : 0);

/**
 * Serves the operator's metrics on their own port (FF_METRICS_PORT, never
 * the API's), and reads, at each scrape, what only the database knows: the
 * rating's lag, the alarm evaluator's, the deliveries pending; and the month's
 * reconciliation, computed in the background at most once an hour.
 */
@Injectable()
export class MonitoringService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MonitoringService.name);
  private server?: Server;
  private reconciledAt = 0;
  private reconciling?: Promise<void>;

  constructor(
    private readonly dataSource: DataSource,
    private readonly pricing: PricingService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const { metricsPort, metricsHost } = this.config.getOrThrow<{ metricsPort: number; metricsHost: string }>('monitoring');
    if (!metricsPort) return;
    const server = createServer((request, response) => void this.serve(request, response));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(metricsPort, metricsHost, () => resolve());
      });
    } catch (error) {
      // The API serves all the same: Prometheus sees the target down, which its own alert reports.
      this.logger.error(`The operator's metrics are not served: ${metricsHost}:${metricsPort} cannot be listened on: ${describeError(error)}`);
      return;
    }
    this.server = server;
    const { address, port } = server.address() as AddressInfo;
    this.logger.log(`The operator's metrics are on http://${address}:${port}/metrics`);
  }

  async onModuleDestroy(): Promise<void> {
    await new Promise((resolve) => (this.server ? this.server.close(resolve) : resolve(undefined)));
    await this.reconciling;
  }

  /** GET /metrics: the gauges read now, then every metric in Prometheus's text format. Anything else is 404. */
  async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'GET' || request.url?.split('?')[0] !== '/metrics') {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found: the metrics are at /metrics\n');
      return;
    }
    try {
      await this.refresh();
      response.writeHead(200, { 'content-type': registry.contentType }).end(await registry.metrics());
    } catch (error) {
      this.logger.error(`Could not read the operator's metrics: ${describeError(error)}`);
      response.writeHead(500, { 'content-type': 'text/plain' }).end(`${describeError(error)}\n`);
    }
  }

  /** The gauges only the database knows, as they are now; and the month's reconciliation, if its hour has passed. */
  async refresh(now = new Date()): Promise<void> {
    // The rating is due from the end of the last hour rated; before the first, from the first price book's start, as it rates.
    const [row] = await this.dataSource.query<Array<{ rated: Date | null; judged: Date | null; pending: number }>>(
      `SELECT coalesce((SELECT max("hour") + interval '1 hour' FROM "rating_runs"), (SELECT min("valid_from") FROM "price_books")) AS "rated",
              (SELECT min(coalesce("evaluated_at", "created_at")) FROM "alarms") AS "judged",
              (SELECT count(*) FROM "notification_deliveries" WHERE "status" = 'pending')::int AS "pending"`,
    );
    ratingLagSeconds.set(secondsSince(row.rated, now));
    alarmLagSeconds.set(secondsSince(row.judged, now));
    deliveriesPending.set(row.pending);
    if (!this.reconciling && now.getTime() - this.reconciledAt >= HOUR_MS) {
      this.reconciledAt = now.getTime();
      this.reconciling = this.reconcileMonth(now).then(() => undefined).finally(() => (this.reconciling = undefined));
    }
  }

  /** How many accounts' month to date doesn't reconcile: their charges against their usage. */
  async reconcileMonth(now = new Date()): Promise<number> {
    try {
      const { accounts } = await reconcile(this.dataSource, this.pricing, now.toISOString().slice(0, 7));
      const mismatches = accounts.filter((account) => !reconciled(account)).length;
      reconciliationMismatches.set(mismatches);
      return mismatches;
    } catch (error) {
      this.logger.error(`Could not reconcile the month for the operator's metrics: ${describeError(error)}`);
      return -1;
    }
  }
}

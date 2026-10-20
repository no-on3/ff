/**
 * L1: the operator's metrics endpoint, on its own port, against a database
 * stand-in: the SQL itself is tested in monitoring.db.spec.ts (L2). FF's
 * operator scrapes it with Prometheus; customers never reach it, since it is
 * not the API's port, and in development it listens on this machine only.
 */
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServer } from 'node:net';
import { DataSource } from 'typeorm';
import { PricingService } from '../billing/pricing.service';
import { MonitoringService } from './monitoring.service';
import { alarmLagSeconds, databaseDiskBytes, databaseSizeBytes, deliveriesPending, invocations, ratingLagSeconds } from './operator-metrics';
import { valueOf } from './test-fixtures';

const HOUR = 3_600_000;

/** A port free on this machine now. */
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

describe("the operator's metrics", () => {
  /** What the gauges' query answers: the end of the last hour rated, the alarm judged longest ago, the deliveries pending. */
  let gauges: { rated: Date | null; judged: Date | null; pending: number; size: string } | Error;
  let query: jest.Mock;
  let service: MonitoringService;
  let logged: { log: jest.SpyInstance; error: jest.SpyInstance };
  const make = (metricsPort: number, metricsHost = '127.0.0.1', databaseDiskBytes?: number) => {
    const config = { getOrThrow: () => ({ metricsPort, metricsHost, databaseDiskBytes }) } as unknown as ConfigService;
    return new MonitoringService({ query } as unknown as DataSource, {} as PricingService, config);
  };

  beforeEach(() => {
    gauges = { rated: new Date('2026-10-20T11:00:00Z'), judged: new Date('2026-10-20T11:29:30Z'), pending: 3, size: '52428800' };
    query = jest.fn(async () => {
      if (gauges instanceof Error) throw gauges;
      return [gauges];
    });
    logged = { log: jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined), error: jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined) };
  });

  afterEach(async () => {
    await service?.onModuleDestroy();
    jest.restoreAllMocks();
  });

  describe('on their own port', () => {
    let url: string;

    beforeEach(async () => {
      const port = await freePort();
      service = make(port);
      jest.spyOn(service, 'reconcileMonth').mockResolvedValue(0);
      await service.onModuleInit();
      url = `http://127.0.0.1:${port}`;
    });

    it("serves every metric in Prometheus's text format, FF's and the process's, the gauges read from the database then", async () => {
      invocations.inc({ outcome: 'success' });
      const res = await fetch(`${url}/metrics`);
      const text = await res.text();

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
      expect(text).toContain('# TYPE ff_invocations_total counter');
      expect(text).toMatch(/^ff_invocations_total\{outcome="success"\} \d+$/m);
      expect(text).toMatch(/^ff_notification_deliveries_pending 3$/m);
      expect(text).toMatch(/^ff_backend_process_cpu_user_seconds_total /m);
      expect(text).toMatch(/^ff_backend_nodejs_eventloop_lag_seconds /m);
      expect(query).toHaveBeenCalledTimes(1);
      expect(logged.log).toHaveBeenCalledWith(`The operator's metrics are on ${url}/metrics`);
    });

    it('answers nothing else: another path, or another method', async () => {
      const elsewhere = await fetch(`${url}/`);
      const posted = await fetch(`${url}/metrics`, { method: 'POST' });

      expect([elsewhere.status, await elsewhere.text()]).toEqual([404, 'Not found: the metrics are at /metrics\n']);
      expect(posted.status).toBe(404);
      expect(query).not.toHaveBeenCalled();
    });

    it('answers 500 when the database fails, saying why, so that the scrape fails rather than show stale values', async () => {
      gauges = new Error('Connection terminated unexpectedly');
      const res = await fetch(`${url}/metrics`);

      expect([res.status, await res.text()]).toEqual([500, 'Connection terminated unexpectedly\n']);
      expect(logged.error).toHaveBeenCalledWith("Could not read the operator's metrics: Connection terminated unexpectedly");
    });

    it('stops listening when the backend stops', async () => {
      await service.onModuleDestroy();

      await expect(fetch(`${url}/metrics`)).rejects.toThrow('fetch failed');
    });
  });

  it('listens on no port when FF_METRICS_PORT is 0', async () => {
    service = make(0);
    await service.onModuleInit();

    expect(logged.log).not.toHaveBeenCalled();
    expect(logged.error).not.toHaveBeenCalled();
  });

  it('serves the API all the same when its port is taken, and says so', async () => {
    const port = await freePort();
    const holder = createServer().listen(port, '127.0.0.1');
    await new Promise((resolve) => holder.once('listening', resolve));
    try {
      service = make(port);
      await expect(service.onModuleInit()).resolves.toBeUndefined();

      expect(logged.error).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^The operator's metrics are not served: 127\\.0\\.0\\.1:${port} cannot be listened on: .*EADDRINUSE`)));
    } finally {
      holder.close();
    }
  });

  describe('the gauges, read at each scrape', () => {
    beforeEach(() => {
      service = make(0);
    });

    it("are the rating's lag behind the end of the last hour rated, the alarm judged longest ago, and the deliveries pending", async () => {
      jest.spyOn(service, 'reconcileMonth').mockResolvedValue(0);
      await service.refresh(new Date('2026-10-20T11:30:00Z'));

      expect([await valueOf(ratingLagSeconds), await valueOf(alarmLagSeconds), await valueOf(deliveriesPending)]).toEqual([1800, 30, 3]);
      expect(await valueOf(databaseSizeBytes)).toBe(50 * 1024 ** 2);
    });

    it("report the database server's disk as the deployment says, and 0 when it doesn't, which the alert reads as unknown", async () => {
      service = make(0, '127.0.0.1', 100 * 1024 ** 3);
      await service.onModuleInit();
      expect(await valueOf(databaseDiskBytes)).toBe(100 * 1024 ** 3);

      service = make(0);
      await service.onModuleInit();
      expect(await valueOf(databaseDiskBytes)).toBe(0);
    });

    it('say no lag at all when nothing is due: no book yet, no alarm, or a time still to come', async () => {
      jest.spyOn(service, 'reconcileMonth').mockResolvedValue(0);
      gauges = { rated: null, judged: null, pending: 0, size: '0' };
      await service.refresh(new Date('2026-10-20T11:30:00Z'));
      expect([await valueOf(ratingLagSeconds), await valueOf(alarmLagSeconds), await valueOf(deliveriesPending)]).toEqual([0, 0, 0]);

      gauges = { rated: new Date('2026-10-20T12:00:00Z'), judged: new Date('2026-10-20T11:30:01Z'), pending: 0, size: '0' };
      await service.refresh(new Date('2026-10-20T11:30:00Z'));
      expect([await valueOf(ratingLagSeconds), await valueOf(alarmLagSeconds)]).toEqual([0, 0]);
    });

    it("reconcile the month at most once an hour, in the background, never twice at once", async () => {
      let finish = (_mismatches: number) => undefined as void;
      const reconcile = jest.spyOn(service, 'reconcileMonth').mockImplementation(() => new Promise((resolve) => (finish = resolve)));
      const start = new Date('2026-10-20T11:30:00Z');

      await service.refresh(start); // the scrape doesn't wait for it
      await service.refresh(new Date(start.getTime() + 2 * HOUR)); // an hour later, still running: not again
      expect(reconcile).toHaveBeenCalledTimes(1);
      finish(0);
      await new Promise((resolve) => setImmediate(resolve));

      await service.refresh(new Date(start.getTime() + HOUR - 1)); // done, but its hour isn't over
      expect(reconcile).toHaveBeenCalledTimes(1);
      await service.refresh(new Date(start.getTime() + HOUR));
      expect(reconcile).toHaveBeenCalledTimes(2);
      expect(reconcile).toHaveBeenLastCalledWith(new Date(start.getTime() + HOUR));
      finish(0);
    });
  });
});

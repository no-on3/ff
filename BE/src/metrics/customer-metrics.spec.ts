import { DataSource } from 'typeorm';
import { Logger } from '@nestjs/common';
import { MAX_POINTS, MetricsWindow, bucketMetricsView, databaseMetricsView, metricsView, metricsWindow, queueMetricsView, siteMetricsView } from './customer-metrics';
import { MAX_HELD, RefusedInvocationsService } from './refused-invocations.service';

const NOW = new Date('2026-10-19T10:07:30Z');
const FN = '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f';

describe('metricsWindow', () => {
  it('ends now and starts 60 periods before by default, in whole minutes of UTC time', () => {
    expect(metricsWindow({}, NOW)).toEqual({ start: new Date('2026-10-19T09:07:00Z'), end: new Date('2026-10-19T10:08:00Z'), period: 60 });
  });

  it('rounds the start down and the end up to whole periods of five minutes or an hour', () => {
    expect(metricsWindow({ start: '2026-10-19T09:02:00Z', end: '2026-10-19T09:58:00Z', period: 300 }, NOW)).toEqual({
      start: new Date('2026-10-19T09:00:00Z'),
      end: new Date('2026-10-19T10:00:00Z'),
      period: 300,
    });
    expect(metricsWindow({ start: '2026-10-19T10:00:00+01:00', end: '2026-10-19T09:30:00Z', period: 3600 }, NOW)).toEqual({
      start: new Date('2026-10-19T09:00:00Z'),
      end: new Date('2026-10-19T10:00:00Z'),
      period: 3600,
    });
  });

  it('refuses a start not before the end, and more points than an answer gives', () => {
    expect(metricsWindow({ start: '2026-10-19T10:00:00Z', end: '2026-10-19T10:00:00Z' }, NOW)).toEqual({ problem: 'start must be before end' });
    expect(metricsWindow({ start: '2026-10-18T09:00:00Z', end: '2026-10-19T09:00:00Z' }, NOW)).toEqual({ start: new Date('2026-10-18T09:00:00Z'), end: new Date('2026-10-19T09:00:00Z'), period: 60 });
    expect(metricsWindow({ start: '2026-10-18T09:00:00Z', end: '2026-10-19T09:01:00Z' }, NOW)).toEqual({
      problem: `The window holds ${MAX_POINTS + 1} periods of 60 s: at most ${MAX_POINTS}. Take a longer period, or a shorter window`,
    });
  });
});

describe('databaseMetricsView', () => {
  it("gives a point an hour, oldest first, null for an hour without a sample, the mean to the millisession and the byte", () => {
    const window: MetricsWindow = { start: new Date('2026-10-19T08:00:00Z'), end: new Date('2026-10-19T11:00:00Z'), period: 3600 };
    const at = (iso: string) => new Date(iso).getTime() / 1000;

    const view = databaseMetricsView(window, [
      { bucket: at('2026-10-19T08:00:00Z'), connectionsMaximum: 3, connectionsAverage: 3, bytesMaximum: 7_634_423, bytesAverage: 7_634_423 },
      { bucket: at('2026-10-19T10:00:00Z'), connectionsMaximum: 4, connectionsAverage: 2.33333, bytesMaximum: 9_000_001, bytesAverage: 8_500_000.6 },
    ]);

    expect(view).toEqual({
      period: 3600,
      start: window.start,
      end: window.end,
      timestamps: [new Date('2026-10-19T08:00:00Z'), new Date('2026-10-19T09:00:00Z'), new Date('2026-10-19T10:00:00Z')],
      metrics: {
        DatabaseConnections: { Maximum: [3, null, 4], Average: [3, null, 2.333] },
        VolumeBytesUsed: { Maximum: [7_634_423, null, 9_000_001], Average: [7_634_423, null, 8_500_001] },
      },
    });
  });
});

describe('bucketMetricsView', () => {
  it("gives a point per period, oldest first: what the bucket holds, its hour's measure in each period, null in an hour unmeasured; its requests, zeros when quiet", () => {
    const window: MetricsWindow = { start: new Date('2026-10-19T08:50:00Z'), end: new Date('2026-10-19T09:10:00Z'), period: 300 };
    const at = (iso: string) => new Date(iso).getTime() / 1000;
    const quiet = { AllRequests: 0, GetRequests: 0, PutRequests: 0, '4xxErrors': 0, '5xxErrors': 0, BytesDownloaded: 0, BytesUploaded: 0 };

    const view = bucketMetricsView(
      window,
      [{ hour: at('2026-10-19T09:00:00Z'), sizeBytes: 161_480_253, objects: 1_204 }],
      [{ bucket: at('2026-10-19T09:05:00Z'), ...quiet, AllRequests: 12, GetRequests: 9, PutRequests: 3, '4xxErrors': 2, '5xxErrors': 1, BytesDownloaded: 9_000, BytesUploaded: 3_000 }],
    );

    expect(view).toEqual({
      period: 300,
      start: window.start,
      end: window.end,
      timestamps: ['08:50', '08:55', '09:00', '09:05'].map((time) => new Date(`2026-10-19T${time}:00Z`)),
      metrics: {
        BucketSizeBytes: { Average: [null, null, 161_480_253, 161_480_253] },
        NumberOfObjects: { Average: [null, null, 1_204, 1_204] },
        AllRequests: { Sum: [0, 0, 0, 12] },
        GetRequests: { Sum: [0, 0, 0, 9] },
        PutRequests: { Sum: [0, 0, 0, 3] },
        '4xxErrors': { Sum: [0, 0, 0, 2] },
        '5xxErrors': { Sum: [0, 0, 0, 1] },
        BytesDownloaded: { Sum: [0, 0, 0, 9_000] },
        BytesUploaded: { Sum: [0, 0, 0, 3_000] },
      },
    });
  });
});

describe('siteMetricsView', () => {
  it("gives a point per period, oldest first: the site's visits and their bytes, zeros when quiet; the shares that failed, in percent, null without a visit", () => {
    const window: MetricsWindow = { start: new Date('2026-10-30T09:00:00Z'), end: new Date('2026-10-30T09:15:00Z'), period: 300 };
    const at = (iso: string) => new Date(iso).getTime() / 1000;

    const view = siteMetricsView(window, [
      { bucket: at('2026-10-30T09:00:00Z'), requests: 3, bytesOut: 12_000, errors4xx: 1, errors5xx: 0 },
      { bucket: at('2026-10-30T09:10:00Z'), requests: 8, bytesOut: 40_000, errors4xx: 2, errors5xx: 2 },
    ]);

    expect(view).toEqual({
      period: 300,
      start: window.start,
      end: window.end,
      timestamps: ['09:00', '09:05', '09:10'].map((time) => new Date(`2026-10-30T${time}:00Z`)),
      metrics: {
        Requests: { Sum: [3, 0, 8] },
        BytesDownloaded: { Sum: [12_000, 0, 40_000] },
        // As CloudFront's: a third of the visits, to the thousandth of a percent.
        '4xxErrorRate': { Average: [33.333, null, 25] },
        '5xxErrorRate': { Average: [0, null, 25] },
        TotalErrorRate: { Average: [33.333, null, 50] },
      },
    });
  });
});

describe('metricsView', () => {
  const window: MetricsWindow = { start: new Date('2026-10-19T09:00:00Z'), end: new Date('2026-10-19T09:15:00Z'), period: 300 };
  const at = (iso: string) => new Date(iso).getTime() / 1000;

  it('gives a point per period, oldest first: quiet periods at zero, no duration where none was measured, and the instances', () => {
    const view = metricsView(
      window,
      [
        {
          bucket: at('2026-10-19T09:05:00Z'),
          invocations: 4,
          errors: 1,
          throttles: 2,
          coldStarts: 1,
          durationAverage: 12.34567,
          durationMaximum: 30,
          durationP50: 10,
          durationP95: 28.5,
          durationP99: 29.7,
        },
      ],
      [{ bucket: at('2026-10-19T09:05:00Z'), maximum: 3, minuteSum: 7 }],
    );

    expect(view.timestamps).toEqual([new Date('2026-10-19T09:00:00Z'), new Date('2026-10-19T09:05:00Z'), new Date('2026-10-19T09:10:00Z')]);
    expect(view.metrics).toEqual({
      Invocations: [0, 4, 0],
      Errors: [0, 1, 0],
      Throttles: [0, 2, 0],
      ColdStarts: [0, 1, 0],
      Duration: { Average: [null, 12.346, null], Maximum: [null, 30, null], p50: [null, 10, null], p95: [null, 28.5, null], p99: [null, 29.7, null] },
      // The mean over the period's five minutes: 7 instance-minutes, 1.4 instances.
      Instances: { Maximum: [0, 3, 0], Average: [0, 1.4, 0] },
      // No call without waiting: zeros, and no age.
      AsyncEventsReceived: [0, 0, 0],
      AsyncEventAge: { Average: [null, null, null], Maximum: [null, null, null] },
      AsyncEventsDropped: [0, 0, 0],
      DestinationDeliveryFailures: [0, 0, 0],
    });
    expect([view.period, view.start, view.end]).toEqual([300, window.start, window.end]);
  });

  it("gives Lambda's metrics of asynchronous calls: events received, dropped and records not delivered by the period, and the age of each attempt, none without one", () => {
    const view = metricsView(window, [], [], [
      { bucket: at('2026-10-19T09:00:00Z'), received: 5, dropped: 0, destinationFailures: 0, attempts: 0, ageMsSum: 0, ageMsMax: 0 },
      { bucket: at('2026-10-19T09:10:00Z'), received: 1, dropped: 2, destinationFailures: 1, attempts: 3, ageMsSum: 1000, ageMsMax: 700 },
    ]);

    expect([view.metrics.AsyncEventsReceived, view.metrics.AsyncEventAge, view.metrics.AsyncEventsDropped, view.metrics.DestinationDeliveryFailures]).toEqual([
      [5, 0, 1],
      { Average: [null, null, 333.333], Maximum: [null, null, 700] },
      [0, 0, 2],
      [0, 0, 1],
    ]);
  });
});

describe('queueMetricsView', () => {
  const window: MetricsWindow = { start: new Date('2026-10-24T09:00:00Z'), end: new Date('2026-10-24T09:15:00Z'), period: 300 };
  const at = (iso: string) => new Date(iso).getTime() / 1000;
  const gauge = (maximum: number, minuteSum: number) => ({ maximum, minuteSum });

  it("gives SQS's metrics a point per period: its messages' most and mean over the minutes, an empty minute 0, their age, its requests' counts, and the size of what was sent", () => {
    const view = queueMetricsView(
      window,
      [
        {
          bucket: at('2026-10-24T09:05:00Z'),
          ApproximateNumberOfMessagesVisible: gauge(9, 12),
          ApproximateNumberOfMessagesNotVisible: gauge(2, 3),
          ApproximateNumberOfMessagesDelayed: gauge(1, 1),
          oldestAgeSeconds: 240,
        },
      ],
      [
        { bucket: at('2026-10-24T09:00:00Z'), NumberOfMessagesSent: 4, NumberOfMessagesReceived: 3, NumberOfMessagesDeleted: 3, NumberOfEmptyReceives: 7, sentBytes: 1000, sentMaxBytes: 700 },
        { bucket: at('2026-10-24T09:10:00Z'), NumberOfMessagesSent: 0, NumberOfMessagesReceived: 0, NumberOfMessagesDeleted: 2, NumberOfEmptyReceives: 0, sentBytes: 0, sentMaxBytes: 0 },
      ],
    );

    expect(view.timestamps).toEqual([new Date('2026-10-24T09:00:00Z'), new Date('2026-10-24T09:05:00Z'), new Date('2026-10-24T09:10:00Z')]);
    expect(view.metrics).toEqual({
      // 12 message-minutes over the period's five minutes: 2.4 on average.
      ApproximateNumberOfMessagesVisible: { Maximum: [0, 9, 0], Average: [0, 2.4, 0] },
      ApproximateNumberOfMessagesNotVisible: { Maximum: [0, 2, 0], Average: [0, 0.6, 0] },
      ApproximateNumberOfMessagesDelayed: { Maximum: [0, 1, 0], Average: [0, 0.2, 0] },
      ApproximateAgeOfOldestMessage: { Maximum: [0, 240, 0] },
      NumberOfMessagesSent: { Sum: [4, 0, 0] },
      NumberOfMessagesReceived: { Sum: [3, 0, 0] },
      NumberOfMessagesDeleted: { Sum: [3, 0, 2] },
      NumberOfEmptyReceives: { Sum: [7, 0, 0] },
      SentMessageSize: { Average: [250, null, null], Maximum: [700, null, null] },
    });
  });
});

describe('RefusedInvocationsService', () => {
  let query: jest.Mock;
  let service: RefusedInvocationsService;

  beforeEach(() => {
    query = jest.fn(async () => []);
    service = new RefusedInvocationsService({ query } as unknown as DataSource);
  });

  it("counts each function's refused calls per minute, and writes them at once, for the account's own functions only", async () => {
    service.count('000000000001', FN, new Date('2026-10-19T10:07:01Z'));
    service.count('000000000001', FN.toUpperCase(), new Date('2026-10-19T10:07:59Z'));
    service.count('000000000001', FN, new Date('2026-10-19T10:08:00Z'));

    await service.flush();

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, [ids, minutes, accounts, counts]] = query.mock.calls[0] as [string, [string[], Date[], string[], number[]]];
    expect(sql).toContain('JOIN "functions" f ON f."id" = v."function_id" AND f."account_id" = v."account_id"');
    expect(sql).toContain('DO UPDATE SET "count" = "rate_limited_invocations"."count" + EXCLUDED."count"');
    expect([ids, minutes, accounts, counts]).toEqual([
      [FN, FN],
      [new Date('2026-10-19T10:07:00Z'), new Date('2026-10-19T10:08:00Z')],
      ['000000000001', '000000000001'],
      [2, 1],
    ]);

    await service.flush(); // nothing left
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("keeps another account's refusals for the same function apart, so that the write can drop them", async () => {
    const at = new Date('2026-10-19T10:07:01Z');
    service.count('000000000001', FN, at);
    service.count('000000000002', FN, at);

    await service.flush();

    const [, [ids, , accounts, counts]] = query.mock.calls[0] as [string, [string[], Date[], string[], number[]]];
    expect([ids, accounts, counts]).toEqual([[FN, FN], ['000000000001', '000000000002'], [1, 1]]);
  });

  it("ignores a path that names no function, and holds no more than it may: a flood of made-up IDs can't fill the memory", async () => {
    service.count('000000000001', 'not-a-function');
    service.count('000000000001', undefined);
    for (let i = 0; i < MAX_HELD + 5; i++) service.count('000000000001', `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

    await service.flush();

    expect((query.mock.calls[0][1] as unknown[][])[0]).toHaveLength(MAX_HELD);
  });

  it("logs counts it couldn't write, and goes on", async () => {
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    query.mockRejectedValueOnce(new Error('connection terminated'));
    service.count('000000000001', FN);

    await expect(service.flush()).resolves.toBeUndefined();

    expect(errors).toHaveBeenCalledWith('Could not write 1 count(s) of rate-limited invocations: connection terminated');
    errors.mockRestore();
  });

  it('writes what it holds when the backend stops', async () => {
    service.onModuleInit();
    service.count('000000000001', FN);

    await service.onModuleDestroy();

    expect(query).toHaveBeenCalledTimes(1);
  });
});

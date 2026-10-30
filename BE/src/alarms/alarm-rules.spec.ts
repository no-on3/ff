/**
 * L1: an alarm's rules, as CloudWatch's: what a definition may be, which
 * periods are judged, "M out of N" with each treatment of missing data, the
 * reason, which changes are told, and the e-mail in both languages. The
 * evaluator runs against PostgreSQL in alarms.db.spec.ts.
 */
import { alarmMail } from './alarm-mail';
import {
  AlarmRule,
  alarmProblem,
  bucketDatapointsOf,
  cacheDatapointsOf,
  databaseDatapointsOf,
  datapointsOf,
  evaluate,
  evaluationWindow,
  notifies,
  queueDatapointsOf,
  siteDatapointsOf,
  stateReason,
} from './alarm-rules';
import { bucketMetricsView, cacheMetricsView, databaseMetricsView, queueMetricsView, siteMetricsView, type MetricsView } from '../metrics/customer-metrics';

const RULE: AlarmRule = {
  functionId: '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f',
  databaseId: null,
  bucketId: null,
  queueId: null,
  cacheId: null,
  metric: 'Errors',
  statistic: 'Sum',
  period: 60,
  comparison: 'GreaterThanThreshold',
  threshold: 5,
  evaluationPeriods: 3,
  datapointsToAlarm: 2,
  treatMissingData: 'missing',
};

describe('what an alarm may be', () => {
  it("takes each metric with its own statistics, M at most N, and a look back of a day at most", () => {
    expect([alarmProblem(RULE), alarmProblem({ ...RULE, metric: 'Duration', statistic: 'p95' }), alarmProblem({ ...RULE, period: 3600, evaluationPeriods: 24, datapointsToAlarm: 24 })]).toEqual([null, null, null]);
    expect([
      alarmProblem({ ...RULE, statistic: 'p95' }),
      alarmProblem({ ...RULE, metric: 'Duration', statistic: 'Sum' }),
      alarmProblem({ ...RULE, datapointsToAlarm: 4 }),
      alarmProblem({ ...RULE, period: 3600, evaluationPeriods: 25, datapointsToAlarm: 1 }),
    ]).toEqual([
      'Errors has the statistic Sum, not p95',
      'Duration has the statistics Average, Maximum, p50, p95, p99, not Sum',
      "datapointsToAlarm (4) can't be more than evaluationPeriods (3)",
      '25 periods of 3600 s look back more than a day: take fewer periods, or shorter ones',
    ]);
  });

  it("takes the account's money as the account's, read as it is: no function, one datapoint", () => {
    const balance = { ...RULE, functionId: null, metric: 'Balance' as const, statistic: 'Latest' as const, comparison: 'LessThanThreshold' as const, evaluationPeriods: 1, datapointsToAlarm: 1 };
    expect([alarmProblem(balance), alarmProblem({ ...balance, metric: 'MonthToDateCharges' })]).toEqual([null, null]);
    expect([alarmProblem({ ...balance, functionId: RULE.functionId }), alarmProblem({ ...balance, evaluationPeriods: 3 }), alarmProblem({ ...balance, statistic: 'Sum' })]).toEqual([
      "Balance is the account's: a billing alarm names no function",
      'Balance is read as it is: evaluationPeriods and datapointsToAlarm must be 1',
      'Balance has the statistic Latest, not Sum',
    ]);
  });
});

describe("an alarm on a customer's database", () => {
  const sessions = { ...RULE, functionId: null, databaseId: '7c1d9e2a-4b3f-4e8d-9a6c-5b4a3c2d1e0f', metric: 'DatabaseConnections' as const, statistic: 'Maximum' as const, period: 3600 };

  it('names the database, judges hours, and takes the Maximum or the Average of its sessions or of the bytes it uses', () => {
    expect([alarmProblem(sessions), alarmProblem({ ...sessions, metric: 'VolumeBytesUsed', statistic: 'Average', evaluationPeriods: 24, datapointsToAlarm: 3 })]).toEqual([null, null]);
    expect([
      alarmProblem({ ...sessions, databaseId: null }),
      alarmProblem({ ...sessions, functionId: RULE.functionId }),
      alarmProblem({ ...sessions, period: 300 }),
      alarmProblem({ ...sessions, statistic: 'Sum' }),
      alarmProblem({ ...RULE, databaseId: sessions.databaseId }),
    ]).toEqual([
      "DatabaseConnections is a database's: the alarm names a databaseId, and no function",
      "DatabaseConnections is a database's: the alarm names a databaseId, and no function",
      "A database's metrics have a point an hour: period must be 3600",
      'DatabaseConnections has the statistics Maximum, Average, not Sum',
      'A databaseId goes with DatabaseConnections and VolumeBytesUsed only',
    ]);
  });

  it("reads its datapoints from the database's hourly metrics, an hour without a sample missing", () => {
    const window = { start: new Date('2026-10-20T08:00:00Z'), end: new Date('2026-10-20T10:00:00Z'), period: 3600 as const };
    const view = databaseMetricsView(window, [{ bucket: window.start.getTime() / 1000, connectionsMaximum: 9, connectionsAverage: 9, bytesMaximum: 7_634_423, bytesAverage: 7_634_423 }]);

    expect([databaseDatapointsOf(view, 'DatabaseConnections', 'Maximum'), databaseDatapointsOf(view, 'VolumeBytesUsed', 'Average')]).toEqual([
      [9, null],
      [7_634_423, null],
    ]);
    expect(() => databaseDatapointsOf(view, 'Errors', 'Sum')).toThrow("Errors isn't a database's metric");
  });
});

describe("an alarm on a customer's bucket", () => {
  const bucketId = '0b6f3a1c-2d4e-4f5a-8b9c-1d2e3f4a5b6c';
  const held = { ...RULE, functionId: null, bucketId, metric: 'BucketSizeBytes' as const, statistic: 'Average' as const, period: 3600 };

  it("names the bucket, takes the Average of what it holds, and the Sum of its requests, in any period", () => {
    expect([
      alarmProblem(held),
      alarmProblem({ ...held, metric: 'NumberOfObjects', period: 300 }),
      alarmProblem({ ...held, metric: '5xxErrors', statistic: 'Sum', period: 60 }),
      alarmProblem({ ...held, metric: 'BytesDownloaded', statistic: 'Sum', period: 3600, evaluationPeriods: 24, datapointsToAlarm: 1 }),
    ]).toEqual([null, null, null, null]);
    expect([
      alarmProblem({ ...held, bucketId: null }),
      alarmProblem({ ...held, functionId: RULE.functionId }),
      alarmProblem({ ...held, databaseId: '7c1d9e2a-4b3f-4e8d-9a6c-5b4a3c2d1e0f' }),
      alarmProblem({ ...held, statistic: 'Maximum' }),
      alarmProblem({ ...held, metric: 'GetRequests', statistic: 'Average' }),
      alarmProblem({ ...RULE, bucketId }),
    ]).toEqual([
      "BucketSizeBytes is a bucket's: the alarm names a bucketName, and no function or database",
      "BucketSizeBytes is a bucket's: the alarm names a bucketName, and no function or database",
      'A databaseId goes with DatabaseConnections and VolumeBytesUsed only',
      'BucketSizeBytes has the statistic Average, not Maximum',
      'GetRequests has the statistic Sum, not Average',
      "A bucketName goes with a bucket's metrics only: BucketSizeBytes, NumberOfObjects, AllRequests, GetRequests, PutRequests, 4xxErrors, 5xxErrors, BytesDownloaded, BytesUploaded, Requests, 4xxErrorRate, 5xxErrorRate, TotalErrorRate",
    ]);
  });

  it("reads its datapoints from the bucket's metrics: what it holds, its hour's measure in each period, an hour unmeasured missing; its requests every period", () => {
    const window = { start: new Date('2026-10-20T08:55:00Z'), end: new Date('2026-10-20T09:10:00Z'), period: 300 as const };
    const nine = Date.parse('2026-10-20T09:00:00Z') / 1000;
    const requests = { AllRequests: 12, GetRequests: 9, PutRequests: 3, '4xxErrors': 2, '5xxErrors': 1, BytesDownloaded: 9_000, BytesUploaded: 3_000 };
    const view = bucketMetricsView(window, [{ hour: nine, sizeBytes: 161_480_253, objects: 1_204 }], [{ bucket: nine + 300, ...requests }]);

    expect([
      bucketDatapointsOf(view, 'BucketSizeBytes', 'Average'),
      bucketDatapointsOf(view, 'NumberOfObjects', 'Average'),
      bucketDatapointsOf(view, '5xxErrors', 'Sum'),
      bucketDatapointsOf(view, 'BytesDownloaded', 'Sum'),
    ]).toEqual([
      [null, 161_480_253, 161_480_253],
      [null, 1_204, 1_204],
      [0, 0, 1],
      [0, 0, 9_000],
    ]);
    expect(() => bucketDatapointsOf(view, 'Errors', 'Sum')).toThrow("Errors Sum isn't a bucket's metric");
  });

  it("watches its site's visits, their Sum, and the shares that failed, their Average, as CloudFront's are named", () => {
    expect([
      alarmProblem({ ...held, metric: 'Requests', statistic: 'Sum', period: 300 }),
      alarmProblem({ ...held, metric: 'TotalErrorRate', statistic: 'Average', period: 300 }),
      alarmProblem({ ...held, metric: '5xxErrorRate', statistic: 'Sum', period: 300 }),
    ]).toEqual([null, null, '5xxErrorRate has the statistic Average, not Sum']);
  });

  it("reads its datapoints from the site's metrics: its visits every period, a share missing in a period without a visit", () => {
    const window = { start: new Date('2026-10-30T09:00:00Z'), end: new Date('2026-10-30T09:15:00Z'), period: 300 as const };
    const nine = Date.parse('2026-10-30T09:00:00Z') / 1000;
    const view = siteMetricsView(window, [
      { bucket: nine, requests: 4, bytesOut: 4_000, errors4xx: 1, errors5xx: 1 },
      { bucket: nine + 600, requests: 10, bytesOut: 9_000, errors4xx: 0, errors5xx: 0 },
    ]);

    expect([siteDatapointsOf(view, 'Requests', 'Sum'), siteDatapointsOf(view, 'TotalErrorRate', 'Average'), siteDatapointsOf(view, '5xxErrorRate', 'Average')]).toEqual([
      [4, 0, 10],
      [50, null, 0],
      [25, null, 0],
    ]);
    expect(() => siteDatapointsOf(view, 'AllRequests', 'Sum')).toThrow("AllRequests Sum isn't a site's metric");
  });
});

describe("an alarm on a customer's queue", () => {
  const queueId = '3f1c9a2e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
  const waiting = { ...RULE, functionId: null, queueId, metric: 'ApproximateNumberOfMessagesVisible' as const, statistic: 'Maximum' as const };

  it("names the queue, takes the Maximum or Average of its messages, the Maximum of its oldest's age, the Sum of its counts, and the size of what was sent", () => {
    expect([
      alarmProblem(waiting),
      alarmProblem({ ...waiting, metric: 'ApproximateNumberOfMessagesNotVisible', statistic: 'Average', period: 300 }),
      alarmProblem({ ...waiting, metric: 'ApproximateAgeOfOldestMessage' }),
      alarmProblem({ ...waiting, metric: 'NumberOfEmptyReceives', statistic: 'Sum', period: 3600, evaluationPeriods: 24, datapointsToAlarm: 1 }),
      alarmProblem({ ...waiting, metric: 'SentMessageSize', statistic: 'Average' }),
    ]).toEqual([null, null, null, null, null]);
    expect([
      alarmProblem({ ...waiting, queueId: null }),
      alarmProblem({ ...waiting, functionId: RULE.functionId }),
      alarmProblem({ ...waiting, bucketId: '0b6f3a1c-2d4e-4f5a-8b9c-1d2e3f4a5b6c' }),
      alarmProblem({ ...waiting, metric: 'ApproximateAgeOfOldestMessage', statistic: 'Average' }),
      alarmProblem({ ...waiting, metric: 'NumberOfMessagesSent' }),
      alarmProblem({ ...RULE, queueId }),
    ]).toEqual([
      "ApproximateNumberOfMessagesVisible is a queue's: the alarm names a queueName, and no function, database or bucket",
      "ApproximateNumberOfMessagesVisible is a queue's: the alarm names a queueName, and no function, database or bucket",
      "A bucketName goes with a bucket's metrics only: BucketSizeBytes, NumberOfObjects, AllRequests, GetRequests, PutRequests, 4xxErrors, 5xxErrors, BytesDownloaded, BytesUploaded, Requests, 4xxErrorRate, 5xxErrorRate, TotalErrorRate",
      'ApproximateAgeOfOldestMessage has the statistic Maximum, not Average',
      'NumberOfMessagesSent has the statistic Sum, not Maximum',
      "A queueName goes with a queue's metrics only: ApproximateNumberOfMessagesVisible, ApproximateNumberOfMessagesNotVisible, ApproximateNumberOfMessagesDelayed, ApproximateAgeOfOldestMessage, NumberOfMessagesSent, NumberOfMessagesReceived, NumberOfMessagesDeleted, NumberOfEmptyReceives, SentMessageSize",
    ]);
  });

  it("reads its datapoints from the queue's metrics: an empty queue's messages and age 0, its counts every period, no size where nothing was sent", () => {
    const window = { start: new Date('2026-10-24T08:55:00Z'), end: new Date('2026-10-24T09:10:00Z'), period: 300 as const };
    const nine = Date.parse('2026-10-24T09:00:00Z') / 1000;
    const gauge = { maximum: 4, minuteSum: 10 };
    const view = queueMetricsView(
      window,
      [{ bucket: nine, ApproximateNumberOfMessagesVisible: gauge, ApproximateNumberOfMessagesNotVisible: gauge, ApproximateNumberOfMessagesDelayed: gauge, oldestAgeSeconds: 90 }],
      [{ bucket: nine + 300, NumberOfMessagesSent: 2, NumberOfMessagesReceived: 1, NumberOfMessagesDeleted: 1, NumberOfEmptyReceives: 0, sentBytes: 300, sentMaxBytes: 200 }],
    );

    expect([
      queueDatapointsOf(view, 'ApproximateNumberOfMessagesVisible', 'Maximum'),
      queueDatapointsOf(view, 'ApproximateNumberOfMessagesVisible', 'Average'),
      queueDatapointsOf(view, 'ApproximateAgeOfOldestMessage', 'Maximum'),
      queueDatapointsOf(view, 'NumberOfMessagesSent', 'Sum'),
      queueDatapointsOf(view, 'SentMessageSize', 'Maximum'),
    ]).toEqual([
      [0, 4, 0],
      [0, 2, 0],
      [0, 90, 0],
      [0, 0, 2],
      [null, null, 200],
    ]);
    expect(() => queueDatapointsOf(view, 'Errors', 'Sum')).toThrow("Errors isn't a queue's metric");
  });
});

describe("an alarm on a customer's cache", () => {
  const cacheId = '9b2e4c1a-7d3f-4a6b-8c5e-0f1a2b3c4d5e';
  const memory = { ...RULE, functionId: null, cacheId, metric: 'BytesUsedForCache' as const, statistic: 'Maximum' as const, period: 3600, evaluationPeriods: 1, datapointsToAlarm: 1 };

  it('names the cache, judges hours, a day at most, and takes the Maximum or Average of its memory and connections, the Sum of its counts', () => {
    expect([
      alarmProblem(memory),
      alarmProblem({ ...memory, metric: 'CurrConnections', statistic: 'Average' }),
      alarmProblem({ ...memory, metric: 'Evictions', statistic: 'Sum', evaluationPeriods: 24 }),
    ]).toEqual([null, null, null]);
    expect([
      alarmProblem({ ...memory, cacheId: null }),
      alarmProblem({ ...memory, functionId: RULE.functionId }),
      alarmProblem({ ...memory, period: 300 }),
      alarmProblem({ ...memory, metric: 'CacheHits' }),
      alarmProblem({ ...memory, evaluationPeriods: 25 }),
      alarmProblem({ ...RULE, cacheId }),
    ]).toEqual([
      "BytesUsedForCache is a cache's: the alarm names a cacheName, and no function, database, bucket or queue",
      "BytesUsedForCache is a cache's: the alarm names a cacheName, and no function, database, bucket or queue",
      "A cache's metrics have a point an hour: period must be 3600",
      'CacheHits has the statistic Sum, not Maximum',
      '25 periods of 3600 s look back more than a day: take fewer periods, or shorter ones',
      "A cacheName goes with a cache's metrics only: BytesUsedForCache, CurrConnections, CacheHits, CacheMisses, Evictions",
    ]);
  });

  it("reads its datapoints from the cache's hourly metrics, none for an hour it wasn't sampled in", () => {
    const window = { start: new Date('2026-10-30T07:00:00Z'), end: new Date('2026-10-30T10:00:00Z'), period: 3600 as const };
    const eight = Date.parse('2026-10-30T08:00:00Z') / 1000;
    const view = cacheMetricsView(window, [
      { bucket: eight, bytesMaximum: 1_258_291, bytesAverage: 1_000_000.4, connectionsMaximum: 3, connectionsAverage: 2.5, hits: 900, misses: 100, evictions: 0 },
    ]);

    expect([
      cacheDatapointsOf(view, 'BytesUsedForCache', 'Maximum'),
      cacheDatapointsOf(view, 'BytesUsedForCache', 'Average'),
      cacheDatapointsOf(view, 'CurrConnections', 'Average'),
      cacheDatapointsOf(view, 'CacheHits', 'Sum'),
      cacheDatapointsOf(view, 'Evictions', 'Sum'),
    ]).toEqual([
      [null, 1_258_291, null],
      [null, 1_000_000, null],
      [null, 2.5, null],
      [null, 900, null],
      [null, 0, null],
    ]);
    expect(() => cacheDatapointsOf(view, 'Errors', 'Sum')).toThrow("Errors isn't a cache's metric");
  });
});

describe('the periods an alarm judges', () => {
  it('are the last N whole periods over for at least the settling time, by UTC', () => {
    const now = new Date('2026-10-20T10:07:30Z');
    expect(evaluationWindow({ period: 60, evaluationPeriods: 3 }, now, 60)).toEqual({ start: new Date('2026-10-20T10:03:00Z'), end: new Date('2026-10-20T10:06:00Z') });
    expect(evaluationWindow({ period: 300, evaluationPeriods: 2 }, now, 60)).toEqual({ start: new Date('2026-10-20T09:55:00Z'), end: new Date('2026-10-20T10:05:00Z') });
    expect(evaluationWindow({ period: 60, evaluationPeriods: 1 }, now, 0)).toEqual({ start: new Date('2026-10-20T10:06:00Z'), end: new Date('2026-10-20T10:07:00Z') });
  });
});

describe('an evaluation, M out of N', () => {
  it('is ALARM when M or more of the N breach, OK when fewer do', () => {
    expect(evaluate(RULE, [1, 6, 7], 'OK')).toEqual({ state: 'ALARM', datapoints: [1, 6, 7], breaching: 2, missing: 0, latest: 7 });
    expect(evaluate(RULE, [6, 1, 2], 'ALARM')).toMatchObject({ state: 'OK', breaching: 1, latest: 2 });
  });

  it('compares as the comparison says: at the threshold breaches only with "or equal"', () => {
    const at = (comparison: AlarmRule['comparison']) => evaluate({ ...RULE, comparison, datapointsToAlarm: 1 }, [5], 'OK').state;
    expect([at('GreaterThanThreshold'), at('GreaterThanOrEqualToThreshold'), at('LessThanThreshold'), at('LessThanOrEqualToThreshold')]).toEqual(['OK', 'ALARM', 'OK', 'ALARM']);
    expect(evaluate({ ...RULE, comparison: 'LessThanThreshold', datapointsToAlarm: 1 }, [4.9], 'OK').state).toBe('ALARM');
  });

  it('missing, by default: all N missing is INSUFFICIENT_DATA, and otherwise the others are judged', () => {
    expect(evaluate(RULE, [null, null, null], 'OK')).toEqual({ state: 'INSUFFICIENT_DATA', datapoints: [null, null, null], breaching: 0, missing: 3, latest: null });
    expect(evaluate(RULE, [null, 6, 7], 'OK')).toMatchObject({ state: 'ALARM', missing: 1 });
    expect(evaluate(RULE, [null, null, 7], 'OK')).toMatchObject({ state: 'OK', breaching: 1 });
  });

  it('notBreaching and breaching count a missing datapoint as named', () => {
    expect(evaluate({ ...RULE, treatMissingData: 'notBreaching' }, [null, null, null], 'ALARM').state).toBe('OK');
    expect(evaluate({ ...RULE, treatMissingData: 'breaching' }, [null, null, 1], 'OK')).toMatchObject({ state: 'ALARM', breaching: 2 });
  });

  it('ignore keeps the state when all N are missing, and judges the others otherwise', () => {
    const ignore = { ...RULE, treatMissingData: 'ignore' as const };
    expect([evaluate(ignore, [null, null, null], 'ALARM').state, evaluate(ignore, [null, null, null], 'OK').state]).toEqual(['ALARM', 'OK']);
    expect(evaluate(ignore, [null, 6, 7], 'OK').state).toBe('ALARM');
  });

  it("says why, as CloudWatch's StateReason", () => {
    expect(stateReason(RULE, evaluate(RULE, [null, 6, 7], 'OK'))).toBe('2 of the last 3 period(s) of 60 s breaching Errors Sum > 5 (2 needed, 1 missing); latest 7');
    expect(stateReason({ ...RULE, metric: 'Duration', statistic: 'p95' }, evaluate(RULE, [null, null, null], 'OK'))).toBe('No datapoint for Duration p95 in the last 3 period(s) of 60 s');
    const balance = { ...RULE, metric: 'Balance' as const, statistic: 'Latest' as const, comparison: 'LessThanThreshold' as const, threshold: 5, datapointsToAlarm: 1 };
    expect(stateReason(balance, evaluate(balance, [2.5], 'OK'))).toBe('Balance is 2.5: breaching Balance < 5');
  });
});

describe('what is told', () => {
  it('a change into ALARM, and out of it; never a change between OK and INSUFFICIENT_DATA, nor none', () => {
    const changes = [
      ['OK', 'ALARM'],
      ['INSUFFICIENT_DATA', 'ALARM'],
      ['ALARM', 'OK'],
      ['ALARM', 'INSUFFICIENT_DATA'],
      ['INSUFFICIENT_DATA', 'OK'],
      ['OK', 'INSUFFICIENT_DATA'],
      ['ALARM', 'ALARM'],
    ] as const;
    expect(changes.map(([from, to]) => notifies(from, to))).toEqual([true, true, true, true, false, false, false]);
  });
});

describe('the datapoints read from the metrics', () => {
  const view = {
    metrics: {
      Invocations: [3, 0],
      Errors: [1, 0],
      Throttles: [0, 2],
      ColdStarts: [1, 0],
      Duration: { Average: [12, null], Maximum: [20, null], p50: [10, null], p95: [19, null], p99: [19.8, null] },
      Instances: { Maximum: [2, 1], Average: [1.5, 1] },
      AsyncEventsReceived: [4, 1],
      AsyncEventAge: { Average: [null, 1500], Maximum: [null, 2000] },
      AsyncEventsDropped: [0, 1],
      DestinationDeliveryFailures: [0, 0],
    },
  } as unknown as MetricsView;

  it("are a count's every period, a duration's statistic with its gaps, the instances' statistic", () => {
    expect([datapointsOf(view, 'Throttles', 'Sum'), datapointsOf(view, 'Duration', 'p95'), datapointsOf(view, 'Instances', 'Average')]).toEqual([
      [0, 2],
      [19, null],
      [1.5, 1],
    ]);
  });

  it("are Lambda's counts of asynchronous calls every period, and an event's age with its gaps", () => {
    expect([datapointsOf(view, 'AsyncEventsReceived', 'Sum'), datapointsOf(view, 'AsyncEventsDropped', 'Sum'), datapointsOf(view, 'AsyncEventAge', 'Maximum')]).toEqual([
      [4, 1],
      [0, 1],
      [null, 2000],
    ]);
    expect(alarmProblem({ ...RULE, metric: 'AsyncEventAge', statistic: 'Maximum' })).toBeNull();
    expect(alarmProblem({ ...RULE, functionId: null, metric: 'DestinationDeliveryFailures' })).toBeNull();
  });
});

describe("an alarm's e-mail", () => {
  const change = {
    account: { id: '000000000042', name: 'Tunis Labs' },
    alarm: { ...RULE, name: 'Checkout errors' },
    functionName: 'checkout',
    from: 'OK' as const,
    to: 'ALARM' as const,
    evaluation: evaluate(RULE, [null, 6, 7.5], 'OK'),
    at: new Date('2026-10-20T10:07:30Z'),
    consoleUrl: 'https://console.ff.tn',
  };

  it('says which alarm changed, when, why, and links to the alarms, in English', () => {
    expect(alarmMail(change, 'en')).toEqual({
      subject: 'ALARM: "Checkout errors" (Tunis Labs)',
      text: [
        'Your alarm "Checkout errors" on the function "checkout" of the account "Tunis Labs" (000000000042) went from OK to ALARM at 2026-10-20 10:07 UTC.',
        'Why: 2 of the last 3 period(s) of 60 s meet Errors Sum > 5 (2 needed, 1 without data); latest value: 7.5.',
        '',
        'Your alarms: https://console.ff.tn/alarms',
      ].join('\n'),
    });
  });

  it('and in French, numbers as French writes them', () => {
    expect(alarmMail(change, 'fr')).toEqual({
      subject: 'ALARME : « Checkout errors » (Tunis Labs)',
      text: [
        'Votre alarme « Checkout errors » sur la fonction « checkout » du compte « Tunis Labs » (000000000042) est passée de OK à ALARME le 20 octobre 2026 à 10:07 UTC.',
        'Motif : 2 des 3 dernière(s) période(s) de 60 s remplissent Errors Sum > 5 (2 requise(s), 1 sans donnée) ; dernière valeur : 7,5.',
        '',
        'Vos alarmes : https://console.ff.tn/alarms',
      ].join('\n'),
    });
  });

  it("names a database's alarm by the database, in both languages", () => {
    const sessions = { ...change, alarm: { ...RULE, metric: 'DatabaseConnections' as const, statistic: 'Maximum' as const, period: 3600, name: 'Sessions' }, functionName: null, databaseName: 'orders' };

    expect(alarmMail(sessions, 'en').text.split('\n')[0]).toBe('Your alarm "Sessions" on the database "orders" of the account "Tunis Labs" (000000000042) went from OK to ALARM at 2026-10-20 10:07 UTC.');
    expect(alarmMail(sessions, 'fr').text.split('\n')[0]).toBe(
      'Votre alarme « Sessions » sur la base de données « orders » du compte « Tunis Labs » (000000000042) est passée de OK à ALARME le 20 octobre 2026 à 10:07 UTC.',
    );
  });

  it("names a bucket's alarm by the bucket, in both languages", () => {
    const held = { ...change, alarm: { ...RULE, metric: 'BucketSizeBytes' as const, statistic: 'Average' as const, period: 3600, name: 'Photos size' }, functionName: null, bucketName: 'photos' };

    expect(alarmMail(held, 'en').text.split('\n')[0]).toBe('Your alarm "Photos size" on the bucket "photos" of the account "Tunis Labs" (000000000042) went from OK to ALARM at 2026-10-20 10:07 UTC.');
    expect(alarmMail(held, 'fr').text.split('\n')[0]).toBe(
      'Votre alarme « Photos size » sur le bucket « photos » du compte « Tunis Labs » (000000000042) est passée de OK à ALARME le 20 octobre 2026 à 10:07 UTC.',
    );
  });

  it("names a queue's alarm by the queue, in both languages", () => {
    const waiting = { ...change, alarm: { ...RULE, metric: 'ApproximateNumberOfMessagesVisible' as const, statistic: 'Maximum' as const, name: 'Dead letters' }, functionName: null, queueName: 'orders-dlq' };

    expect(alarmMail(waiting, 'en').text.split('\n')[0]).toBe('Your alarm "Dead letters" on the queue "orders-dlq" of the account "Tunis Labs" (000000000042) went from OK to ALARM at 2026-10-20 10:07 UTC.');
    expect(alarmMail(waiting, 'fr').text.split('\n')[0]).toBe(
      "Votre alarme « Dead letters » sur la file d'attente « orders-dlq » du compte « Tunis Labs » (000000000042) est passée de OK à ALARME le 20 octobre 2026 à 10:07 UTC.",
    );
  });

  it("names a cache's alarm by the cache, in both languages", () => {
    const full = { ...change, alarm: { ...RULE, metric: 'BytesUsedForCache' as const, statistic: 'Maximum' as const, period: 3600, name: 'Sessions memory' }, functionName: null, cacheName: 'sessions' };

    expect(alarmMail(full, 'en').text.split('\n')[0]).toBe('Your alarm "Sessions memory" on the cache "sessions" of the account "Tunis Labs" (000000000042) went from OK to ALARM at 2026-10-20 10:07 UTC.');
    expect(alarmMail(full, 'fr').text.split('\n')[0]).toBe(
      'Votre alarme « Sessions memory » sur le cache « sessions » du compte « Tunis Labs » (000000000042) est passée de OK à ALARME le 20 octobre 2026 à 10:07 UTC.',
    );
  });

  it("names the account's alarms as the account's, the money's value as it is, and a recovery with no data", () => {
    const balance = { ...RULE, functionId: null, metric: 'Balance' as const, statistic: 'Latest' as const, comparison: 'LessThanThreshold' as const, threshold: 5, evaluationPeriods: 1, datapointsToAlarm: 1 };
    const low = { ...change, alarm: { ...balance, name: 'Low balance' }, functionName: null, evaluation: evaluate(balance, [2.5], 'OK') };
    expect(alarmMail(low, 'en').text.split('\n').slice(0, 2)).toEqual([
      'Your alarm "Low balance" on the account "Tunis Labs" (000000000042) went from OK to ALARM at 2026-10-20 10:07 UTC.',
      'Why: Balance is 2.5, which meets < 5.',
    ]);
    expect(alarmMail(low, 'fr').text.split('\n').slice(0, 2)).toEqual([
      'Votre alarme « Low balance » sur le compte « Tunis Labs » (000000000042) est passée de OK à ALARME le 20 octobre 2026 à 10:07 UTC.',
      'Motif : Balance vaut 2,5, ce qui remplit la condition < 5.',
    ]);
    expect(alarmMail({ ...low, from: 'ALARM' as const, to: 'OK' as const, evaluation: evaluate(balance, [7], 'ALARM') }, 'en').text.split('\n')[1]).toBe("Why: Balance is 7, which doesn't meet < 5.");
    const quiet = { ...change, from: 'ALARM' as const, to: 'INSUFFICIENT_DATA' as const, evaluation: evaluate(RULE, [null, null, null], 'ALARM') };
    expect([alarmMail(quiet, 'en').subject, alarmMail(quiet, 'fr').subject, alarmMail(quiet, 'fr').text.split('\n')[1]]).toEqual([
      'INSUFFICIENT_DATA: "Checkout errors" (Tunis Labs)',
      'DONNÉES INSUFFISANTES : « Checkout errors » (Tunis Labs)',
      'Motif : Aucune donnée pour Errors Sum dans les 3 dernière(s) période(s) de 60 s.',
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import type { Alarm } from '../services/api';
import { STATE_INFO, conditionText, emptyForm, firingCount, formFromAlarm, formProblem, metricsFor, scopeOf, toBody, withMetric, withScope } from './alarms';

const FN = '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f';
const DB = '7c1d9e2a-4b3f-4e8d-9a6c-5b4a3c2d1e0f';

describe('the alarm form', () => {
  it('starts on a function\'s errors as soon as there is one, or the account\'s calls, told to the owners', () => {
    expect(toBody({ ...emptyForm(FN), name: ' Checkout errors ' })).toEqual({
      name: 'Checkout errors',
      functionId: FN,
      databaseId: null,
      bucketName: null,
      queueName: null,
      cacheName: null,
      metric: 'Errors',
      statistic: 'Sum',
      period: 60,
      comparison: 'GreaterThanThreshold',
      threshold: 0,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: 'missing',
      actions: { email: true, webhookUrls: [] },
    });
    expect([emptyForm().functionId, emptyForm().metric]).toEqual(['', 'Invocations']);
    // The account's: no function, sent as null, which the API takes, not as an empty ID.
    expect(toBody({ ...emptyForm(), name: 'Calls' }).functionId).toBeNull();
  });

  it("offers a function's calls, durations and instances, and its calls that don't wait as Lambda counts them, and the account its money too", () => {
    expect(metricsFor(FN)).toEqual([
      'Invocations',
      'Errors',
      'Throttles',
      'ColdStarts',
      'Duration',
      'Instances',
      'AsyncEventsReceived',
      'AsyncEventAge',
      'AsyncEventsDropped',
      'DestinationDeliveryFailures',
    ]);
    expect(metricsFor('')).toContain('Balance');
    expect(metricsFor('')).not.toContain('DatabaseConnections');
  });

  it("watches a database's sessions or storage, an hour a period, and sends its ID, no function's", () => {
    const storage = { ...emptyForm('', DB), name: 'Storage', threshold: '900000000' };

    expect(storage).toMatchObject({ functionId: '', databaseId: DB, metric: 'VolumeBytesUsed', statistic: 'Maximum', period: 3600 });
    expect(metricsFor('', DB)).toEqual(['DatabaseConnections', 'VolumeBytesUsed']);
    expect(toBody(storage)).toMatchObject({ functionId: null, databaseId: DB, metric: 'VolumeBytesUsed', period: 3600, threshold: 900_000_000 });
    expect([formProblem(storage), formProblem({ ...storage, evaluationPeriods: '25', datapointsToAlarm: '1' })]).toEqual([null, 'The periods judged look back more than a day: take fewer']);
    expect(formProblem({ ...storage, databaseId: '' })).toBe('VolumeBytesUsed is a database\'s: choose the database it watches');
    expect(formProblem({ ...storage, period: 60 })).toBe("A database's metrics have a point an hour: the period is an hour");
  });

  it("watches a bucket's storage or requests, by its name, in any period, and sends its name, no function's or database's", () => {
    const errors = { ...emptyForm('', '', 'photos'), name: 'Store errors' };

    expect(errors).toMatchObject({ functionId: '', databaseId: '', bucketName: 'photos', metric: '5xxErrors', statistic: 'Sum', period: 300 });
    expect(metricsFor('', '', 'photos')).toEqual([
      'BucketSizeBytes',
      'NumberOfObjects',
      'AllRequests',
      'GetRequests',
      'PutRequests',
      '4xxErrors',
      '5xxErrors',
      'BytesDownloaded',
      'BytesUploaded',
      'Requests',
      '4xxErrorRate',
      '5xxErrorRate',
      'TotalErrorRate',
    ]);
    expect(metricsFor('')).not.toContain('BucketSizeBytes');
    // Its site's, as CloudFront's are named: a share of its visits, in percent.
    expect(withMetric(errors, 'TotalErrorRate')).toMatchObject({ bucketName: 'photos', statistic: 'Average' });
    expect(toBody(errors)).toMatchObject({ functionId: null, databaseId: null, bucketName: 'photos', metric: '5xxErrors', period: 300 });
    expect(withMetric(errors, 'BucketSizeBytes')).toMatchObject({ bucketName: 'photos', statistic: 'Average' });
    expect([formProblem(errors), formProblem({ ...errors, bucketName: '' })]).toEqual([null, "5xxErrors is a bucket's: choose the bucket it watches"]);
    expect(withScope(errors, '')).toMatchObject({ bucketName: '', metric: 'Errors' });
    expect(withScope({ ...emptyForm(FN), name: 'Errors' }, 'bucket:photos')).toMatchObject({ functionId: '', bucketName: 'photos', metric: '5xxErrors' });
    expect(scopeOf(errors)).toBe('bucket:photos');
    expect(formFromAlarm({ ...toBody(errors), id: 'a', state: 'OK', stateReason: null, stateChangedAt: null, evaluatedAt: null, createdAt: '', updatedAt: '' } as Alarm).bucketName).toBe('photos');
  });

  it("watches a queue's messages, their age and size, or its requests, by its name, and sends its name alone", () => {
    const deadLetters = { ...emptyForm('', '', '', 'orders-dlq'), name: 'Dead letters' };

    expect(deadLetters).toMatchObject({ functionId: '', databaseId: '', bucketName: '', queueName: 'orders-dlq', metric: 'ApproximateNumberOfMessagesVisible', statistic: 'Maximum', period: 60 });
    expect(metricsFor('', '', '', 'orders-dlq')).toEqual([
      'ApproximateNumberOfMessagesVisible',
      'ApproximateNumberOfMessagesNotVisible',
      'ApproximateNumberOfMessagesDelayed',
      'ApproximateAgeOfOldestMessage',
      'NumberOfMessagesSent',
      'NumberOfMessagesReceived',
      'NumberOfMessagesDeleted',
      'NumberOfEmptyReceives',
      'SentMessageSize',
    ]);
    expect([metricsFor(''), metricsFor(FN)].some((metrics) => metrics.includes('NumberOfMessagesSent'))).toBe(false);
    expect(toBody(deadLetters)).toMatchObject({ functionId: null, databaseId: null, bucketName: null, queueName: 'orders-dlq', metric: 'ApproximateNumberOfMessagesVisible' });
    expect(withMetric(deadLetters, 'NumberOfMessagesSent')).toMatchObject({ queueName: 'orders-dlq', statistic: 'Sum' });
    expect([formProblem(deadLetters), formProblem({ ...deadLetters, queueName: '' })]).toEqual([null, "ApproximateNumberOfMessagesVisible is a queue's: choose the queue it watches"]);
    expect(withScope(deadLetters, 'bucket:photos')).toMatchObject({ queueName: '', bucketName: 'photos', metric: '5xxErrors' });
    expect(withScope({ ...emptyForm(FN), name: 'Waiting' }, 'queue:orders')).toMatchObject({ functionId: '', queueName: 'orders', metric: 'ApproximateNumberOfMessagesVisible' });
    expect(scopeOf(deadLetters)).toBe('queue:orders-dlq');
    expect(conditionText({ ...toBody(deadLetters), threshold: 0 })).toBe('ApproximateNumberOfMessagesVisible Maximum > 0 messages, in the last period of 1 minute');
    expect(formFromAlarm({ ...toBody(deadLetters), id: 'a', state: 'OK', stateReason: null, stateChangedAt: null, evaluatedAt: null, createdAt: '', updatedAt: '' } as Alarm).queueName).toBe('orders-dlq');
  });

  it("watches a cache's memory, connections, hits, misses or evictions, an hour at a time, by its name alone", () => {
    const memory = { ...emptyForm('', '', '', '', 'sessions'), name: 'Memory', threshold: '60000000' };

    expect(memory).toMatchObject({ functionId: '', databaseId: '', bucketName: '', queueName: '', cacheName: 'sessions', metric: 'BytesUsedForCache', statistic: 'Maximum', period: 3600 });
    expect(metricsFor('', '', '', '', 'sessions')).toEqual(['BytesUsedForCache', 'CurrConnections', 'CacheHits', 'CacheMisses', 'Evictions']);
    expect([metricsFor(''), metricsFor(FN)].some((metrics) => metrics.includes('Evictions'))).toBe(false);
    expect(toBody(memory)).toMatchObject({ functionId: null, queueName: null, cacheName: 'sessions', metric: 'BytesUsedForCache', period: 3600 });
    expect(withMetric(memory, 'Evictions')).toMatchObject({ cacheName: 'sessions', statistic: 'Sum', period: 3600 });
    expect(conditionText({ ...toBody(memory), threshold: 60000000 })).toBe('BytesUsedForCache Maximum > 60000000 bytes, in the last period of 1 hour');
    // The API's own refusals, said first: a cache named, its hour, a day at most.
    expect([formProblem(memory), formProblem({ ...memory, cacheName: '' }), formProblem({ ...memory, period: 300 }), formProblem({ ...memory, evaluationPeriods: '25', datapointsToAlarm: '1' })]).toEqual([
      null,
      "BytesUsedForCache is a cache's: choose the cache it watches",
      "A cache's metrics have a point an hour: the period is an hour",
      'The periods judged look back more than a day: take fewer',
    ]);
    // Its scope goes as the select names it, to the cache and away from it.
    expect(withScope({ ...emptyForm(FN), name: 'Hits' }, 'cache:sessions')).toMatchObject({ functionId: '', cacheName: 'sessions', metric: 'BytesUsedForCache', period: 3600 });
    expect(withScope(memory, 'queue:orders')).toMatchObject({ cacheName: '', queueName: 'orders', metric: 'ApproximateNumberOfMessagesVisible' });
    expect(scopeOf(memory)).toBe('cache:sessions');
    expect(formFromAlarm({ ...toBody(memory), id: 'a', state: 'OK', stateReason: null, stateChangedAt: null, evaluatedAt: null, createdAt: '', updatedAt: '' } as Alarm).cacheName).toBe('sessions');
  });

  it("watches the account's mail, an hour at a time, naming nothing: a function's scope doesn't offer it", () => {
    expect(metricsFor('')).toEqual(expect.arrayContaining(['Send', 'Bounce', 'Reputation.BounceRate', 'Reputation.ComplaintRate']));
    expect(metricsFor(FN)).not.toContain('Bounce');
    const bounces = withMetric({ ...emptyForm('', '', '', '', 'sessions'), name: 'Bounces' }, 'Reputation.BounceRate');

    expect(bounces).toMatchObject({ functionId: '', databaseId: '', bucketName: '', queueName: '', cacheName: '', metric: 'Reputation.BounceRate', statistic: 'Average', period: 3600 });
    expect(toBody(bounces)).toMatchObject({ functionId: null, cacheName: null, metric: 'Reputation.BounceRate', period: 3600 });
    // The API's own refusals, said first: the account alone, its hour, a day at most.
    expect([formProblem(bounces), formProblem({ ...bounces, functionId: FN }), formProblem({ ...bounces, period: 60 }), formProblem({ ...bounces, evaluationPeriods: '25', datapointsToAlarm: '1' })]).toEqual([
      null,
      "Reputation.BounceRate is the account's mail's: it watches the account",
      "Mail's metrics have a point an hour: the period is an hour",
      'The periods judged look back more than a day: take fewer',
    ]);
    // A function's scope takes it to that function's own metrics.
    expect(withScope(bounces, FN)).toMatchObject({ functionId: FN, metric: 'Errors' });
  });

  it('changes scope with a metric the scope has: a database to the account, a function to a database', () => {
    const storage = { ...emptyForm('', DB), name: 'Storage' };

    expect(withScope(storage, '')).toMatchObject({ functionId: '', databaseId: '', metric: 'Errors' });
    expect(withScope({ ...emptyForm(FN), name: 'Errors' }, `database:${DB}`)).toMatchObject({ functionId: '', databaseId: DB, metric: 'VolumeBytesUsed', period: 3600 });
    expect([scopeOf(storage), scopeOf(emptyForm(FN)), scopeOf(emptyForm())]).toEqual([`database:${DB}`, FN, '']);
  });

  it("keeps a statistic the new metric has, else takes its first; the money is the account's, one period", () => {
    const duration = withMetric({ ...emptyForm(FN), statistic: 'Sum' }, 'Duration');
    expect(duration.statistic).toBe('Average');
    expect(withMetric({ ...duration, statistic: 'Maximum' }, 'Instances').statistic).toBe('Maximum');
    expect(withMetric({ ...emptyForm(FN), evaluationPeriods: '5', datapointsToAlarm: '3' }, 'Balance')).toMatchObject({ functionId: '', statistic: 'Latest', evaluationPeriods: '1', datapointsToAlarm: '1' });
  });

  it("says what the API would refuse before sending it", () => {
    const form = { ...emptyForm(FN), name: 'Errors' };
    expect(formProblem(form)).toBeNull();
    expect([
      formProblem({ ...form, name: ' ' }),
      formProblem({ ...form, threshold: 'many' }),
      formProblem({ ...form, threshold: '' }),
      formProblem({ ...form, evaluationPeriods: '0' }),
      formProblem({ ...form, evaluationPeriods: '61' }),
      formProblem({ ...form, evaluationPeriods: '3', datapointsToAlarm: '4' }),
      formProblem({ ...form, evaluationPeriods: '2.5' }),
      formProblem({ ...form, period: 3600, evaluationPeriods: '25' }),
      formProblem({ ...form, webhookUrls: 'ftp://example.tn' }),
      formProblem({ ...form, webhookUrls: Array(6).fill('https://example.tn').join('\n') }),
    ]).toEqual([
      'Give the alarm a name',
      'The threshold must be a number',
      'The threshold must be a number',
      'The periods judged must be a whole number from 1 to 60',
      'The periods judged must be a whole number from 1 to 60',
      'The periods breaching must be a whole number from 1 to the 3 judged',
      'The periods judged must be a whole number from 1 to 60',
      'The periods judged look back more than a day: take fewer, or shorter ones',
      'ftp://example.tn: The URL must start with https:// or http://',
      'An alarm tells at most 5 webhooks',
    ]);
    const balance = { ...withMetric(form, 'Balance'), comparison: 'LessThanThreshold' as const, threshold: '5' };
    expect([formProblem(balance), formProblem({ ...balance, functionId: FN }), formProblem({ ...balance, evaluationPeriods: '2', datapointsToAlarm: '1' })]).toEqual([
      null,
      "Balance is the account's: it watches no function",
      'Balance is read as it is: one period',
    ]);
  });

  it('sends the webhooks one per line, blank lines left out, and comes back from an alarm as it was', () => {
    const form = { ...emptyForm(FN), name: 'Errors', webhookUrls: ' https://a.example.tn/ff \n\nhttps://b.example.tn/ff\n' };
    expect(toBody(form).actions.webhookUrls).toEqual(['https://a.example.tn/ff', 'https://b.example.tn/ff']);
    const alarm = { ...toBody(form), id: 'a-1', state: 'OK', stateReason: null, stateChangedAt: null, evaluatedAt: null, createdAt: '', updatedAt: '' } as Alarm;
    expect(toBody(formFromAlarm(alarm))).toEqual(toBody(form));
  });
});

describe('an alarm, as the page says it', () => {
  it('reads its condition with its unit and its periods', () => {
    const base = { metric: 'Errors', statistic: 'Sum', comparison: 'GreaterThanThreshold', threshold: 0, period: 60, evaluationPeriods: 1, datapointsToAlarm: 1 };
    expect(conditionText(base)).toBe('Errors Sum > 0 calls, in the last period of 1 minute');
    expect(conditionText({ ...base, metric: 'Duration', statistic: 'p95', comparison: 'GreaterThanOrEqualToThreshold', threshold: 800, period: 300, evaluationPeriods: 3, datapointsToAlarm: 2 })).toBe(
      'Duration p95 >= 800 ms, in 2 of the last 3 periods of 5 minutes',
    );
    expect(conditionText({ ...base, metric: 'Balance', statistic: 'Latest', comparison: 'LessThanThreshold', threshold: 5 })).toBe('Balance < 5 TND, as it is');
  });

  it('names each state in words, beside its tone', () => {
    expect(STATE_INFO).toEqual({ OK: { label: 'OK', tone: 'ok' }, ALARM: { label: 'In alarm', tone: 'alarm' }, INSUFFICIENT_DATA: { label: 'Insufficient data', tone: 'unknown' } });
  });
});

describe('firingCount', () => {
  it('counts the alarms in alarm only: neither an OK one nor one without data', () => {
    expect(firingCount([{ state: 'ALARM' }, { state: 'OK' }, { state: 'INSUFFICIENT_DATA' }, { state: 'ALARM' }])).toBe(2);
    expect(firingCount([{ state: 'OK' }, { state: 'INSUFFICIENT_DATA' }])).toBe(0);
    expect(firingCount([])).toBe(0);
  });
});

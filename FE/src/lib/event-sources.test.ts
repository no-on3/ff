import { describe, expect, it } from 'vitest';
import type { EventSource } from '../services/api';
import { eventSourceBody, eventSourceForm, eventSourceText, nameOfArn } from './event-sources';

const mapping = (values: Partial<EventSource> = {}): EventSource => ({
  uuid: '1f0e2d3c-4b5a-4968-8776-655443322110',
  eventSourceArn: 'arn:aws:sqs:tn-tunis-1:000000000001:orders',
  functionArn: 'arn:aws:lambda:tn-tunis-1:000000000001:function:orders-worker',
  batchSize: 10,
  maximumBatchingWindowInSeconds: 0,
  functionResponseTypes: [],
  scalingConfig: null,
  state: 'Enabled',
  stateTransitionReason: 'USER_INITIATED',
  lastModified: '2026-10-24T08:00:00.000Z',
  ...values,
});

describe('a function reading a queue, as the console says it', () => {
  it('says its batches, its window, how a failure is read and its concurrency', () => {
    expect(eventSourceText(mapping())).toBe('batches of up to 10 messages, no window, a failed call keeping its whole batch');
    expect(
      eventSourceText(mapping({ batchSize: 1000, maximumBatchingWindowInSeconds: 5, functionResponseTypes: ['ReportBatchItemFailures'], scalingConfig: { maximumConcurrency: 2 } })),
    ).toBe('batches of up to 1,000 messages, gathered for up to 5 seconds, its answer naming the messages that failed, 2 at once at most');
    expect(eventSourceText(mapping({ batchSize: 1, maximumBatchingWindowInSeconds: 1 }))).toBe('batches of 1 message, gathered for up to 1 second, a failed call keeping its whole batch');
    expect([nameOfArn(mapping().eventSourceArn), nameOfArn(mapping().functionArn)]).toEqual(['orders', 'orders-worker']);
  });
});

describe("a mapping's form", () => {
  it("starts from Lambda's defaults, or from the mapping there is", () => {
    expect(eventSourceForm()).toEqual({ queue: '', batchSize: '10', window: '0', reportFailures: false, maximumConcurrency: '', enabled: true });
    expect(eventSourceForm(mapping({ scalingConfig: { maximumConcurrency: 4 }, functionResponseTypes: ['ReportBatchItemFailures'], state: 'Disabled' }))).toEqual({
      queue: 'orders',
      batchSize: '10',
      window: '0',
      reportFailures: true,
      maximumConcurrency: '4',
      enabled: false,
    });
  });

  it("sends Lambda's settings by their names, no maximum as null", () => {
    expect(eventSourceBody({ ...eventSourceForm(), batchSize: '100', window: '2', reportFailures: true, maximumConcurrency: '5' })).toEqual({
      body: { batchSize: 100, maximumBatchingWindowInSeconds: 2, functionResponseTypes: ['ReportBatchItemFailures'], scalingConfig: { maximumConcurrency: 5 }, enabled: true },
    });
    expect(eventSourceBody(eventSourceForm())).toEqual({
      body: { batchSize: 10, maximumBatchingWindowInSeconds: 0, functionResponseTypes: [], scalingConfig: null, enabled: true },
    });
  });

  it.each([
    [{ batchSize: '0' }, 'A batch: from 1 to 10,000 messages'],
    [{ batchSize: '1.5' }, 'A batch: from 1 to 10,000 messages'],
    [{ window: '301' }, 'The batching window: a whole number of seconds, from 0 to 300'],
    [{ batchSize: '11' }, 'Over 10 messages a batch, a batching window is needed to gather them, as on Lambda'],
    [{ maximumConcurrency: '1' }, "Batches at once: from 2 to 1,000, or none for as many as the function's instances"],
  ])('refuses %j, saying why, before anything is sent', (values, problem) => {
    expect(eventSourceBody({ ...eventSourceForm(), ...values })).toEqual({ problem });
  });
});

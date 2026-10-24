import type { EventSource, EventSourceSettings } from '../services/api';

/** Lambda's bounds for a mapping of an SQS queue, which the API holds them to: contract.test.ts checks them against the API's. */
export const BATCH_SIZE = { min: 1, max: 10_000, withoutWindow: 10, byDefault: 10 } as const;
export const BATCHING_WINDOW = { min: 0, max: 300 } as const;
export const MAXIMUM_CONCURRENCY = { min: 2, max: 1000 } as const;
export const REPORT_BATCH_ITEM_FAILURES = 'ReportBatchItemFailures';

/** The form for a mapping: the queue by its name, '' until one is chosen; the numbers as typed, the concurrency '' for none. */
export interface EventSourceForm {
  queue: string;
  batchSize: string;
  window: string;
  reportFailures: boolean;
  maximumConcurrency: string;
  enabled: boolean;
}

/** The name an ARN ends with: a queue's, arn:aws:sqs:<region>:<account>:<name>, or a function's. */
export const nameOfArn = (arn: string): string => arn.slice(arn.lastIndexOf(':') + 1);

/** The form for a mapping there is, or for a new one with Lambda's defaults. */
export function eventSourceForm(mapping?: EventSource): EventSourceForm {
  return {
    queue: mapping ? nameOfArn(mapping.eventSourceArn) : '',
    batchSize: String(mapping?.batchSize ?? BATCH_SIZE.byDefault),
    window: String(mapping?.maximumBatchingWindowInSeconds ?? 0),
    reportFailures: mapping?.functionResponseTypes.includes(REPORT_BATCH_ITEM_FAILURES) ?? false,
    maximumConcurrency: mapping?.scalingConfig ? String(mapping.scalingConfig.maximumConcurrency) : '',
    enabled: mapping ? mapping.state === 'Enabled' : true,
  };
}

const whole = (text: string, min: number, max: number): number | undefined => {
  const value = Number(text);
  return text.trim() !== '' && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
};

/**
 * The settings the form gives, by Lambda's names, as POST and PATCH take
 * them; or what is wrong in it, before anything is sent. A mapping's queue is
 * set when it is made, as the API's route names its function.
 */
export function eventSourceBody(form: EventSourceForm): { body: EventSourceSettings } | { problem: string } {
  const batchSize = whole(form.batchSize, BATCH_SIZE.min, BATCH_SIZE.max);
  if (batchSize === undefined) return { problem: `A batch: from ${BATCH_SIZE.min} to ${BATCH_SIZE.max.toLocaleString('en-US')} messages` };
  const window = whole(form.window, BATCHING_WINDOW.min, BATCHING_WINDOW.max);
  if (window === undefined) return { problem: `The batching window: a whole number of seconds, from ${BATCHING_WINDOW.min} to ${BATCHING_WINDOW.max}` };
  if (batchSize > BATCH_SIZE.withoutWindow && window === 0) {
    return { problem: `Over ${BATCH_SIZE.withoutWindow} messages a batch, a batching window is needed to gather them, as on Lambda` };
  }
  let scalingConfig: EventSourceSettings['scalingConfig'] = null;
  if (form.maximumConcurrency.trim() !== '') {
    const maximum = whole(form.maximumConcurrency, MAXIMUM_CONCURRENCY.min, MAXIMUM_CONCURRENCY.max);
    if (maximum === undefined) return { problem: `Batches at once: from ${MAXIMUM_CONCURRENCY.min} to ${MAXIMUM_CONCURRENCY.max.toLocaleString('en-US')}, or none for as many as the function's instances` };
    scalingConfig = { maximumConcurrency: maximum };
  }
  return {
    body: {
      batchSize,
      maximumBatchingWindowInSeconds: window,
      functionResponseTypes: form.reportFailures ? [REPORT_BATCH_ITEM_FAILURES] : [],
      scalingConfig,
      enabled: form.enabled,
    },
  };
}

/** How a mapping reads its queue, in a few words. */
export function eventSourceText(mapping: EventSource): string {
  const window = mapping.maximumBatchingWindowInSeconds;
  const parts = [
    `batches of ${mapping.batchSize === 1 ? '1 message' : `up to ${mapping.batchSize.toLocaleString('en-US')} messages`}`,
    window === 0 ? 'no window' : `gathered for up to ${window === 1 ? '1 second' : `${window} seconds`}`,
    mapping.functionResponseTypes.includes(REPORT_BATCH_ITEM_FAILURES) ? 'its answer naming the messages that failed' : 'a failed call keeping its whole batch',
  ];
  if (mapping.scalingConfig) parts.push(`${mapping.scalingConfig.maximumConcurrency} at once at most`);
  return parts.join(', ');
}

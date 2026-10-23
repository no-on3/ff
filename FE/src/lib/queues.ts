import type { Queue, QueueAttributes, QueueMessages, RedrivePolicy } from '../services/api';
import { formatSize } from './databases';

/** A queue's name, as the API takes it: SQS's rule. contract.test.ts checks it against the API's. */
export const QUEUE_NAME = /^[A-Za-z0-9_-]+$/;

/** Why the API would refuse the name, said before sending it; null when it would take it. */
export function queueNameProblem(name: string): string | null {
  if (name === '') return 'Give the queue a name';
  if (name.endsWith('.fifo')) return "FF's queues are standard queues: FIFO queues come later";
  if (name.length > 80 || !QUEUE_NAME.test(name)) return '1 to 80 letters, digits, hyphens or underscores, as SQS names queues';
  return null;
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** A number of seconds as people read it: days, hours or minutes when it is whole ones, else seconds. */
export function durationText(seconds: number): string {
  if (seconds !== 0 && seconds % 86_400 === 0) return plural(seconds / 86_400, 'day');
  if (seconds !== 0 && seconds % 3600 === 0) return plural(seconds / 3600, 'hour');
  if (seconds !== 0 && seconds % 60 === 0) return plural(seconds / 60, 'minute');
  return plural(seconds, 'second');
}

/** What messages hold, as people read it: bytes, KB under a megabyte, else MB and GB as databases and buckets say theirs. */
export function bytesText(bytes: number): string {
  if (bytes < 1024) return plural(bytes, 'byte');
  if (bytes < 1024 * 1024) return `${(Math.round((bytes / 1024) * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 })} KB`;
  return formatSize(bytes);
}

/** A queue's messages, in a few words. */
export function messagesText(messages: QueueMessages): string {
  const parts = [`${messages.available} waiting`];
  if (messages.inFlight) parts.push(`${messages.inFlight} in flight`);
  if (messages.delayed) parts.push(`${messages.delayed} delayed`);
  return parts.join(', ');
}

/** SQS's attributes a queue's form edits, with the API's bounds and what each means. */
export const QUEUE_ATTRIBUTES = [
  { field: 'visibilityTimeout', label: 'Visibility timeout', min: 0, max: 43_200, unit: 'seconds', help: 'How long a message received is hidden from other receives; 12 hours at most' },
  { field: 'messageRetentionPeriod', label: 'Retention', min: 60, max: 1_209_600, unit: 'seconds', help: 'How long a message is kept, received or not; a minute to 14 days' },
  { field: 'delaySeconds', label: 'Delivery delay', min: 0, max: 900, unit: 'seconds', help: 'How long a new message waits before it can be received; 15 minutes at most' },
  { field: 'receiveMessageWaitTimeSeconds', label: 'Receive wait', min: 0, max: 20, unit: 'seconds', help: 'How long a receive that names no wait waits for a message: a long poll' },
  { field: 'maximumMessageSize', label: 'Largest message', min: 1024, max: 1_048_576, unit: 'bytes', help: 'A message\'s body and attributes together; 1 KiB to 1 MiB' },
] as const;
type AttributeField = (typeof QUEUE_ATTRIBUTES)[number]['field'];

/** Where a queue's dead letters go, in a few words: a dead-letter queue deleted since takes none, and its messages keep coming back. */
export function deadLetterText(arn: string, queues: Array<Pick<Queue, 'arn'>>): string {
  const name = nameOfQueueArn(arn);
  return queues.some((queue) => queue.arn === arn) ? `dead letters to ${name}` : `dead letters to ${name}, which is gone: none moves`;
}

/** The queue's form: its attributes as typed, and its dead-letter queue by name, '' for none. */
export interface QueueForm {
  values: Record<AttributeField, string>;
  deadLetterQueue: string;
  maxReceiveCount: string;
}

/** The name a queue's ARN ends with: arn:aws:sqs:<region>:<account>:<name>. */
export const nameOfQueueArn = (arn: string): string => arn.slice(arn.lastIndexOf(':') + 1);

/** The form for a queue, as it is. */
export function queueForm(queue: Queue): QueueForm {
  return {
    values: Object.fromEntries(QUEUE_ATTRIBUTES.map(({ field }) => [field, String(queue[field])])) as Record<AttributeField, string>,
    deadLetterQueue: queue.redrivePolicy ? nameOfQueueArn(queue.redrivePolicy.deadLetterTargetArn) : '',
    maxReceiveCount: String(queue.redrivePolicy?.maxReceiveCount ?? 5),
  };
}

/**
 * The body of PATCH /queues/:name: the attributes that changed, and the
 * redrive policy, its dead-letter queue by its ARN, under the queue's own
 * account and region; or what is wrong in the form.
 */
export function queueAttributesBody(form: QueueForm, queue: Queue): { body: QueueAttributes } | { problem: string } {
  const body: QueueAttributes = {};
  for (const { field, label, min, max, unit } of QUEUE_ATTRIBUTES) {
    const value = Number(form.values[field]);
    if (form.values[field].trim() === '' || !Number.isInteger(value) || value < min || value > max) {
      return { problem: `${label}: a whole number of ${unit}, from ${min} to ${max}` };
    }
    if (value !== queue[field]) body[field] = value;
  }
  if (form.deadLetterQueue === queue.name) return { problem: "A queue can't be its own dead-letter queue" };
  const count = Number(form.maxReceiveCount);
  if (form.deadLetterQueue && (!Number.isInteger(count) || count < 1 || count > 1000)) {
    return { problem: 'Received before it goes to the dead-letter queue: from 1 to 1,000 times' };
  }
  const policy: RedrivePolicy | null = form.deadLetterQueue
    ? { deadLetterTargetArn: `${queue.arn.slice(0, queue.arn.lastIndexOf(':') + 1)}${form.deadLetterQueue}`, maxReceiveCount: count }
    : null;
  const before = queue.redrivePolicy;
  if (policy?.deadLetterTargetArn !== before?.deadLetterTargetArn || policy?.maxReceiveCount !== before?.maxReceiveCount) body.redrivePolicy = policy;
  return { body };
}

/** The AWS CLI's commands for the queue, with an access key in the environment and AWS_ENDPOINT_URL_SQS the endpoint. */
export function cliCommands(queue: Pick<Queue, 'url'>): string {
  return [
    `aws sqs send-message --queue-url ${queue.url} --message-body '{"hello": "world"}'`,
    `aws sqs receive-message --queue-url ${queue.url} --wait-time-seconds 10`,
  ].join('\n');
}

/** The SQS endpoint a queue's URL is under: AWS_ENDPOINT_URL_SQS. */
export const endpointOf = (queue: Pick<Queue, 'url'>): string => new URL(queue.url).origin;

import { Queue, RedrivePolicy } from './queue.entity';
import { SqsError, invalidAttributeName, invalidAttributeValue, invalidParameter } from './sqs-error';

/** A queue's settings that SQS's attributes set, as a queue's row keeps them. */
export type QueueSettings = Pick<Queue, 'visibilityTimeout' | 'messageRetentionSeconds' | 'delaySeconds' | 'maximumMessageSize' | 'receiveWaitSeconds' | 'redrivePolicy'>;

/** SQS's attributes that are whole numbers, with their ranges and defaults, and the settings they are. */
export const NUMBER_ATTRIBUTES = {
  VisibilityTimeout: { min: 0, max: 43_200, default: 30, setting: 'visibilityTimeout' },
  MessageRetentionPeriod: { min: 60, max: 1_209_600, default: 345_600, setting: 'messageRetentionSeconds' },
  DelaySeconds: { min: 0, max: 900, default: 0, setting: 'delaySeconds' },
  MaximumMessageSize: { min: 1024, max: 1_048_576, default: 1_048_576, setting: 'maximumMessageSize' },
  ReceiveMessageWaitTimeSeconds: { min: 0, max: 20, default: 0, setting: 'receiveWaitSeconds' },
} as const satisfies Record<string, { min: number; max: number; default: number; setting: keyof QueueSettings }>;
type NumberAttribute = keyof typeof NUMBER_ATTRIBUTES;

/** The settings of a queue made with no attributes: SQS's defaults. */
export const DEFAULT_SETTINGS: QueueSettings = {
  visibilityTimeout: NUMBER_ATTRIBUTES.VisibilityTimeout.default,
  messageRetentionSeconds: NUMBER_ATTRIBUTES.MessageRetentionPeriod.default,
  delaySeconds: NUMBER_ATTRIBUTES.DelaySeconds.default,
  maximumMessageSize: NUMBER_ATTRIBUTES.MaximumMessageSize.default,
  receiveWaitSeconds: NUMBER_ATTRIBUTES.ReceiveMessageWaitTimeSeconds.default,
  redrivePolicy: null,
};

/** The attributes SQS answers but no one sets. */
const READ_ONLY = ['QueueArn', 'ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed', 'CreatedTimestamp', 'LastModifiedTimestamp'];

/** SQS's attributes for what FF's queues don't do, and why. */
const NOT_OFFERED: Record<string, string> = {
  FifoQueue: "FF's queues are standard queues: FIFO queues come later",
  ContentBasedDeduplication: "FF's queues are standard queues: FIFO queues come later",
  DeduplicationScope: "FF's queues are standard queues: FIFO queues come later",
  FifoThroughputLimit: "FF's queues are standard queues: FIFO queues come later",
  Policy: "FF's queues take no access policy: an access key of the account says what it reaches",
  KmsMasterKeyId: 'FF keeps messages in its own database, with no key of KMS',
  KmsDataKeyReusePeriodSeconds: 'FF keeps messages in its own database, with no key of KMS',
  RedriveAllowPolicy: 'Any queue of the account may name another as its dead-letter queue',
};

/** Every attribute name GetQueueAttributes takes, All aside. */
export const ATTRIBUTE_NAMES = [...READ_ONLY, ...Object.keys(NUMBER_ATTRIBUTES), 'RedrivePolicy', 'SqsManagedSseEnabled'];

/** A queue's ARN, as SQS's: in FF's region, under its account. */
export const queueArn = (region: string, accountId: string, name: string): string => `arn:aws:sqs:${region}:${accountId}:${name}`;

/** What a queue's ARN names; undefined for any other string. */
export function parseQueueArn(arn: string): { region: string; accountId: string; name: string } | undefined {
  const match = /^arn:aws:sqs:([a-z]{2}(?:-[a-z]+)+-\d+):(\d{12}):([A-Za-z0-9_-]{1,80})$/.exec(arn);
  return match ? { region: match[1], accountId: match[2], name: match[3] } : undefined;
}

/** A queue's name, as SQS's rule has it: 1 to 80 letters, digits, hyphens or underscores; a FIFO queue's ends with .fifo, which comes later. */
export function checkQueueName(name: unknown): string {
  if (typeof name !== 'string' || name === '') throw new SqsError(400, 'MissingParameter', 'The request must contain the parameter QueueName.');
  if (name.endsWith('.fifo')) throw invalidParameter("FF's queues are standard queues: FIFO queues come later.");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(name)) throw invalidParameter('Can only include alphanumeric characters, hyphens, or underscores. 1 to 80 in length');
  return name;
}

/** A redrive policy, as SetQueueAttributes takes it: JSON, its dead-letter queue another of the account's in FF's region; '' removes it. */
function redrivePolicyOf(value: string, region: string, accountId: string): RedrivePolicy | null {
  if (value === '') return null;
  let parsed: { deadLetterTargetArn?: unknown; maxReceiveCount?: unknown };
  try {
    parsed = JSON.parse(value) as typeof parsed;
  } catch {
    throw invalidAttributeValue('Value for parameter RedrivePolicy is invalid. Reason: Redrive policy is not a valid JSON map.');
  }
  const arn = typeof parsed.deadLetterTargetArn === 'string' ? parseQueueArn(parsed.deadLetterTargetArn) : undefined;
  if (!arn) throw invalidAttributeValue('Value for parameter RedrivePolicy is invalid. Reason: Invalid value for deadLetterTargetArn.');
  if (arn.region !== region || arn.accountId !== accountId) {
    throw invalidAttributeValue(`Value for parameter RedrivePolicy is invalid. Reason: The dead-letter queue must be the account's, in ${region}.`);
  }
  const count = Number(parsed.maxReceiveCount);
  if (!Number.isInteger(count) || count < 1 || count > 1000) {
    throw invalidAttributeValue('Value for parameter RedrivePolicy is invalid. Reason: maxReceiveCount must be a number from 1 to 1000.');
  }
  return { deadLetterTargetArn: parsed.deadLetterTargetArn as string, maxReceiveCount: count };
}

/**
 * The settings a CreateQueue's or a SetQueueAttributes' Attributes set: each a
 * string, as SQS takes them, in its range. An attribute for what FF's queues
 * don't do is refused, saying why; one that is only read, or unknown, as SQS
 * refuses it.
 */
export function settingsOf(attributes: unknown, region: string, accountId: string): Partial<QueueSettings> {
  if (attributes === undefined || attributes === null) return {};
  if (typeof attributes !== 'object' || Array.isArray(attributes)) throw invalidParameter('Attributes must be a map of attribute names to strings.');
  const settings: Partial<QueueSettings> = {};
  for (const [name, value] of Object.entries(attributes as Record<string, unknown>)) {
    if (typeof value !== 'string') throw invalidAttributeValue(`Invalid value for the parameter ${name}.`);
    if (name in NUMBER_ATTRIBUTES) {
      const { min, max, setting } = NUMBER_ATTRIBUTES[name as NumberAttribute];
      const number = Number(value);
      if (!/^\d+$/.test(value) || number < min || number > max) throw invalidAttributeValue(`Invalid value for the parameter ${name}.`);
      settings[setting] = number;
    } else if (name === 'RedrivePolicy') {
      settings.redrivePolicy = redrivePolicyOf(value, region, accountId);
    } else if (name === 'SqsManagedSseEnabled') {
      if (value !== 'false') throw invalidAttributeValue('FF keeps messages in its own database, encrypted with its disk, not with keys of SQS: SqsManagedSseEnabled is false.');
    } else if (name in NOT_OFFERED) {
      throw invalidAttributeName(`${NOT_OFFERED[name]}: ${name} is not taken.`);
    } else {
      throw invalidAttributeName(`Unknown Attribute ${name}.`);
    }
  }
  return settings;
}

/** Whether two redrive policies are the same, field by field: the database's JSON keeps its keys in an order of its own. */
const samePolicy = (a: RedrivePolicy | null, b: RedrivePolicy | null): boolean =>
  a === b || (a !== null && b !== null && a.deadLetterTargetArn === b.deadLetterTargetArn && a.maxReceiveCount === b.maxReceiveCount);

/** A redrive policy as SQS writes it: JSON, its dead-letter queue first. */
const policyText = (policy: RedrivePolicy): string => JSON.stringify({ deadLetterTargetArn: policy.deadLetterTargetArn, maxReceiveCount: policy.maxReceiveCount });

/** The first setting of the given ones a queue has another value for: CreateQueue's QueueNameExists names it. */
export function differentSetting(queue: QueueSettings, settings: Partial<QueueSettings>): string | undefined {
  for (const [name, { setting }] of Object.entries(NUMBER_ATTRIBUTES)) {
    if (settings[setting] !== undefined && settings[setting] !== queue[setting]) return name;
  }
  if (settings.redrivePolicy !== undefined && !samePolicy(settings.redrivePolicy, queue.redrivePolicy)) return 'RedrivePolicy';
  return undefined;
}

/** How many of a queue's messages are in each state, as GetQueueAttributes counts them. */
export interface QueueCounts {
  visible: number;
  notVisible: number;
  delayed: number;
}

/** GetQueueAttributes' answer: the attributes asked for, All or names, as SQS writes them, every value a string. */
export function attributesOf(queue: Queue, counts: QueueCounts, names: unknown, region: string): Record<string, string> {
  const asked = Array.isArray(names) ? (names as unknown[]) : [];
  for (const name of asked) {
    if (typeof name !== 'string' || (name !== 'All' && !ATTRIBUTE_NAMES.includes(name))) throw invalidAttributeName(`Unknown Attribute ${String(name)}.`);
  }
  const all: Record<string, string> = {
    QueueArn: queueArn(region, queue.accountId, queue.name),
    ApproximateNumberOfMessages: String(counts.visible),
    ApproximateNumberOfMessagesNotVisible: String(counts.notVisible),
    ApproximateNumberOfMessagesDelayed: String(counts.delayed),
    CreatedTimestamp: String(Math.floor(queue.createdAt.getTime() / 1000)),
    LastModifiedTimestamp: String(Math.floor(queue.updatedAt.getTime() / 1000)),
    VisibilityTimeout: String(queue.visibilityTimeout),
    MessageRetentionPeriod: String(queue.messageRetentionSeconds),
    DelaySeconds: String(queue.delaySeconds),
    MaximumMessageSize: String(queue.maximumMessageSize),
    ReceiveMessageWaitTimeSeconds: String(queue.receiveWaitSeconds),
    SqsManagedSseEnabled: 'false',
    ...(queue.redrivePolicy ? { RedrivePolicy: policyText(queue.redrivePolicy) } : {}),
  };
  if (asked.includes('All')) return all;
  return Object.fromEntries(Object.entries(all).filter(([name]) => asked.includes(name)));
}

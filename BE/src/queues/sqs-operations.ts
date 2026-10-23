import { randomUUID } from 'node:crypto';
import { AuditAction, AuditService } from '../audit/audit.service';
import { Actor } from '../common/request-context';
import { PlanView } from '../plans/plan-limits';
import { KeyNames, reachesQueue } from '../storage/key-reach';
import { CustomerQueues, MessageMeta, Outgoing, Received } from './customer-queues';
import { QueueEvents } from './queue-events';
import { QueueStore } from './queue-store';
import { Queue } from './queue.entity';
import { attributesOf, checkQueueName, queueArn, settingsOf } from './sqs-attributes';
import { SqsError, accessDenied, invalidParameter, missingParameter, overLimit, queueDoesNotExist, receiptHandleIsInvalid, unsupportedOperation } from './sqs-error';
import {
  MessageAttribute,
  Receipt,
  attributesMd5,
  checkBody,
  checkMessageAttributes,
  checkSystemAttributes,
  md5Hex,
  messageSize,
  parseReceiptHandle,
  receiptHandle,
} from './sqs-messages';

/** Who calls, as their key and their account's plan say, and when. */
export interface Caller {
  accountId: string;
  keyId: string;
  readOnly: boolean;
  plan: PlanView;
  /** Aborted when the client goes: a long poll ends. */
  signal?: AbortSignal;
  /** The endpoint the caller reached, which the queues' URLs answered to it begin with; FF_SQS_BASE when none is given. */
  endpoint?: string;
  /** What the caller's key names of the account's; none for a caller that reaches every queue, as FF's API does. */
  reach?: KeyNames;
  /** Who the audit log names for the caller's changes, and from where; by default, the request's caller, as FF's API's. */
  actor?: Actor;
  ip?: string;
}

type Input = Record<string, unknown>;
type Output = Record<string, unknown>;

/** The operations a read-only key may call, as IAM's read access level has them. */
export const READ_OPERATIONS = new Set(['GetQueueUrl', 'GetQueueAttributes', 'ListQueues', 'ReceiveMessage']);

/** SQS's operations FF doesn't offer, which answer UnsupportedOperation. */
const NOT_OFFERED = new Set([
  'AddPermission',
  'RemovePermission',
  'TagQueue',
  'UntagQueue',
  'ListQueueTags',
  'ListDeadLetterSourceQueues',
  'StartMessageMoveTask',
  'CancelMessageMoveTask',
  'ListMessageMoveTasks',
]);

/** The operations that send messages: they need the account's credit, as an upload to a bucket does. */
export const SENDING_OPERATIONS = new Set(['SendMessage', 'SendMessageBatch']);

/** SQS's most entries in a batch, and the most a batch's messages hold together. */
const MAX_BATCH = 10;
const MAX_BATCH_BYTES = 1_048_576;

/** A megabyte, as the plans count what messages hold. */
const MB = 1024 * 1024;

/** How long a long poll waits for news before it asks the database again: delays end and visibility timeouts expire without news. */
const POLL_MS = 1000;

const text = (input: Input, name: string): string | undefined => {
  const value = input[name];
  return typeof value === 'string' ? value : undefined;
};

/** A value as an error names it: a string as it is, anything else as JSON. */
const shown = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));

/** A list parameter's items; none when it isn't a list. */
const list = (value: unknown): unknown[] => (Array.isArray(value) ? (value as unknown[]) : []);

/** A whole number parameter in its range, or the default when it isn't given. */
function integer(input: Input, name: string, min: number, max: number, otherwise: number): number {
  const value = input[name];
  if (value === undefined || value === null) return otherwise;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalidParameter(`Value ${shown(value)} for parameter ${name} is invalid. Reason: Must be between ${min} and ${max}.`);
  }
  return value;
}

/** Whether a receive asked for an attribute: All, its name, or a prefix ending in .*. */
const asked = (names: unknown, name: string): boolean =>
  Array.isArray(names) &&
  names.some((wanted) => typeof wanted === 'string' && (wanted === 'All' || wanted === '.*' || wanted === name || (wanted.endsWith('.*') && name.startsWith(wanted.slice(0, -1)))));

/**
 * Amazon SQS's operations on an account's standard queues, as its JSON
 * protocol takes them: the caller's key reaches the account's queues, a
 * read-only one only reading them (ADR 0010). Queues' URLs are
 * <endpoint>/<account>/<name>, under the endpoint the caller reached; a URL
 * names its queue by its path, whatever its host; another account's queue is
 * one that doesn't exist. A long poll waits for its queue's news, from any
 * backend.
 */
export class SqsOperations {
  constructor(
    private readonly queues: CustomerQueues,
    private readonly store: QueueStore,
    private readonly events: QueueEvents,
    private readonly audit: AuditService,
    private readonly base: string,
    private readonly region: string,
  ) {}

  /** A change of a queue, in the audit log, whichever way it came. */
  private record(caller: Caller, action: AuditAction, queue: string, details?: Record<string, unknown>): Promise<void> {
    return this.audit.record({ accountId: caller.accountId, action, resource: `queue:${queue}`, ...(details ? { details } : {}), ...(caller.actor ? { actor: caller.actor } : {}), ...(caller.ip ? { ip: caller.ip } : {}) });
  }

  /** The operation's answer, by SQS's name for it. */
  async run(operation: string, input: Input, caller: Caller): Promise<Output> {
    if (NOT_OFFERED.has(operation)) throw unsupportedOperation(`FF's queues don't offer ${operation}.`);
    const handler = this.handlers[operation];
    if (!handler) throw unsupportedOperation(`The operation ${operation || '(none)'} is not one of SQS's that FF offers.`);
    if (caller.readOnly && !READ_OPERATIONS.has(operation)) throw accessDenied(`The access key is read-only: it can't call ${operation}.`);
    return handler(input, caller);
  }

  private readonly handlers: Record<string, (input: Input, caller: Caller) => Promise<Output>> = {
    CreateQueue: (input, caller) => this.createQueue(input, caller),
    GetQueueUrl: (input, caller) => this.getQueueUrl(input, caller),
    ListQueues: (input, caller) => this.listQueues(input, caller),
    GetQueueAttributes: async (input, caller) => {
      const queue = await this.queueOf(input, caller);
      return { Attributes: attributesOf(queue, await this.queues.counts(queue, new Date()), input.AttributeNames, this.region) };
    },
    SetQueueAttributes: async (input, caller) => {
      const queue = await this.queueOf(input, caller);
      if (input.Attributes === undefined) throw missingParameter('Attributes');
      const settings = settingsOf(input.Attributes, this.region, caller.accountId);
      await this.queues.setAttributes(queue, settings, this.region);
      await this.record(caller, 'queue.update', queue.name, { attributes: settings });
      return {};
    },
    DeleteQueue: async (input, caller) => {
      const queue = await this.queueOf(input, caller);
      await this.queues.delete(queue);
      await this.record(caller, 'queue.delete', queue.name);
      return {};
    },
    PurgeQueue: async (input, caller) => {
      const queue = await this.queueOf(input, caller);
      await this.queues.purge(queue);
      await this.record(caller, 'queue.purge', queue.name);
      return {};
    },
    SendMessage: (input, caller) => this.sendMessage(input, caller),
    SendMessageBatch: (input, caller) => this.sendMessageBatch(input, caller),
    ReceiveMessage: (input, caller) => this.receiveMessage(input, caller),
    DeleteMessage: async (input, caller) => {
      const queue = await this.queueOf(input, caller);
      await this.queues.deleteMessages(queue, [this.receipt(input.ReceiptHandle)]);
      return {};
    },
    DeleteMessageBatch: async (input, caller) => {
      const queue = await this.queueOf(input, caller);
      return this.batch(input, async (entry) => {
        await this.queues.deleteMessages(queue, [this.receipt(entry.ReceiptHandle)]);
        return {};
      });
    },
    ChangeMessageVisibility: async (input, caller) => {
      const queue = await this.queueOf(input, caller);
      await this.changeVisibility(queue, input);
      return {};
    },
    ChangeMessageVisibilityBatch: async (input, caller) => {
      const queue = await this.queueOf(input, caller);
      return this.batch(input, async (entry) => {
        await this.changeVisibility(queue, entry);
        return {};
      });
    },
  };

  /** A queue's URL, as SQS's: <endpoint>/<account>/<name>, under the endpoint given, else FF_SQS_BASE. */
  urlOf(queue: Pick<Queue, 'accountId' | 'name'>, endpoint = this.base): string {
    return `${endpoint}/${queue.accountId}/${queue.name}`;
  }

  /** The caller's account's queue a URL names, whatever its host: by its path, /<account>/<name>; another account's doesn't exist for it. */
  private async queueOf(input: Input, caller: Caller): Promise<Queue> {
    const url = text(input, 'QueueUrl');
    if (url === undefined) throw missingParameter('QueueUrl');
    let path: string;
    try {
      path = new URL(url).pathname;
    } catch {
      path = url;
    }
    const match = /^\/(\d{12})\/([A-Za-z0-9_-]{1,80})\/?$/.exec(path);
    if (!match || match[1] !== caller.accountId) throw queueDoesNotExist();
    this.reach(caller, match[2], url);
    const queue = await this.queues.find(caller.accountId, match[2]);
    if (!queue) throw queueDoesNotExist();
    return queue;
  }

  /** A queue the caller's key doesn't name, as IAM refuses one: before it is looked for, whether it is there or not. */
  private reach(caller: Caller, name: string, resource: string): void {
    if (caller.reach && !reachesQueue(caller.reach, name)) {
      throw accessDenied(`Access to the resource ${resource} is denied: the access key names the queues it reaches, and not this one.`);
    }
  }

  private async createQueue(input: Input, caller: Caller): Promise<Output> {
    const name = checkQueueName(input.QueueName);
    this.reach(caller, name, this.urlOf({ accountId: caller.accountId, name }, caller.endpoint));
    if (input.tags !== undefined && Object.keys(input.tags as object).length > 0) throw invalidParameter("FF's queues have no tags yet.");
    const settings = settingsOf(input.Attributes, this.region, caller.accountId);
    const { queue, created } = await this.queues.create(caller.accountId, name, settings, { limit: caller.plan.limits.queues, name: caller.plan.name }, this.region);
    if (created) await this.record(caller, 'queue.create', queue.name, { attributes: settings });
    return { QueueUrl: this.urlOf(queue, caller.endpoint) };
  }

  private async getQueueUrl(input: Input, caller: Caller): Promise<Output> {
    const name = text(input, 'QueueName');
    if (!name) throw missingParameter('QueueName');
    const owner = text(input, 'QueueOwnerAWSAccountId');
    if (owner !== undefined && owner !== caller.accountId) throw queueDoesNotExist();
    this.reach(caller, name, this.urlOf({ accountId: caller.accountId, name }, caller.endpoint));
    const queue = await this.queues.find(caller.accountId, name);
    if (!queue) throw queueDoesNotExist();
    return { QueueUrl: this.urlOf(queue, caller.endpoint) };
  }

  private async listQueues(input: Input, caller: Caller): Promise<Output> {
    const max = integer(input, 'MaxResults', 1, 1000, 1000);
    const page = await this.queues.list(caller.accountId, text(input, 'QueueNamePrefix') ?? '', max, text(input, 'NextToken'));
    // A key that names its queues lists those alone.
    const reached = page.queues.filter((queue) => !caller.reach || reachesQueue(caller.reach, queue.name));
    return {
      ...(reached.length ? { QueueUrls: reached.map((queue) => this.urlOf(queue, caller.endpoint)) } : {}),
      ...(page.nextToken ? { NextToken: page.nextToken } : {}),
    };
  }

  /** A message to keep, checked as SQS checks one, its size the queue's maximum at most. */
  private outgoing(queue: Queue, entry: Input, caller: Caller): Outgoing {
    const body = checkBody(entry.MessageBody);
    const messageAttributes = checkMessageAttributes(entry.MessageAttributes);
    const systemAttributes = checkSystemAttributes(entry.MessageSystemAttributes);
    const sizeBytes = messageSize(body, messageAttributes);
    if (sizeBytes > queue.maximumMessageSize) {
      throw invalidParameter(`One or more parameters are invalid. Reason: Message must be shorter than ${queue.maximumMessageSize} bytes.`);
    }
    if (entry.MessageDeduplicationId !== undefined || entry.MessageGroupId !== undefined) {
      throw invalidParameter("The request includes parameters that are not valid for this queue type: FF's queues are standard queues.");
    }
    const meta: MessageMeta = {
      senderId: caller.keyId,
      ...(Object.keys(messageAttributes).length ? { messageAttributes } : {}),
      ...(Object.keys(systemAttributes).length ? { systemAttributes } : {}),
    };
    return { messageId: randomUUID(), body, meta, sizeBytes, delaySeconds: integer(entry, 'DelaySeconds', 0, 900, queue.delaySeconds) };
  }

  /** What the account's messages may hold together, the plan's; past it, sending is refused until some go. */
  private async checkRoom(caller: Caller, bytes: number): Promise<void> {
    const room = caller.plan.limits.queueStorageMb * MB;
    if ((await this.store.accountBytes(caller.accountId)) + bytes > room) {
      throw overLimit(
        `The account's messages hold ${caller.plan.limits.queueStorageMb} MB together, the ${caller.plan.name} plan's limit, its functions' asynchronous calls among them: try again once some are deleted.`,
      );
    }
  }

  /** What SendMessage answers of a message kept: its ID, and the MD5 sums the SDKs check. */
  private sent(message: Outgoing): Output {
    const attributes = attributesMd5(message.meta.messageAttributes ?? {});
    const system = attributesMd5(message.meta.systemAttributes ?? {});
    return {
      MessageId: message.messageId,
      MD5OfMessageBody: md5Hex(message.body),
      ...(attributes ? { MD5OfMessageAttributes: attributes } : {}),
      ...(system ? { MD5OfMessageSystemAttributes: system } : {}),
    };
  }

  private async sendMessage(input: Input, caller: Caller): Promise<Output> {
    const queue = await this.queueOf(input, caller);
    const message = this.outgoing(queue, input, caller);
    await this.checkRoom(caller, message.sizeBytes);
    await this.queues.send(queue, [message], new Date());
    return this.sent(message);
  }

  private async sendMessageBatch(input: Input, caller: Caller): Promise<Output> {
    const queue = await this.queueOf(input, caller);
    const entries = this.entries(input);
    const kept: Array<{ id: string; message: Outgoing }> = [];
    const failed: Output[] = [];
    for (const entry of entries) {
      try {
        kept.push({ id: entry.Id as string, message: this.outgoing(queue, entry, caller) });
      } catch (error) {
        if (!(error instanceof SqsError)) throw error;
        failed.push({ Id: entry.Id, Code: error.type, SenderFault: true, Message: error.message });
      }
    }
    const bytes = kept.reduce((sum, { message }) => sum + message.sizeBytes, 0);
    if (bytes > MAX_BATCH_BYTES) {
      throw new SqsError(400, 'BatchRequestTooLong', `Batch requests cannot be longer than ${MAX_BATCH_BYTES} bytes. You have sent ${bytes} bytes.`);
    }
    await this.checkRoom(caller, bytes);
    await this.queues.send(queue, kept.map(({ message }) => message), new Date());
    return { Successful: kept.map(({ id, message }) => ({ Id: id, ...this.sent(message) })), Failed: failed };
  }

  /** A batch's entries, as SQS checks them: 1 to 10, each with an ID of its own. */
  private entries(input: Input): Input[] {
    const entries = input.Entries;
    if (!Array.isArray(entries) || entries.length === 0) throw new SqsError(400, 'EmptyBatchRequest', 'The batch request doesn\'t contain any entries.');
    if (entries.length > MAX_BATCH) throw new SqsError(400, 'TooManyEntriesInBatchRequest', `Maximum number of entries per request are ${MAX_BATCH}. You have sent ${entries.length}.`);
    const ids = new Set<string>();
    for (const entry of entries as Input[]) {
      const id = entry?.Id;
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
        throw new SqsError(400, 'InvalidBatchEntryId', 'A batch entry id can only contain alphanumeric characters, hyphens and underscores. It can be at most 80 letters long.');
      }
      if (ids.has(id)) throw new SqsError(400, 'BatchEntryIdsNotDistinct', `Id ${id} repeated.`);
      ids.add(id);
    }
    return entries as Input[];
  }

  /** Each entry of a batch, its failure SQS's failed entry rather than the batch's. */
  private async batch(input: Input, each: (entry: Input) => Promise<Output>): Promise<Output> {
    const successful: Output[] = [];
    const failed: Output[] = [];
    for (const entry of this.entries(input)) {
      try {
        successful.push({ Id: entry.Id, ...(await each(entry)) });
      } catch (error) {
        if (!(error instanceof SqsError)) throw error;
        failed.push({ Id: entry.Id, Code: error.type, SenderFault: error.fault === 'Sender', Message: error.message });
      }
    }
    return { Successful: successful, Failed: failed };
  }

  private receipt(handle: unknown): Receipt {
    if (handle === undefined) throw missingParameter('ReceiptHandle');
    const receipt = parseReceiptHandle(handle);
    if (!receipt) throw receiptHandleIsInvalid(shown(handle));
    return receipt;
  }

  private async changeVisibility(queue: Queue, input: Input): Promise<void> {
    const receipt = this.receipt(input.ReceiptHandle);
    if (input.VisibilityTimeout === undefined) throw missingParameter('VisibilityTimeout');
    const timeout = integer(input, 'VisibilityTimeout', 0, 43_200, 0);
    if (!(await this.queues.changeVisibility(queue, receipt, timeout, new Date()))) {
      throw new SqsError(400, 'MessageNotInflight', 'The message referred to is not in flight.', 'AWS.SimpleQueueService.MessageNotInflight');
    }
  }

  /**
   * Up to MaxNumberOfMessages messages, each hidden for the visibility timeout;
   * with a wait, a long poll: none now, it waits for its queue's news, up to
   * the wait, answering as soon as there are messages.
   */
  private async receiveMessage(input: Input, caller: Caller): Promise<Output> {
    const queue = await this.queueOf(input, caller);
    const max = integer(input, 'MaxNumberOfMessages', 1, 10, 1);
    const visibility = integer(input, 'VisibilityTimeout', 0, 43_200, queue.visibilityTimeout);
    const wait = integer(input, 'WaitTimeSeconds', 0, 20, queue.receiveWaitSeconds);
    const deadline = Date.now() + wait * 1000;
    let received = await this.queues.receive(queue, max, visibility, new Date());
    while (received.length === 0 && Date.now() < deadline && !caller.signal?.aborted) {
      await this.events.wait(queue.id, Math.min(POLL_MS, deadline - Date.now()), caller.signal);
      received = await this.queues.receive(queue, max, visibility, new Date());
    }
    const systemNames = [...list(input.AttributeNames), ...list(input.MessageSystemAttributeNames)];
    return received.length ? { Messages: received.map((message) => this.message(message, systemNames, input.MessageAttributeNames)) } : {};
  }

  /** A message as ReceiveMessage answers it: the attributes asked for, and the MD5 sums of what is answered. */
  private message(message: Received, systemNames: unknown[], attributeNames: unknown): Output {
    const system: Record<string, string> = {
      SenderId: message.meta.senderId ?? '',
      SentTimestamp: String(message.sentAt.getTime()),
      ApproximateReceiveCount: String(message.receiveCount),
      ApproximateFirstReceiveTimestamp: String(message.firstReceivedAt.getTime()),
      ...(message.meta.systemAttributes?.AWSTraceHeader?.StringValue ? { AWSTraceHeader: message.meta.systemAttributes.AWSTraceHeader.StringValue } : {}),
    };
    const attributes = Object.fromEntries(Object.entries(system).filter(([name]) => asked(systemNames, name)));
    const messageAttributes: Record<string, MessageAttribute> = Object.fromEntries(
      Object.entries(message.meta.messageAttributes ?? {}).filter(([name]) => asked(attributeNames, name)),
    );
    const md5 = attributesMd5(messageAttributes);
    return {
      MessageId: message.messageId,
      ReceiptHandle: receiptHandle({ id: message.id, receiveCount: message.receiveCount, messageId: message.messageId }),
      MD5OfBody: md5Hex(message.body),
      Body: message.body,
      ...(Object.keys(attributes).length ? { Attributes: attributes } : {}),
      ...(md5 ? { MD5OfMessageAttributes: md5, MessageAttributes: messageAttributes } : {}),
    };
  }

  /** A queue's ARN, for those who name it as a destination or a dead-letter queue. */
  arnOf(queue: Pick<Queue, 'accountId' | 'name'>): string {
    return queueArn(this.region, queue.accountId, queue.name);
  }
}

import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Principal } from '../auth/principal';
import { CreditService } from '../billing/credit.service';
import { PlansService } from '../plans/plans.service';
import { StorageDirectory } from '../storage/storage-directory.service';
import { CustomerQueues } from './customer-queues';
import { CreateQueueDto, QueueAttributesDto, QueueView, ReceiveMessagesDto, ReceivedMessageView, SendMessageDto, SentMessageView, UpdateQueueDto } from './dto/queue.dto';
import { Queue } from './queue.entity';
import { QueueCounts, queueArn } from './sqs-attributes';
import { SqsError } from './sqs-error';
import { MessageAttribute } from './sqs-messages';
import { Caller, SqsOperations } from './sqs-operations';

type Output = Record<string, unknown>;

/** The SQS attributes the API's names set, each as SQS writes it, a string; a redrive policy's null removes it. */
function sqsAttributes(dto: QueueAttributesDto): Record<string, string> {
  const attributes: Record<string, string> = {};
  const numbers: Array<[keyof QueueAttributesDto, string]> = [
    ['visibilityTimeout', 'VisibilityTimeout'],
    ['messageRetentionPeriod', 'MessageRetentionPeriod'],
    ['delaySeconds', 'DelaySeconds'],
    ['maximumMessageSize', 'MaximumMessageSize'],
    ['receiveMessageWaitTimeSeconds', 'ReceiveMessageWaitTimeSeconds'],
  ];
  for (const [field, name] of numbers) if (typeof dto[field] === 'number') attributes[name] = String(dto[field]);
  if (dto.redrivePolicy === null) attributes.RedrivePolicy = '';
  else if (dto.redrivePolicy) attributes.RedrivePolicy = JSON.stringify({ deadLetterTargetArn: dto.redrivePolicy.deadLetterTargetArn, maxReceiveCount: dto.redrivePolicy.maxReceiveCount });
  return attributes;
}

/**
 * Customers' queues in FF's API (ADR 0010), beside the SQS endpoint: each
 * route runs SQS's own operation, so that the API and AWS's SDKs see the same
 * queues the same way, with the caller's whole account, as a user or an API
 * key acts for it. SQS's errors come as HTTP's: a queue that isn't there
 * 404, a name taken 409, the plan's limits 400 or 429, a value refused 400.
 * Sending and receiving, for debugging, are checked as at the SQS endpoint:
 * the account's databases, buckets and queues on, and its credit to send;
 * deleting goes on, as a bucket's deletion does.
 */
@Injectable()
export class QueuesService {
  private readonly base: string;
  private readonly region: string;

  constructor(
    private readonly operations: SqsOperations,
    private readonly queues: CustomerQueues,
    private readonly plans: PlansService,
    private readonly credit: CreditService,
    private readonly directory: StorageDirectory,
    config: ConfigService,
  ) {
    const sqs = config.getOrThrow<{ base: string; region: string }>('sqs');
    this.base = sqs.base;
    this.region = sqs.region;
  }

  /** The account's queues, by name, each with its messages counted. */
  async list(accountId: string): Promise<QueueView[]> {
    const { queues } = await this.queues.list(accountId, '', 1000);
    const counts = await this.queues.countsOf(accountId, new Date());
    return queues.map((queue) => this.view(queue, counts.get(queue.id)));
  }

  async get(accountId: string, name: string): Promise<QueueView> {
    const queue = await this.find(accountId, name);
    return this.view(queue, await this.queues.counts(queue, new Date()));
  }

  /** As SQS's CreateQueue, but for a name the account has already: 409, whatever its attributes. */
  async create(principal: Principal, dto: CreateQueueDto): Promise<QueueView> {
    if (await this.queues.find(principal.accountId, dto.name)) throw new ConflictException(`The account has a queue named "${dto.name}" already`);
    const { name, ...attributes } = dto;
    await this.run('CreateQueue', { QueueName: name, Attributes: sqsAttributes(attributes) }, principal, name, HttpStatus.BAD_REQUEST);
    return this.get(principal.accountId, name);
  }

  /** As SQS's SetQueueAttributes: what is given changes, the rest stays. */
  async update(principal: Principal, name: string, dto: UpdateQueueDto): Promise<QueueView> {
    const queue = await this.find(principal.accountId, name);
    await this.run('SetQueueAttributes', { QueueUrl: this.urlOf(queue), Attributes: sqsAttributes(dto) }, principal, name);
    return this.get(principal.accountId, name);
  }

  async remove(principal: Principal, name: string): Promise<void> {
    const queue = await this.find(principal.accountId, name);
    await this.run('DeleteQueue', { QueueUrl: this.urlOf(queue) }, principal, name);
  }

  /** Deletes every message, as SQS's PurgeQueue; deleting goes on whatever the account's state, as a bucket's deletion does. */
  async purge(principal: Principal, name: string): Promise<void> {
    const queue = await this.find(principal.accountId, name);
    await this.run('PurgeQueue', { QueueUrl: this.urlOf(queue) }, principal, name);
  }

  /** As SQS's SendMessage: checked as there, the account's credit and the plan's room for messages among the checks. */
  async send(principal: Principal, name: string, dto: SendMessageDto): Promise<SentMessageView> {
    const queue = await this.find(principal.accountId, name);
    await this.open(principal.accountId);
    await this.credit.admit(principal.accountId);
    const attributes = Object.fromEntries(
      Object.entries(dto.attributes ?? {}).map(([attribute, value]): [string, MessageAttribute] => [
        attribute,
        { DataType: value?.dataType, StringValue: value?.stringValue, BinaryValue: value?.binaryValue },
      ]),
    );
    const sent = await this.run(
      'SendMessage',
      { QueueUrl: this.urlOf(queue), MessageBody: dto.body, ...(dto.attributes ? { MessageAttributes: attributes } : {}), ...(dto.delaySeconds !== undefined ? { DelaySeconds: dto.delaySeconds } : {}) },
      principal,
      name,
      HttpStatus.TOO_MANY_REQUESTS,
    );
    return { messageId: sent.MessageId as string, md5OfBody: sent.MD5OfMessageBody as string };
  }

  /** As SQS's ReceiveMessage: each message hidden for its visibility timeout and its receive counted, as any receive; a long poll as there. */
  async receive(principal: Principal, name: string, dto: ReceiveMessagesDto, signal?: AbortSignal): Promise<ReceivedMessageView[]> {
    const queue = await this.find(principal.accountId, name);
    await this.open(principal.accountId);
    const answer = await this.run(
      'ReceiveMessage',
      {
        QueueUrl: this.urlOf(queue),
        ...(dto.maxMessages !== undefined ? { MaxNumberOfMessages: dto.maxMessages } : {}),
        ...(dto.visibilityTimeout !== undefined ? { VisibilityTimeout: dto.visibilityTimeout } : {}),
        ...(dto.waitTimeSeconds !== undefined ? { WaitTimeSeconds: dto.waitTimeSeconds } : {}),
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['All'],
      },
      principal,
      name,
      HttpStatus.BAD_REQUEST,
      signal,
    );
    return ((answer.Messages as Output[] | undefined) ?? []).map((message) => {
      const system = (message.Attributes ?? {}) as Record<string, string>;
      const attributes = (message.MessageAttributes ?? {}) as Record<string, MessageAttribute>;
      return {
        messageId: message.MessageId as string,
        receiptHandle: message.ReceiptHandle as string,
        body: message.Body as string,
        attributes: Object.fromEntries(
          Object.entries(attributes).map(([attribute, value]) => [
            attribute,
            { dataType: value.DataType, ...(value.StringValue !== undefined ? { stringValue: value.StringValue } : { binaryValue: value.BinaryValue }) },
          ]),
        ),
        receiveCount: Number(system.ApproximateReceiveCount),
        senderId: system.SenderId,
        sentAt: new Date(Number(system.SentTimestamp)),
      };
    });
  }

  /** As SQS's DeleteMessage: by the handle of its last receive; an older one deletes nothing. */
  async deleteMessage(principal: Principal, name: string, receiptHandle: string): Promise<void> {
    const queue = await this.find(principal.accountId, name);
    await this.run('DeleteMessage', { QueueUrl: this.urlOf(queue), ReceiptHandle: receiptHandle }, principal, name);
  }

  private async find(accountId: string, name: string): Promise<Queue> {
    const queue = await this.queues.find(accountId, name);
    if (!queue) throw new NotFoundException(`The account has no queue named "${name}"`);
    return queue;
  }

  /** Messages are the account's data: none sent, received or deleted while FF has its databases, buckets and queues off. */
  private async open(accountId: string): Promise<void> {
    const account = await this.directory.account(accountId);
    if (account?.storageDisabledAt) throw new ForbiddenException(`FF turned the account's databases, buckets and queues off: ${account.storageDisabledReason}`);
  }

  /** SQS's operation for the caller's account, as the API's caller: its errors as HTTP's, the plan's limits answering `overLimit`. */
  private async run(operation: string, input: Output, principal: Principal, name: string, overLimit = HttpStatus.BAD_REQUEST, signal?: AbortSignal): Promise<Output> {
    const caller: Caller = {
      accountId: principal.accountId,
      keyId: principal.keyId ?? (principal.userId ? `user:${principal.userId}` : 'api'),
      readOnly: false,
      plan: await this.plans.forAccount(principal.accountId),
      endpoint: this.base,
      signal,
    };
    try {
      return await this.operations.run(operation, input, caller);
    } catch (error) {
      if (!(error instanceof SqsError)) throw error;
      switch (error.type) {
        case 'QueueDoesNotExist':
          throw new NotFoundException(`The account has no queue named "${name}"`);
        case 'QueueNameExists':
          throw new ConflictException(error.message);
        case 'AccessDenied':
          throw new ForbiddenException(error.message);
        case 'OverLimit':
          throw new HttpException({ statusCode: overLimit, message: error.message }, overLimit);
        default:
          if (error.status >= 500) throw error;
          throw new BadRequestException(`${error.type}: ${error.message}`);
      }
    }
  }

  private urlOf(queue: Pick<Queue, 'accountId' | 'name'>): string {
    return `${this.base}/${queue.accountId}/${queue.name}`;
  }

  private view(queue: Queue, counts: QueueCounts = { visible: 0, notVisible: 0, delayed: 0 }): QueueView {
    return {
      name: queue.name,
      url: this.urlOf(queue),
      arn: queueArn(this.region, queue.accountId, queue.name),
      visibilityTimeout: queue.visibilityTimeout,
      messageRetentionPeriod: queue.messageRetentionSeconds,
      delaySeconds: queue.delaySeconds,
      maximumMessageSize: queue.maximumMessageSize,
      receiveMessageWaitTimeSeconds: queue.receiveWaitSeconds,
      redrivePolicy: queue.redrivePolicy ? { deadLetterTargetArn: queue.redrivePolicy.deadLetterTargetArn, maxReceiveCount: queue.redrivePolicy.maxReceiveCount } : null,
      messages: { available: counts.visible, inFlight: counts.notVisible, delayed: counts.delayed },
      sizeBytes: Number(queue.sizeBytes),
      createdAt: queue.createdAt,
      updatedAt: queue.updatedAt,
    };
  }
}

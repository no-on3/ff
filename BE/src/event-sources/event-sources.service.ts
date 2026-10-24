import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { functionArn } from '../functions/arns';
import { Function } from '../functions/entities/function.entity';
import { FunctionsService } from '../functions/functions.service';
import { PlansService } from '../plans/plans.service';
import { CustomerQueues } from '../queues/customer-queues';
import { Queue } from '../queues/queue.entity';
import { parseQueueArn, queueArn } from '../queues/sqs-attributes';
import { CreateEventSourceDto, EventSourceSettingsDto, EventSourceView, REPORT_BATCH_ITEM_FAILURES, UpdateEventSourceDto } from './dto/event-source.dto';
import { EventSourceMapping } from './event-source-mapping.entity';
import { EventSourcePoller } from './event-source-poller';

/** The settings a mapping keeps, as its columns name them. */
type Settings = Pick<EventSourceMapping, 'batchSize' | 'maximumBatchingWindowInSeconds' | 'reportBatchItemFailures' | 'maximumConcurrency' | 'enabled'>;

/** Lambda's defaults for a new mapping of an SQS queue. */
const DEFAULTS: Settings = { batchSize: 10, maximumBatchingWindowInSeconds: 0, reportBatchItemFailures: false, maximumConcurrency: null, enabled: true };

/** The settings a body gives over `current`: what it leaves out stays; a null or empty scalingConfig removes the maximum. */
function settingsOf(dto: EventSourceSettingsDto, current: Settings): Settings {
  return {
    batchSize: dto.batchSize ?? current.batchSize,
    maximumBatchingWindowInSeconds: dto.maximumBatchingWindowInSeconds ?? current.maximumBatchingWindowInSeconds,
    reportBatchItemFailures: dto.functionResponseTypes ? dto.functionResponseTypes.includes(REPORT_BATCH_ITEM_FAILURES) : current.reportBatchItemFailures,
    maximumConcurrency: dto.scalingConfig === undefined ? current.maximumConcurrency : (dto.scalingConfig?.maximumConcurrency ?? null),
    enabled: dto.enabled ?? current.enabled,
  };
}

/** Over 10 messages a batch, Lambda needs a window to gather them, and says so in these words. */
function checkBatch(settings: Settings): void {
  if (settings.batchSize > 10 && settings.maximumBatchingWindowInSeconds === 0) {
    throw new BadRequestException('Maximum batch window in seconds must be greater than 0 if maximum batch size is greater than 10');
  }
}

/** A mapping's settings and what they were, for the audit log: those that changed. */
function changesOf(before: Settings, after: Settings): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after) as Array<keyof Settings>) if (before[key] !== after[key]) changes[key] = { from: before[key], to: after[key] };
  return changes;
}

/**
 * Functions reading queues of their account, as AWS Lambda's event source
 * mappings for SQS (ADR 0010): made for a queue by its ARN, with Lambda's
 * defaults and limits and in its words, changed and deleted, each change in
 * the audit log; read by the EventSourcePoller, told of each change. A
 * function reads a queue once, and as many queues as its plan allows; the
 * queue must hide a message received for at least the function's timeout, as
 * Lambda requires, or a message would come back during the call that has it.
 */
@Injectable()
export class EventSourcesService {
  private readonly region: string;

  constructor(
    @InjectRepository(EventSourceMapping) private readonly mappings: Repository<EventSourceMapping>,
    private readonly functions: FunctionsService,
    private readonly queues: CustomerQueues,
    private readonly plans: PlansService,
    private readonly audit: AuditService,
    private readonly poller: EventSourcePoller,
    config: ConfigService,
  ) {
    this.region = config.getOrThrow<{ region: string }>('sqs').region;
  }

  /** GET /functions/:id/event-sources: the queues the function reads, the first mapped first. */
  async listForFunction(accountId: string, functionId: string): Promise<EventSourceView[]> {
    const fn = await this.functions.findOne(accountId, functionId);
    const rows = await this.mappings.find({ where: { accountId, functionId: fn.id }, relations: { queue: true }, order: { createdAt: 'ASC' } });
    return rows.map((row) => this.view(row, fn, row.queue as Queue));
  }

  /**
   * GET /event-sources: the account's mappings, the first mapped first, or
   * those reading the queue an ARN names: none for another account's queue,
   * or one the account doesn't have, as Lambda lists none.
   */
  async list(accountId: string, eventSourceArn?: string): Promise<EventSourceView[]> {
    let queueId: string | undefined;
    if (eventSourceArn !== undefined) {
      const named = parseQueueArn(eventSourceArn);
      if (!named) throw new BadRequestException(`eventSourceArn must be a queue's ARN, as SQS's: ${queueArn(this.region, accountId, '<name>')}`);
      const queue = named.region === this.region && named.accountId === accountId ? await this.queues.find(accountId, named.name) : null;
      if (!queue) return [];
      queueId = queue.id;
    }
    const rows = await this.mappings.find({ where: { accountId, ...(queueId ? { queueId } : {}) }, relations: { queue: true }, order: { createdAt: 'ASC' } });
    const functions = await this.functionsOf(rows);
    return rows.map((row) => this.view(row, functions.get(row.functionId) as Function, row.queue as Queue));
  }

  async get(accountId: string, uuid: string): Promise<EventSourceView> {
    const row = await this.find(accountId, uuid);
    const functions = await this.functionsOf([row]);
    return this.view(row, functions.get(row.functionId) as Function, row.queue as Queue);
  }

  /**
   * As Lambda's CreateEventSourceMapping: the queue the account's, in FF's
   * region, its visibility timeout no shorter than the function's timeout;
   * counted against the plan under a lock on the function, so that two at
   * once can't both take its last place.
   */
  async create(accountId: string, functionId: string, dto: CreateEventSourceDto): Promise<EventSourceView> {
    const fn = await this.functions.findOne(accountId, functionId);
    const queue = await this.queueOf(accountId, dto.eventSourceArn, 'eventSourceArn');
    const settings = settingsOf(dto, DEFAULTS);
    checkBatch(settings);
    if (queue.visibilityTimeout < fn.timeout) {
      throw new BadRequestException(`Invalid parameter: Queue visibility timeout: ${queue.visibilityTimeout} seconds is less than Function timeout: ${fn.timeout} seconds`);
    }
    const plan = await this.plans.forAccount(accountId);
    const row = await this.mappings.manager.transaction(async (manager) => {
      await manager.query('SELECT 1 FROM "functions" WHERE "id" = $1 FOR UPDATE', [fn.id]);
      const existing = await manager.findOneBy(EventSourceMapping, { functionId: fn.id, queueId: queue.id });
      if (existing) {
        throw new ConflictException(
          `An event source mapping with SQS arn (" ${this.arnOfQueue(queue)} ") and function (" ${fn.name} ") already exists. Please update or delete the existing mapping with UUID ${existing.id}`,
        );
      }
      const count = await manager.countBy(EventSourceMapping, { functionId: fn.id });
      const limit = plan.limits.eventSourceMappingsPerFunction;
      if (count >= limit) {
        throw new BadRequestException(`The ${plan.name} plan lets a function read ${limit} ${limit === 1 ? 'queue' : 'queues'}: ${fn.name} reads ${count} already`);
      }
      return manager.save(EventSourceMapping, manager.create(EventSourceMapping, { accountId, functionId: fn.id, queueId: queue.id, ...settings }));
    });
    await this.audit.record({
      accountId,
      action: 'event_source.create',
      resource: `event_source:${row.id}`,
      details: { function: fn.name, queue: queue.name, ...settings },
    });
    await this.poller.changed();
    return this.view(row, fn, queue);
  }

  /** As Lambda's UpdateEventSourceMapping: what is given changes, the rest stays. */
  async update(accountId: string, uuid: string, dto: UpdateEventSourceDto): Promise<EventSourceView> {
    const row = await this.find(accountId, uuid);
    const before: Settings = { ...DEFAULTS, ...pickSettings(row) };
    const after = settingsOf(dto, before);
    checkBatch(after);
    const changes = changesOf(before, after);
    if (Object.keys(changes).length > 0) {
      await this.mappings.update({ id: row.id }, after);
      await this.audit.record({ accountId, action: 'event_source.update', resource: `event_source:${row.id}`, details: { changes } });
      await this.poller.changed();
    }
    return this.get(accountId, uuid);
  }

  /** As Lambda's DeleteEventSourceMapping: nothing is read any more; a batch in a call ends as it would have. */
  async remove(accountId: string, uuid: string): Promise<void> {
    const row = await this.find(accountId, uuid);
    const fn = (await this.functionsOf([row])).get(row.functionId);
    await this.mappings.delete({ id: row.id });
    await this.audit.record({ accountId, action: 'event_source.delete', resource: `event_source:${row.id}`, details: { function: fn?.name, queue: row.queue?.name } });
    await this.poller.changed();
  }

  private async find(accountId: string, uuid: string): Promise<EventSourceMapping> {
    const row = await this.mappings.findOne({ where: { id: uuid, accountId }, relations: { queue: true } });
    if (!row) throw new NotFoundException(`The account has no event source mapping ${uuid}`);
    return row;
  }

  /** The functions of these mappings, their names alone: not their code. */
  private async functionsOf(rows: EventSourceMapping[]): Promise<Map<string, Pick<Function, 'id' | 'accountId' | 'name'>>> {
    const ids = [...new Set(rows.map((row) => row.functionId))];
    const functions = ids.length ? await this.mappings.manager.find(Function, { where: { id: In(ids) }, select: { id: true, accountId: true, name: true } }) : [];
    return new Map(functions.map((fn) => [fn.id, fn]));
  }

  /** The account's queue an ARN names, in FF's region: refused, in the same words whether another account's or nobody's. */
  private async queueOf(accountId: string, arn: string, field: string): Promise<Queue> {
    const named = parseQueueArn(arn);
    if (!named) throw new BadRequestException(`${field} must be a queue's ARN, as SQS's: ${queueArn(this.region, accountId, '<name>')}`);
    if (named.region !== this.region || named.accountId !== accountId) {
      throw new BadRequestException(`${field} must be a queue of this account, in ${this.region}: ${queueArn(this.region, accountId, named.name)}`);
    }
    const queue = await this.queues.find(accountId, named.name);
    if (!queue) throw new BadRequestException(`${field}: the account has no queue named "${named.name}"`);
    return queue;
  }

  private arnOfQueue(queue: Pick<Queue, 'accountId' | 'name'>): string {
    return queueArn(this.region, queue.accountId, queue.name);
  }

  private view(row: EventSourceMapping, fn: Pick<Function, 'accountId' | 'name'>, queue: Pick<Queue, 'accountId' | 'name'>): EventSourceView {
    return {
      uuid: row.id,
      eventSourceArn: this.arnOfQueue(queue),
      functionArn: functionArn(this.region, fn.accountId, fn.name),
      batchSize: row.batchSize,
      maximumBatchingWindowInSeconds: row.maximumBatchingWindowInSeconds,
      functionResponseTypes: row.reportBatchItemFailures ? [REPORT_BATCH_ITEM_FAILURES] : [],
      scalingConfig: row.maximumConcurrency === null ? null : { maximumConcurrency: row.maximumConcurrency },
      state: row.enabled ? 'Enabled' : 'Disabled',
      stateTransitionReason: 'USER_INITIATED',
      lastModified: row.updatedAt,
    };
  }
}

/** A mapping's settings alone, as the audit log compares them. */
function pickSettings(row: EventSourceMapping): Settings {
  const { batchSize, maximumBatchingWindowInSeconds, reportBatchItemFailures, maximumConcurrency, enabled } = row;
  return { batchSize, maximumBatchingWindowInSeconds, reportBatchItemFailures, maximumConcurrency, enabled };
}

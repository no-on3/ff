import { Injectable, NotFoundException, ValidationPipe } from '@nestjs/common';
import { DTO_VALIDATION } from '../common/validation';
import { CreateEventSourceDto, EventSourceView, UpdateEventSourceDto } from '../event-sources/dto/event-source.dto';
import { EventSourcesService } from '../event-sources/event-sources.service';
import { FunctionAliasesService } from '../functions/aliases.service';
import { parseFunctionArn, parseFunctionName, qualifiedFunctionArn } from '../functions/arns';
import { Function } from '../functions/entities/function.entity';
import { FunctionsService } from '../functions/functions.service';
import { parseQualifier } from '../functions/qualifier';
import { FunctionVersionsService } from '../functions/versions.service';
import { parseQueueArn } from '../queues/sqs-attributes';
import { invalidParameterValue, keyCannot, resourceNotFound } from './lambda-error';
import { defined, isEmpty, isObject, refuseUnknownFields, said } from './lambda-fields';
import { LambdaAnswer, LambdaCall, LambdaCaller, LambdaHandler, LambdaHandlers, namedFunction, ok } from './lambda-operations';
import { pageOf } from './lambda-pages';

/** The fields a mapping of a queue takes, as Lambda's for SQS; CreateEventSourceMapping's FunctionName and EventSourceArn besides. */
const SETTINGS = ['Enabled', 'BatchSize', 'MaximumBatchingWindowInSeconds', 'FunctionResponseTypes', 'ScalingConfig'];
const TAKEN = {
  CreateEventSourceMapping: new Set(['FunctionName', 'EventSourceArn', ...SETTINGS]),
  UpdateEventSourceMapping: new Set(['FunctionName', ...SETTINGS]),
};

/** What Lambda's mappings take for other sources than a queue, refused saying why unless sent empty, as the tools send a default. */
const STREAMS = "FF's mappings read SQS queues, and this is for streams and brokers.";
const OTHERS: Record<string, string> = {
  StartingPosition: STREAMS,
  StartingPositionTimestamp: STREAMS,
  ParallelizationFactor: STREAMS,
  MaximumRecordAgeInSeconds: STREAMS,
  BisectBatchOnFunctionError: STREAMS,
  MaximumRetryAttempts: STREAMS,
  TumblingWindowInSeconds: STREAMS,
  DestinationConfig: STREAMS,
  Topics: STREAMS,
  Queues: STREAMS,
  SourceAccessConfigurations: STREAMS,
  SelfManagedEventSource: STREAMS,
  AmazonManagedKafkaEventSourceConfig: STREAMS,
  SelfManagedKafkaEventSourceConfig: STREAMS,
  DocumentDBEventSourceConfig: STREAMS,
  ProvisionedPollerConfig: STREAMS,
  FilterCriteria: "FF doesn't filter a queue's messages yet: the function gets each one.",
  KMSKeyArn: 'FF seals what it keeps with its own keys: a KMS key has no place here.',
  MetricsConfig: "FF counts a mapping's calls in the function's metrics.",
  LoggingConfig: "FF keeps a mapping's calls in the function's log.",
  Tags: 'FF tags functions, not their mappings.',
};

/** Lambda's limits on ListEventSourceMappings: MaxItems up to 10,000, and 100 a page at most however many are asked. */
const LIST_MOST = 10_000;
const LIST_PAGE = 100;

/** A mapping, as Lambda's EventSourceMappingConfiguration for SQS: its LastModified in seconds, as Lambda's dates. */
export function mappingConfiguration(view: EventSourceView, region: string, accountId: string, state: string = view.state): Record<string, unknown> {
  return {
    UUID: view.uuid,
    EventSourceMappingArn: `arn:aws:lambda:${region}:${accountId}:event-source-mapping:${view.uuid}`,
    EventSourceArn: view.eventSourceArn,
    FunctionArn: view.functionArn,
    BatchSize: view.batchSize,
    MaximumBatchingWindowInSeconds: view.maximumBatchingWindowInSeconds,
    FunctionResponseTypes: view.functionResponseTypes,
    ...(view.scalingConfig ? { ScalingConfig: { MaximumConcurrency: view.scalingConfig.maximumConcurrency } } : {}),
    State: state,
    StateTransitionReason: view.stateTransitionReason,
    LastModified: new Date(view.lastModified).getTime() / 1000,
  };
}

/** Lambda's settings of a mapping as FF's, each under Lambda's name, the others refused saying why. */
function settingsOf(input: Record<string, unknown>, operation: string): Record<string, unknown> {
  for (const [field, why] of Object.entries(OTHERS)) {
    if (!isEmpty(input[field])) throw invalidParameterValue(`${operation} doesn't take ${field}: ${why}`);
  }
  const scaling = input.ScalingConfig;
  if (scaling !== undefined && scaling !== null && !(isObject(scaling) && Object.keys(scaling).every((key) => key === 'MaximumConcurrency'))) {
    throw invalidParameterValue('ScalingConfig takes MaximumConcurrency alone.');
  }
  return defined({
    enabled: input.Enabled,
    batchSize: input.BatchSize,
    maximumBatchingWindowInSeconds: input.MaximumBatchingWindowInSeconds,
    functionResponseTypes: input.FunctionResponseTypes,
    scalingConfig: scaling === undefined ? undefined : isObject(scaling) && scaling.MaximumConcurrency !== undefined ? { maximumConcurrency: scaling.MaximumConcurrency } : null,
  });
}

/**
 * Lambda's event source mappings over FF's, for SQS queues of the account (ADR 0010): CreateEventSourceMapping,
 * GetEventSourceMapping, UpdateEventSourceMapping, DeleteEventSourceMapping and ListEventSourceMappings. A mapping's
 * operations check the key may use its function once they have read it, as the front door checks a named one.
 */
@Injectable()
export class LambdaMappings implements LambdaHandlers {
  private readonly validation = new ValidationPipe(DTO_VALIDATION);

  constructor(
    private readonly mappings: EventSourcesService,
    private readonly functions: FunctionsService,
    private readonly versions: FunctionVersionsService,
    private readonly aliases: FunctionAliasesService,
  ) {}

  readonly handlers: Record<string, LambdaHandler> = {
    CreateEventSourceMapping: (call, caller) => this.create(call, caller),
    GetEventSourceMapping: async (call, caller) => ok(mappingConfiguration((await this.mapping(call, caller)).mapping, caller.region, caller.accountId)),
    UpdateEventSourceMapping: (call, caller) => this.update(call, caller),
    DeleteEventSourceMapping: (call, caller) => this.remove(call, caller),
    ListEventSourceMappings: (call, caller) => this.list(call, caller),
  };

  /** The function reads the queue, as it is or through the version or the alias after its name; answered at once, Enabled or Disabled. */
  private async create({ input, operation }: LambdaCall, caller: LambdaCaller): Promise<LambdaAnswer> {
    const function_ = namedFunction(caller);
    refuseUnknownFields(input, operation.name, new Set([...TAKEN.CreateEventSourceMapping, ...Object.keys(OTHERS)]));
    const arn = input.EventSourceArn;
    if (typeof arn !== 'string' || !parseQueueArn(arn)) throw invalidParameterValue(`${operation.name} needs EventSourceArn, an SQS queue's ARN: FF's mappings read queues alone.`);
    const qualifier = caller.named?.qualifier;
    await this.refuseMissing(function_, qualifier, caller);
    const sent = { eventSourceArn: arn, ...settingsOf(input, operation.name), ...(qualifier !== undefined ? { qualifier } : {}) };
    const dto = (await this.validation.transform(sent, { type: 'body', metatype: CreateEventSourceDto })) as CreateEventSourceDto;
    const created = await this.mappings.create(caller.accountId, function_.id, dto);
    return { status: 202, document: mappingConfiguration(created, caller.region, caller.accountId) };
  }

  /** What the request sends changes, the rest stays; FunctionName may name another version or alias of the mapping's function, not another function. */
  private async update(call: LambdaCall, caller: LambdaCaller): Promise<LambdaAnswer> {
    const { input, operation } = call;
    const { mapping, name } = await this.mapping(call, caller);
    refuseUnknownFields(input, operation.name, new Set([...TAKEN.UpdateEventSourceMapping, ...Object.keys(OTHERS)]));
    const qualifier = this.qualifierOf(input.FunctionName, mapping, name, caller);
    if (qualifier !== undefined) {
      const [function_] = await this.functions.findAll(caller.accountId, name);
      if (function_) await this.refuseMissing(function_, qualifier, caller);
    }
    const sent = { ...settingsOf(input, operation.name), ...(qualifier !== undefined ? { qualifier } : {}) };
    const dto = (await this.validation.transform(sent, { type: 'body', metatype: UpdateEventSourceDto })) as UpdateEventSourceDto;
    return { status: 202, document: mappingConfiguration(await this.mappings.update(caller.accountId, mapping.uuid, dto), caller.region, caller.accountId) };
  }

  /** The queue is read no more, at once: answered as it was, Deleting, as Lambda answers. */
  private async remove(call: LambdaCall, caller: LambdaCaller): Promise<LambdaAnswer> {
    const { mapping } = await this.mapping(call, caller);
    await this.mappings.remove(caller.accountId, mapping.uuid);
    return { status: 202, document: mappingConfiguration(mapping, caller.region, caller.accountId, 'Deleting') };
  }

  /**
   * The account's mappings that the key may read, by their UUIDs, a page at a time: of the function FunctionName
   * names, through the version or the alias after it if any, and of the queue EventSourceArn names; none for a function
   * or a queue the account hasn't, as Lambda lists none.
   */
  private async list({ query, operation }: LambdaCall, caller: LambdaCaller): Promise<LambdaAnswer> {
    const queue = query.get('EventSourceArn') ?? undefined;
    let mappings = await this.mappings.list(caller.accountId, queue);
    const sent = query.get('FunctionName');
    if (sent !== null) {
      // The front door read it, and refused one that isn't a function's name: one of another account or region names none here.
      const named = parseFunctionName(sent);
      const here = named !== undefined && (named.accountId ?? caller.accountId) === caller.accountId && (named.region ?? caller.region) === caller.region;
      mappings = mappings.filter((mapping) => {
        const reads = parseFunctionArn(mapping.functionArn);
        return here && reads?.name === named.name && (named.qualifier === undefined || reads.qualifier === named.qualifier);
      });
    }
    const readable = mappings.filter((mapping) => caller.mayUse(parseFunctionArn(mapping.functionArn)?.name ?? '', 'read'));
    const { page, nextMarker } = pageOf(query, readable, (mapping) => [mapping.uuid], operation.name, { most: LIST_MOST, perPage: LIST_PAGE });
    return ok({ EventSourceMappings: page.map((mapping) => mappingConfiguration(mapping, caller.region, caller.accountId)), ...(nextMarker !== undefined ? { NextMarker: nextMarker } : {}) });
  }

  /**
   * The mapping the path names, and its function's name, if the key may use that function at the operation's level;
   * one the account hasn't, as Lambda says it.
   */
  private async mapping({ groups, operation }: LambdaCall, caller: LambdaCaller): Promise<{ mapping: EventSourceView; name: string }> {
    const uuid = groups[0];
    const missing = () => resourceNotFound('The resource you requested does not exist.');
    if (!UUID.test(uuid)) throw missing();
    let mapping: EventSourceView;
    try {
      mapping = await this.mappings.get(caller.accountId, uuid);
    } catch (error) {
      if (error instanceof NotFoundException) throw missing();
      throw error;
    }
    const name = parseFunctionArn(mapping.functionArn)?.name ?? '';
    if (!caller.mayUse(name, operation.access)) throw keyCannot(caller.key, operation, name);
    return { mapping, name };
  }

  /** A version or an alias the function hasn't, refused as Lambda refuses it, by its ARN. */
  private async refuseMissing(function_: Function, qualifier: string | undefined, caller: LambdaCaller): Promise<void> {
    const named = parseQualifier(qualifier);
    if (!named) return;
    try {
      if ('version' in named) await this.versions.get(caller.accountId, function_.id, named.version);
      else await this.aliases.get(caller.accountId, function_.id, named.alias);
    } catch (error) {
      if (error instanceof NotFoundException) throw resourceNotFound(`Function not found: ${qualifiedFunctionArn(caller.region, caller.accountId, function_.name, qualifier)}`);
      throw error;
    }
  }

  /** The version or the alias an update's FunctionName names, of the mapping's function alone; undefined when it names none. */
  private qualifierOf(sent: unknown, mapping: EventSourceView, reads: string, caller: LambdaCaller): string | undefined {
    if (sent === undefined) return undefined;
    const named = typeof sent === 'string' ? parseFunctionName(sent) : undefined;
    if (!named) throw invalidParameterValue(`FunctionName must be a function's name, its ARN or its partial ARN, a version or an alias after it if any, not ${said(sent)}.`);
    const elsewhere = (named.accountId && named.accountId !== caller.accountId) || (named.region && named.region !== caller.region);
    if (elsewhere || named.name !== reads) {
      throw invalidParameterValue(`FF moves no mapping to another function: the mapping ${mapping.uuid} reads for ${reads}. Delete it, and create one for ${named.name}.`);
    }
    return named.qualifier ?? '$LATEST';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

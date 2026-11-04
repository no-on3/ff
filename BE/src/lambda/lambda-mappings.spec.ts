/**
 * L1: Lambda's event source mappings over FF's, for the account's SQS queues:
 * CreateEventSourceMapping, GetEventSourceMapping, UpdateEventSourceMapping,
 * DeleteEventSourceMapping and ListEventSourceMappings, in Lambda's shape;
 * what they send checked under Lambda's names, what only streams and brokers
 * take refused saying so, and the rest refused as Lambda refuses.
 */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { EventSourceView } from '../event-sources/dto/event-source.dto';
import { EventSourcesService } from '../event-sources/event-sources.service';
import { FunctionAliasesService } from '../functions/aliases.service';
import { Function } from '../functions/entities/function.entity';
import { FunctionsService } from '../functions/functions.service';
import { FunctionVersionsService } from '../functions/versions.service';
import { mayUse } from '../storage/key-reach';
import { LambdaMappings } from './lambda-mappings';
import { LambdaCaller } from './lambda-operations';
import { ACCOUNT, REGION, accessKey, lambdaCall, lambdaCaller, refused } from './test-fixtures';

const ARN = `arn:aws:lambda:${REGION}:${ACCOUNT}:function`;
const QUEUE = `arn:aws:sqs:${REGION}:${ACCOUNT}:orders`;
const MAPPINGS = '/2015-03-31/event-source-mappings';
const UUID = '6c2a1e8b-7d4c-4a9e-8f1a-2b3c4d5e6f70';
const CHANGED = new Date('2026-11-02T09:30:00.000Z');
const MISSING = [404, 'ResourceNotFoundException', 'The resource you requested does not exist.'];
const READER = accessKey('AKFFREADERAAAAAAAAAA', { name: 'reader', functions: ['orders'], functionAccess: 'read' });

const mappingOf = (uuid: string, more: Partial<EventSourceView> = {}): EventSourceView => ({
  uuid,
  eventSourceArn: QUEUE,
  functionArn: `${ARN}:orders`,
  batchSize: 10,
  maximumBatchingWindowInSeconds: 0,
  functionResponseTypes: [],
  scalingConfig: null,
  state: 'Enabled',
  stateTransitionReason: 'USER_INITIATED',
  lastModified: CHANGED,
  ...more,
});

/** A UUID for the n-th mapping, in the order they sort. */
const uuidOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe("Lambda's event source mappings (L1)", () => {
  const orders = Object.assign(new Function(), { id: 'f-orders', accountId: ACCOUNT, name: 'orders' });
  const billing = Object.assign(new Function(), { id: 'f-billing', accountId: ACCOUNT, name: 'billing' });
  let mappings: Map<string, EventSourceView>;
  let service: { create: jest.Mock; get: jest.Mock; update: jest.Mock; remove: jest.Mock; list: jest.Mock };
  let handlers: LambdaMappings;

  beforeEach(() => {
    mappings = new Map([[UUID, mappingOf(UUID)]]);
    const found = (uuid: string) => {
      const mapping = mappings.get(uuid);
      if (!mapping) throw new NotFoundException('no mapping');
      return mapping;
    };
    service = {
      create: jest.fn(async (_account: string, _id: string, dto: { eventSourceArn: string; qualifier?: string; batchSize?: number }) => {
        const taken = [...mappings.values()].find((mapping) => mapping.eventSourceArn === dto.eventSourceArn);
        if (taken) throw new ConflictException(`The queue already has a mapping. Please update or delete the existing mapping with UUID ${taken.uuid}`);
        return mappingOf(uuidOf(1), { eventSourceArn: dto.eventSourceArn, functionArn: `${ARN}:orders${dto.qualifier ? `:${dto.qualifier}` : ''}`, batchSize: dto.batchSize ?? 10 });
      }),
      get: jest.fn(async (_account: string, uuid: string) => found(uuid)),
      update: jest.fn(async (_account: string, uuid: string, dto: { batchSize?: number; qualifier?: string }) => ({
        ...found(uuid),
        ...(dto.batchSize !== undefined ? { batchSize: dto.batchSize } : {}),
        ...(dto.qualifier !== undefined ? { functionArn: `${ARN}:orders${dto.qualifier === '$LATEST' ? '' : `:${dto.qualifier}`}` } : {}),
      })),
      remove: jest.fn(async (_account: string, uuid: string) => void found(uuid)),
      list: jest.fn(async (_account: string, queue?: string) => [...mappings.values()].filter((mapping) => queue === undefined || mapping.eventSourceArn === queue)),
    };
    const functions = { findAll: jest.fn(async (_account: string, name: string) => [orders, billing].filter((fn) => fn.name === name)) };
    const versions = {
      get: jest.fn(async (_account: string, _id: string, version: number) => {
        if (version !== 1) throw new NotFoundException('no version');
        return { version };
      }),
    };
    const aliases = {
      get: jest.fn(async (_account: string, _id: string, name: string) => {
        if (name !== 'live') throw new NotFoundException('no alias');
        return { name };
      }),
    };
    handlers = new LambdaMappings(
      service as unknown as EventSourcesService,
      functions as unknown as FunctionsService,
      versions as unknown as FunctionVersionsService,
      aliases as unknown as FunctionAliasesService,
    );
  });

  /** A request as the front door hands it on: for a creation, the function its body names found, its qualifier after its name. */
  async function ask(method: string, target: string, input: Record<string, unknown> = {}, more: Partial<LambdaCaller> = {}) {
    const call = lambdaCall(method, target, input);
    const answer = await handlers.handlers[call.operation.name](call, lambdaCaller(more));
    return { status: answer.status, document: answer.document as Record<string, unknown> };
  }
  const creating = (qualifier?: string): Partial<LambdaCaller> => ({ function_: orders, named: { name: 'orders', ...(qualifier ? { qualifier } : {}) } });
  const asReader: Partial<LambdaCaller> = { key: READER, mayUse: (name, access) => mayUse(READER, name, access) };

  describe('CreateEventSourceMapping', () => {
    it("has the alias read the queue, Lambda's settings under FF's names, and answers 202 with Lambda's configuration, its LastModified in seconds", async () => {
      mappings.clear();
      const sent = { FunctionName: 'orders:live', EventSourceArn: QUEUE, BatchSize: 5, MaximumBatchingWindowInSeconds: 2, FunctionResponseTypes: ['ReportBatchItemFailures'], ScalingConfig: { MaximumConcurrency: 4 } };

      const answer = await ask('POST', `${MAPPINGS}/`, sent, creating('live'));

      expect(service.create).toHaveBeenCalledWith(ACCOUNT, 'f-orders', {
        eventSourceArn: QUEUE,
        qualifier: 'live',
        batchSize: 5,
        maximumBatchingWindowInSeconds: 2,
        functionResponseTypes: ['ReportBatchItemFailures'],
        scalingConfig: { maximumConcurrency: 4 },
      });
      expect(answer).toEqual({
        status: 202,
        document: {
          UUID: uuidOf(1),
          EventSourceMappingArn: `arn:aws:lambda:${REGION}:${ACCOUNT}:event-source-mapping:${uuidOf(1)}`,
          EventSourceArn: QUEUE,
          FunctionArn: `${ARN}:orders:live`,
          BatchSize: 5,
          MaximumBatchingWindowInSeconds: 0,
          FunctionResponseTypes: [],
          State: 'Enabled',
          StateTransitionReason: 'USER_INITIATED',
          LastModified: CHANGED.getTime() / 1000,
        },
      });
    });

    it("takes a stream's settings sent empty, as the tools send their defaults, and refuses them sent, saying why", async () => {
      mappings.clear();
      await ask('POST', `${MAPPINGS}/`, { FunctionName: 'orders', EventSourceArn: QUEUE, DestinationConfig: { OnFailure: {} }, Topics: [], FilterCriteria: null }, creating());
      expect(service.create).toHaveBeenCalledWith(ACCOUNT, 'f-orders', { eventSourceArn: QUEUE });

      expect(await refused(ask('POST', `${MAPPINGS}/`, { FunctionName: 'orders', EventSourceArn: QUEUE, MaximumRetryAttempts: 2 }, creating()))).toEqual([
        400,
        'InvalidParameterValueException',
        "CreateEventSourceMapping doesn't take MaximumRetryAttempts: FF's mappings read SQS queues, and this is for streams and brokers.",
      ]);
      expect(await refused(ask('POST', `${MAPPINGS}/`, { FunctionName: 'orders', EventSourceArn: QUEUE, FilterCriteria: { Filters: [{ Pattern: '{}' }] } }, creating()))).toEqual([
        400,
        'InvalidParameterValueException',
        "CreateEventSourceMapping doesn't take FilterCriteria: FF doesn't filter a queue's messages yet: the function gets each one.",
      ]);
    });

    it("refuses another source than a queue, a field Lambda's model hasn't, ScalingConfig's others, and a version or an alias the function hasn't, before FF's service", async () => {
      const create = (input: Record<string, unknown>, qualifier?: string) => refused(ask('POST', `${MAPPINGS}/`, { FunctionName: 'orders', ...input }, creating(qualifier)));

      expect(await create({ EventSourceArn: `arn:aws:kinesis:${REGION}:${ACCOUNT}:stream/orders` })).toEqual([
        400,
        'InvalidParameterValueException',
        "CreateEventSourceMapping needs EventSourceArn, an SQS queue's ARN: FF's mappings read queues alone.",
      ]);
      expect(await create({ EventSourceArn: QUEUE, Batch: 5 })).toEqual([400, 'InvalidParameterValueException', "FF doesn't take Batch in CreateEventSourceMapping."]);
      expect(await create({ EventSourceArn: QUEUE, ScalingConfig: { MaximumConcurrency: 4, Minimum: 1 } })).toEqual([400, 'InvalidParameterValueException', 'ScalingConfig takes MaximumConcurrency alone.']);
      expect(await create({ EventSourceArn: QUEUE }, 'gone')).toEqual([404, 'ResourceNotFoundException', `Function not found: ${ARN}:orders:gone`]);
      expect(await create({ EventSourceArn: QUEUE }, '7')).toEqual([404, 'ResourceNotFoundException', `Function not found: ${ARN}:orders:7`]);
      expect(service.create).not.toHaveBeenCalled();
    });

    it("checks the settings with FF's own checks, and passes on the service's refusals: a second mapping of the queue, a queue the account hasn't", async () => {
      const [, type, message] = await refused(ask('POST', `${MAPPINGS}/`, { FunctionName: 'orders', EventSourceArn: `${QUEUE}-new`, BatchSize: 0 }, creating()));
      expect([type, message]).toEqual(['InvalidParameterValueException', expect.stringContaining('batchSize')]);

      expect(await refused(ask('POST', `${MAPPINGS}/`, { FunctionName: 'orders', EventSourceArn: QUEUE }, creating()))).toEqual([
        409,
        'ResourceConflictException',
        `The queue already has a mapping. Please update or delete the existing mapping with UUID ${UUID}`,
      ]);
      service.create.mockRejectedValueOnce(new BadRequestException('eventSourceArn: the account has no queue gone'));
      expect(await refused(ask('POST', `${MAPPINGS}/`, { FunctionName: 'orders', EventSourceArn: `${QUEUE}-gone` }, creating()))).toEqual([
        400,
        'InvalidParameterValueException',
        'eventSourceArn: the account has no queue gone',
      ]);
    });
  });

  describe('GetEventSourceMapping, UpdateEventSourceMapping, DeleteEventSourceMapping', () => {
    it("reads the mapping by its UUID; one the account hasn't, or no UUID at all, as Lambda says it", async () => {
      expect((await ask('GET', `${MAPPINGS}/${UUID}`)).document).toMatchObject({ UUID, FunctionArn: `${ARN}:orders`, State: 'Enabled' });
      expect(await refused(ask('GET', `${MAPPINGS}/${uuidOf(9)}`))).toEqual(MISSING);
      expect(await refused(ask('GET', `${MAPPINGS}/orders`))).toEqual(MISSING);
      expect(service.get).toHaveBeenCalledTimes(2);
    });

    it("asks what the key may do with the mapping's function: a reader reads it, and changes and deletes nothing", async () => {
      expect((await ask('GET', `${MAPPINGS}/${UUID}`, {}, asReader)).status).toBe(200);
      const denied = [403, 'AccessDeniedException', 'The access key reader (AKFFREADERAAAAAAAAAA) may read the function orders, not change it.'];
      expect(await refused(ask('PUT', `${MAPPINGS}/${UUID}`, { BatchSize: 5 }, asReader))).toEqual(denied);
      expect(await refused(ask('DELETE', `${MAPPINGS}/${UUID}`, {}, asReader))).toEqual(denied);
      mappings.set(uuidOf(2), mappingOf(uuidOf(2), { functionArn: `${ARN}:billing` }));
      expect(await refused(ask('GET', `${MAPPINGS}/${uuidOf(2)}`, {}, asReader))).toEqual([403, 'AccessDeniedException', "The access key reader (AKFFREADERAAAAAAAAAA) doesn't reach the function billing."]);
      expect(service.update).not.toHaveBeenCalled();
      expect(service.remove).not.toHaveBeenCalled();
    });

    it('changes what is sent, the rest staying, and moves the mapping to a version or an alias of its function, or back to $LATEST by its name alone', async () => {
      const answer = await ask('PUT', `${MAPPINGS}/${UUID}`, { BatchSize: 5, Enabled: false });
      expect(answer.status).toBe(202);
      expect(service.update).toHaveBeenLastCalledWith(ACCOUNT, UUID, { batchSize: 5, enabled: false });

      expect((await ask('PUT', `${MAPPINGS}/${UUID}`, { FunctionName: `${ARN}:orders:live` })).document.FunctionArn).toBe(`${ARN}:orders:live`);
      expect((await ask('PUT', `${MAPPINGS}/${UUID}`, { FunctionName: 'orders' })).document.FunctionArn).toBe(`${ARN}:orders`);
      expect(service.update).toHaveBeenLastCalledWith(ACCOUNT, UUID, { qualifier: '$LATEST' });
    });

    it("moves no mapping to another function, another account's or another region's, nor to a version or an alias its function hasn't", async () => {
      const moved = (to: string) => [
        400,
        'InvalidParameterValueException',
        `FF moves no mapping to another function: the mapping ${UUID} reads for orders. Delete it, and create one for ${to}.`,
      ];
      expect(await refused(ask('PUT', `${MAPPINGS}/${UUID}`, { FunctionName: 'billing' }))).toEqual(moved('billing'));
      expect(await refused(ask('PUT', `${MAPPINGS}/${UUID}`, { FunctionName: 'arn:aws:lambda:tn-tunis-1:000000000002:function:orders' }))).toEqual(moved('orders'));
      expect(await refused(ask('PUT', `${MAPPINGS}/${UUID}`, { FunctionName: 'orders:gone' }))).toEqual([404, 'ResourceNotFoundException', `Function not found: ${ARN}:orders:gone`]);
      expect(await refused(ask('PUT', `${MAPPINGS}/${UUID}`, { FunctionName: 7 }))).toEqual([
        400,
        'InvalidParameterValueException',
        "FunctionName must be a function's name, its ARN or its partial ARN, a version or an alias after it if any, not 7.",
      ]);
      expect(await refused(ask('PUT', `${MAPPINGS}/${UUID}`, { EventSourceArn: QUEUE }))).toEqual([400, 'InvalidParameterValueException', "FF doesn't take EventSourceArn in UpdateEventSourceMapping."]);
      expect(await refused(ask('PUT', `${MAPPINGS}/${UUID}`, { StartingPosition: 'LATEST' }))).toEqual([
        400,
        'InvalidParameterValueException',
        "UpdateEventSourceMapping doesn't take StartingPosition: FF's mappings read SQS queues, and this is for streams and brokers.",
      ]);
      expect(service.update).not.toHaveBeenCalled();
    });

    it('deletes the mapping at once, answering it as it was, Deleting, with 202', async () => {
      expect(await ask('DELETE', `${MAPPINGS}/${UUID}`)).toEqual({ status: 202, document: expect.objectContaining({ UUID, State: 'Deleting' }) });
      expect(service.remove).toHaveBeenCalledWith(ACCOUNT, UUID);
      expect(await refused(ask('DELETE', `${MAPPINGS}/${uuidOf(9)}`))).toEqual(MISSING);
    });
  });

  describe('ListEventSourceMappings', () => {
    beforeEach(() => {
      mappings.set(uuidOf(1), mappingOf(uuidOf(1), { eventSourceArn: `${QUEUE}-a`, functionArn: `${ARN}:orders:live` }));
      mappings.set(uuidOf(2), mappingOf(uuidOf(2), { eventSourceArn: `${QUEUE}-b`, functionArn: `${ARN}:billing` }));
    });
    const listed = async (target: string, more: Partial<LambdaCaller> = {}) => ((await ask('GET', target, {}, more)).document.EventSourceMappings as Array<{ UUID: string }>).map((mapping) => mapping.UUID);

    it("lists the account's mappings by their UUIDs, of a queue, of a function, through its version or alias; none of a function elsewhere", async () => {
      expect(await listed(`${MAPPINGS}/`)).toEqual([uuidOf(1), uuidOf(2), UUID]);
      expect(await listed(`${MAPPINGS}/?EventSourceArn=${encodeURIComponent(`${QUEUE}-b`)}`)).toEqual([uuidOf(2)]);
      expect(service.list).toHaveBeenLastCalledWith(ACCOUNT, `${QUEUE}-b`);
      expect(await listed(`${MAPPINGS}/?FunctionName=orders`, { named: { name: 'orders' } })).toEqual([uuidOf(1), UUID]);
      expect(await listed(`${MAPPINGS}/?FunctionName=orders:live`, { named: { name: 'orders', qualifier: 'live' } })).toEqual([uuidOf(1)]);
      const elsewhere = 'arn:aws:lambda:tn-tunis-1:000000000002:function:orders';
      expect(await listed(`${MAPPINGS}/?FunctionName=${encodeURIComponent(elsewhere)}`, { named: { name: 'orders' } })).toEqual([]);
    });

    it('lists only the mappings of the functions the key reaches', async () => {
      expect(await listed(`${MAPPINGS}/`, asReader)).toEqual([uuidOf(1), UUID]);
    });

    it("pages as Lambda's: MaxItems up to 10,000, 100 a page at most, the rest after NextMarker", async () => {
      for (let n = 3; n <= 120; n++) mappings.set(uuidOf(n), mappingOf(uuidOf(n)));

      const first = await ask('GET', `${MAPPINGS}/?MaxItems=10000`);
      expect((first.document.EventSourceMappings as unknown[]).length).toBe(100);
      const rest = await ask('GET', `${MAPPINGS}/?MaxItems=10000&Marker=${String(first.document.NextMarker)}`);
      expect((rest.document.EventSourceMappings as unknown[]).length).toBe(21);
      expect(rest.document.NextMarker).toBeUndefined();

      expect(await refused(ask('GET', `${MAPPINGS}/?MaxItems=10001`))).toEqual([400, 'InvalidParameterValueException', 'MaxItems must be a whole number from 1 to 10000, not 10001.']);
    });
  });
});

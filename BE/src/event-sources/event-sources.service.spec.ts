/**
 * L1: the event source mappings' refusals before anything is written, in
 * Lambda's words where Lambda has some, the version or the alias a mapping
 * runs included, and the mapping as Lambda shows it.
 * What is written, counted and locked is in event-sources.db.spec.ts.
 */
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FindOperator } from 'typeorm';
import { FunctionAlias } from '../functions/entities/function-alias.entity';
import { FunctionVersion } from '../functions/entities/function-version.entity';
import { EventSourceMapping } from './event-source-mapping.entity';
import { EventSourcesService } from './event-sources.service';

const ACCOUNT = '000000000001';
const FUNCTION = { id: 'fn-1', accountId: ACCOUNT, name: 'orders-worker', timeout: 30 };
const QUEUE = { id: 'q-1', accountId: ACCOUNT, name: 'orders', visibilityTimeout: 30 };
const ARN = `arn:aws:sqs:tn-tunis-1:${ACCOUNT}:orders`;

describe('event source mappings, before anything is written', () => {
  let queues: { find: jest.Mock };
  let transaction: jest.Mock;
  let mappings: { findOne: jest.Mock };
  let service: EventSourcesService;
  /** The function's versions' timeouts, by number, and its aliases: live names version 2, canary sends a tenth of its calls to version 3. */
  const timeouts = new Map([
    [2, 30],
    [3, 60],
  ]);
  const aliases: Record<string, Pick<FunctionAlias, 'version' | 'additionalVersion' | 'additionalWeight'>> = {
    live: { version: 2, additionalVersion: null, additionalWeight: null },
    canary: { version: 2, additionalVersion: 3, additionalWeight: 0.1 },
  };
  const manager = {
    findOne: jest.fn(async (target: unknown, { where }: { where: { name: string } }) => (target === FunctionAlias ? (aliases[where.name] ?? null) : null)),
    existsBy: jest.fn(async (target: unknown, where: { version: number }) => target === FunctionVersion && timeouts.has(where.version)),
    find: jest.fn(async (_target: unknown, { where }: { where: { version: FindOperator<number[]> } }) =>
      where.version.value.map((version) => ({ timeout: timeouts.get(version) })),
    ),
  };
  const create = (body: Record<string, unknown>) => service.create(ACCOUNT, FUNCTION.id, { eventSourceArn: ARN, ...body });

  beforeEach(() => {
    queues = { find: jest.fn(async () => QUEUE) };
    transaction = jest.fn();
    mappings = { findOne: jest.fn(async () => null) };
    service = new EventSourcesService(
      { manager: { ...manager, transaction }, find: jest.fn(async () => []), ...mappings } as never,
      { findOne: jest.fn(async () => FUNCTION) } as never,
      queues as never,
      { forAccount: jest.fn(async () => ({ name: 'Beta', limits: { eventSourceMappingsPerFunction: 5 } })) } as never,
      { record: jest.fn() } as never,
      { changed: jest.fn() } as never,
      new ConfigService({ sqs: { region: 'tn-tunis-1' } }),
    );
  });

  it.each([
    [{ eventSourceArn: 'orders' }, "eventSourceArn must be a queue's ARN, as SQS's: arn:aws:sqs:tn-tunis-1:000000000001:<name>"],
    [{ eventSourceArn: 'arn:aws:sqs:tn-tunis-1:000000000002:orders' }, 'eventSourceArn must be a queue of this account, in tn-tunis-1: arn:aws:sqs:tn-tunis-1:000000000001:orders'],
    [{ eventSourceArn: 'arn:aws:sqs:eu-west-3:000000000001:orders' }, 'eventSourceArn must be a queue of this account, in tn-tunis-1: arn:aws:sqs:tn-tunis-1:000000000001:orders'],
    [{ batchSize: 11 }, 'Maximum batch window in seconds must be greater than 0 if maximum batch size is greater than 10'],
  ])('refuses %j, saying why', async (body, problem) => {
    await expect(create(body)).rejects.toEqual(new BadRequestException(problem));
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses a queue the account doesn't have, and one whose visibility timeout is under the function's timeout, in Lambda's words", async () => {
    queues.find.mockResolvedValueOnce(null);
    await expect(create({})).rejects.toEqual(new BadRequestException('eventSourceArn: the account has no queue named "orders"'));

    queues.find.mockResolvedValueOnce({ ...QUEUE, visibilityTimeout: 20 });
    await expect(create({})).rejects.toEqual(new BadRequestException('Invalid parameter: Queue visibility timeout: 20 seconds is less than Function timeout: 30 seconds'));
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses a version or an alias the function hasn't, and a queue hiding a message for less than the longest timeout of the versions an alias runs", async () => {
    await expect(create({ qualifier: 'gone' })).rejects.toEqual(new BadRequestException('qualifier: the function has no alias gone'));
    await expect(create({ qualifier: '9' })).rejects.toEqual(new BadRequestException('qualifier: the function has no version 9'));
    await expect(create({ qualifier: 'canary' })).rejects.toEqual(new BadRequestException('Invalid parameter: Queue visibility timeout: 30 seconds is less than Function timeout: 60 seconds'));
    await expect(create({ qualifier: '3' })).rejects.toEqual(new BadRequestException('Invalid parameter: Queue visibility timeout: 30 seconds is less than Function timeout: 60 seconds'));
    expect(transaction).not.toHaveBeenCalled();

    // A change naming another is checked the same; one that keeps it, not.
    mappings.findOne.mockResolvedValue({ id: 'm-1', accountId: ACCOUNT, functionId: FUNCTION.id, queue: QUEUE, qualifier: 'live', batchSize: 10, maximumBatchingWindowInSeconds: 0 });
    await expect(service.update(ACCOUNT, 'm-1', { qualifier: 'canary' })).rejects.toEqual(
      new BadRequestException('Invalid parameter: Queue visibility timeout: 30 seconds is less than Function timeout: 60 seconds'),
    );
  });

  it("lists none for a queue that isn't the account's, as Lambda lists none, and refuses what is no queue's ARN", async () => {
    expect(await service.list(ACCOUNT, 'arn:aws:sqs:tn-tunis-1:000000000002:orders')).toEqual([]);
    queues.find.mockResolvedValueOnce(null);
    expect(await service.list(ACCOUNT, ARN)).toEqual([]);
    await expect(service.list(ACCOUNT, 'orders')).rejects.toBeInstanceOf(BadRequestException);
  });

  it("shows a mapping as Lambda's EventSourceMappingConfiguration", async () => {
    const row = {
      id: 'm-1',
      accountId: ACCOUNT,
      functionId: FUNCTION.id,
      queueId: QUEUE.id,
      queue: QUEUE,
      batchSize: 100,
      maximumBatchingWindowInSeconds: 5,
      reportBatchItemFailures: true,
      maximumConcurrency: 2,
      enabled: false,
      qualifier: null,
      updatedAt: new Date('2026-10-24T08:00:00Z'),
    } as unknown as EventSourceMapping;
    transaction.mockImplementation(async (work: (manager: unknown) => Promise<unknown>) =>
      work({ query: jest.fn(), findOneBy: jest.fn(async () => null), countBy: jest.fn(async () => 0), create: (_: unknown, values: unknown) => values, save: async () => row }),
    );

    expect(await create({})).toEqual({
      uuid: 'm-1',
      eventSourceArn: ARN,
      functionArn: `arn:aws:lambda:tn-tunis-1:${ACCOUNT}:function:orders-worker`,
      batchSize: 100,
      maximumBatchingWindowInSeconds: 5,
      functionResponseTypes: ['ReportBatchItemFailures'],
      scalingConfig: { maximumConcurrency: 2 },
      state: 'Disabled',
      stateTransitionReason: 'USER_INITIATED',
      lastModified: new Date('2026-10-24T08:00:00Z'),
    });
    // Through an alias, its ARN qualified, as Lambda's FunctionArn.
    row.qualifier = 'live';
    expect((await create({ qualifier: 'live' })).functionArn).toBe(`arn:aws:lambda:tn-tunis-1:${ACCOUNT}:function:orders-worker:live`);
  });
});

/**
 * L1: the routes of customers' queues in FF's API: who may call each, and
 * what the bodies may hold, through HTTP.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountStatus } from '../accounts/entities/account.entity';
import { Principal } from '../auth/principal';
import { ACTIVE_ACCOUNT, ROLES, SCOPE } from '../auth/route-rules';
import { QueuesController } from './queues.controller';
import { QueuesService } from './queues.service';

const ACCOUNT = '000000000001';
const reflector = new Reflector();
const rules = (handler: keyof QueuesController) => {
  const method = QueuesController.prototype[handler];
  return {
    roles: reflector.get<string[] | undefined>(ROLES, method) ?? 'anyone',
    activeAccount: reflector.get<boolean | undefined>(ACTIVE_ACCOUNT, method) ?? false,
    scope: reflector.get<string | undefined>(SCOPE, method) ?? 'no key',
  };
};

describe('/queues (L1)', () => {
  const queues = {
    list: jest.fn(async () => []),
    create: jest.fn(async () => ({})),
    get: jest.fn(async () => ({})),
    update: jest.fn(async () => ({})),
    remove: jest.fn(async () => undefined),
    purge: jest.fn(async () => undefined),
    send: jest.fn(async () => ({ messageId: 'm', md5OfBody: 'x' })),
    receive: jest.fn(async () => []),
    deleteMessage: jest.fn(async () => undefined),
  };
  const principal: Principal = { accountId: ACCOUNT, accountStatus: AccountStatus.ACTIVE, planId: 'beta', role: 'developer' };
  let app: INestApplication;
  let baseUrl: string;
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [QueuesController],
      providers: [{ provide: QueuesService, useValue: queues }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((req: { principal?: Principal }, _res: unknown, next: () => void) => {
      req.principal = principal;
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true })); // as main.ts
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('lets every member read them, writers change them, make them and send in an active account, and delete in any', () => {
    expect([rules('list'), rules('get')]).toEqual([
      { roles: 'anyone', activeAccount: false, scope: 'queues:read' },
      { roles: 'anyone', activeAccount: false, scope: 'queues:read' },
    ]);
    expect([rules('create'), rules('send')]).toEqual([
      { roles: ['owner', 'developer'], activeAccount: true, scope: 'queues:write' },
      { roles: ['owner', 'developer'], activeAccount: true, scope: 'queues:write' },
    ]);
    for (const handler of ['update', 'remove', 'purge', 'receive', 'deleteMessage'] as const) {
      expect(rules(handler)).toEqual({ roles: ['owner', 'developer'], activeAccount: false, scope: 'queues:write' });
    }
  });

  it("takes a queue's name and SQS's attributes, and passes them on", async () => {
    const body = { name: 'orders', visibilityTimeout: 60, redrivePolicy: { deadLetterTargetArn: 'arn:aws:sqs:tn-tunis-1:000000000001:orders-dlq', maxReceiveCount: 5 } };

    expect((await call('POST', '/queues', body)).status).toBe(201);
    expect(queues.create).toHaveBeenCalledWith(principal, body);
    expect((await call('PATCH', '/queues/orders', { redrivePolicy: null, delaySeconds: 10 })).status).toBe(200);
    expect(queues.update).toHaveBeenCalledWith(principal, 'orders', { redrivePolicy: null, delaySeconds: 10 });
  });

  it.each([
    [{ name: 'orders.fifo' }, "name must be 1 to 80 letters, digits, hyphens or underscores, as an SQS queue's name"],
    [{ name: 'x'.repeat(81) }, 'name must be shorter than or equal to 80 characters'],
    [{ name: 'orders', visibilityTimeout: 43_201 }, 'visibilityTimeout must not be greater than 43200'],
    [{ name: 'orders', messageRetentionPeriod: 59 }, 'messageRetentionPeriod must not be less than 60'],
    [{ name: 'orders', maximumMessageSize: 1023 }, 'maximumMessageSize must not be less than 1024'],
    [{ name: 'orders', receiveMessageWaitTimeSeconds: 21 }, 'receiveMessageWaitTimeSeconds must not be greater than 20'],
    [{ name: 'orders', redrivePolicy: { deadLetterTargetArn: 'arn:aws:sqs:tn-tunis-1:000000000001:dlq', maxReceiveCount: 0 } }, 'redrivePolicy.maxReceiveCount must not be less than 1'],
    [{ name: 'orders', fifoQueue: true }, 'property fifoQueue should not exist'],
  ])('refuses %j to make a queue, saying why', async (body, problem) => {
    const res = await call('POST', '/queues', body);

    expect([res.status, (await res.json()).message]).toEqual([400, expect.arrayContaining([problem])]);
    expect(queues.create).not.toHaveBeenCalled();
  });

  it('sends a message, receives up to ten, and deletes one by its receipt handle', async () => {
    expect((await call('POST', '/queues/orders/messages', { body: '{"order":1}', delaySeconds: 5, attributes: { item: { dataType: 'String', stringValue: 'harissa' } } })).status).toBe(201);
    expect(queues.send).toHaveBeenCalledWith(principal, 'orders', { body: '{"order":1}', delaySeconds: 5, attributes: { item: { dataType: 'String', stringValue: 'harissa' } } });
    expect((await call('POST', '/queues/orders/receive', { maxMessages: 10, waitTimeSeconds: 2 })).status).toBe(200);
    expect(queues.receive).toHaveBeenCalledWith(principal, 'orders', { maxMessages: 10, waitTimeSeconds: 2 }, expect.any(AbortSignal));
    expect((await call('DELETE', '/queues/orders/messages/aGFuZGxl')).status).toBe(204);
    expect(queues.deleteMessage).toHaveBeenCalledWith(principal, 'orders', 'aGFuZGxl');
  });

  it.each([
    ['POST', '/queues/orders/messages', { delaySeconds: 1 }, 'body must be a string'],
    ['POST', '/queues/orders/messages', { body: 'x', delaySeconds: 901 }, 'delaySeconds must not be greater than 900'],
    ['POST', '/queues/orders/receive', { maxMessages: 11 }, 'maxMessages must not be greater than 10'],
    ['POST', '/queues/orders/receive', { waitTimeSeconds: 21 }, 'waitTimeSeconds must not be greater than 20'],
  ])('refuses %s %s with %j, saying why', async (method, path, body, problem) => {
    const res = await call(method, path, body);

    expect([res.status, (await res.json()).message]).toEqual([400, expect.arrayContaining([problem])]);
  });
});

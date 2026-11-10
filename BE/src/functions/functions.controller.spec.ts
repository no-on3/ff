/**
 * L1: who may call each function route (client-readiness plan, P-12, D4), as
 * the routes declare it for the global guard: writers (owners and developers)
 * change and invoke functions, viewers only read, and an account deploys and
 * invokes only once it is approved. The logs routes through HTTP (P-40, P-43).
 */
import { BadRequestException, INestApplication, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountStatus } from '../accounts/entities/account.entity';
import { Principal } from '../auth/principal';
import { RequestIdInterceptor } from '../common/request-context';
import { ACTIVE_ACCOUNT, ROLES, SCOPE } from '../auth/route-rules';
import { INVOCATION } from '../plans/rate-limits';
import { FunctionsController, codeFileName, invocationTypeOf } from './functions.controller';
import { FunctionsService } from './functions.service';
import { StacksService } from '../stacks/stacks.service';
import { KeyUses } from '../storage/key-uses.service';
import { ResourceTagsService } from '../tags/resource-tags.service';
import { AsyncInvocationsService } from './async-invocations.service';
import { EventInvokeConfigService } from './event-invoke-config.service';
import { InvocationType } from './dto/invoke-function.dto';
import { of } from 'rxjs';

const ACCOUNT = '000000000001';
const ID = '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f';
/** A trace the call started, as AWS X-Ray writes one. */
const NEW_TRACE = expect.stringMatching(/^1-[0-9a-f]{8}-[0-9a-f]{24}$/);

/**
 * The controller over HTTP, its services the given stand-ins, set up as main.ts and app.module.ts set the API up: the
 * validation pipe, and the request ID's interceptor, which changes how Nest runs a handler, and so how a failure
 * reaches the caller. Its caller is a member of the role given, of an approved account.
 */
async function serve(
  role: Principal['role'],
  functions: object,
  {
    asyncInvocations = {},
    keyUses = {},
    stacks = { ofFunctions: async () => new Map() },
    configs = {},
    tags = { of: async () => ({}) },
  }: { asyncInvocations?: object; keyUses?: object; stacks?: object; configs?: object; tags?: object } = {},
): Promise<{ app: INestApplication; baseUrl: string }> {
  const moduleRef = await Test.createTestingModule({
    controllers: [FunctionsController],
    providers: [
      { provide: FunctionsService, useValue: functions },
      { provide: AsyncInvocationsService, useValue: asyncInvocations },
      { provide: KeyUses, useValue: keyUses },
      { provide: StacksService, useValue: stacks },
      { provide: EventInvokeConfigService, useValue: configs },
      { provide: ResourceTagsService, useValue: tags },
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.use((req: { principal?: Principal }, _res: unknown, next: () => void) => {
    req.principal = { accountId: ACCOUNT, accountStatus: AccountStatus.ACTIVE, planId: 'beta', role };
    next();
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.useGlobalInterceptors(new RequestIdInterceptor());
  await app.listen(0, '127.0.0.1');
  return { app, baseUrl: await app.getUrl() };
}

const reflector = new Reflector();
const rules = (handler: keyof FunctionsController) => {
  const method = FunctionsController.prototype[handler];
  return {
    roles: reflector.get<string[] | undefined>(ROLES, method) ?? 'anyone',
    activeAccount: reflector.get<boolean | undefined>(ACTIVE_ACCOUNT, method) ?? false,
    scope: reflector.get<string | undefined>(SCOPE, method) ?? 'no key',
  };
};

describe('FunctionsController route rules (L1, P-12, P-13)', () => {
  it.each<[keyof FunctionsController, string, string]>([
    ['create', 'POST /functions', 'functions:write'],
    ['update', 'PUT /functions/:id', 'functions:write'],
    ['invoke', 'POST /functions/:id/invoke', 'functions:invoke'],
    ['updateScalingConfig', 'PUT /functions/:id/scaling-config', 'functions:write'],
  ])('%s (%s): writers only, an approved account, and a key with %s', (handler, _route, scope) => {
    expect(rules(handler)).toEqual({ roles: ['owner', 'developer'], activeAccount: true, scope });
  });

  it('lets writers delete, even in an account that is not active: deleting frees what it holds', () => {
    expect(rules('remove')).toEqual({ roles: ['owner', 'developer'], activeAccount: false, scope: 'functions:write' });
  });

  it.each<keyof FunctionsController>(['findAll', 'findOne', 'code', 'keyUsesOf', 'getInvocations', 'getScalingConfig'])(
    '%s: every member reads, viewers included, and a key with functions:read',
    (handler) => {
      expect(rules(handler)).toEqual({ roles: 'anyone', activeAccount: false, scope: 'functions:read' });
    },
  );

  it.each<keyof FunctionsController>(['logs', 'logsStream'])('%s: every member reads them, viewers included, and a key with logs:read (P-40, P-43)', (handler) => {
    expect(rules(handler)).toEqual({ roles: 'anyone', activeAccount: false, scope: 'logs:read' });
  });

  it("counts only invoke against the plan's invocation rate; every other change counts against its rate of changes (P-15)", () => {
    const handlers = Object.getOwnPropertyNames(FunctionsController.prototype).filter((name) => name !== 'constructor');
    const invocations = handlers.filter((name) =>
      reflector.get<boolean>(INVOCATION, FunctionsController.prototype[name as keyof FunctionsController]),
    );

    expect(invocations).toEqual(['invoke']);
  });
});

describe("POST /functions/:id/invoke's invocation types, as AWS Lambda's (L1)", () => {
  const functions = { invoke: jest.fn(async (..._call: unknown[]) => ({ id: 'inv-1', status: 'COMPLETED', output: 1 })) };
  const asyncInvocations = {
    queue: jest.fn(async (...call: unknown[]) => ({ requestId: 'req-1', traceId: call[4] })),
    dryRun: jest.fn(async (..._call: unknown[]) => undefined),
  };
  let app: INestApplication;
  let baseUrl: string;
  const invoke = (body: object, type?: string, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}/functions/${ID}/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(type === undefined ? {} : { 'X-Amz-Invocation-Type': type }), ...headers },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    ({ app, baseUrl } = await serve('developer', functions, { asyncInvocations }));
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('waits for the call without a type, or with RequestResponse: 201 and the invocation', async () => {
    const plain = await invoke({ input: { a: 1 } });
    const named = await invoke({ input: 2 }, 'RequestResponse');

    expect([plain.status, named.status]).toEqual([201, 201]);
    expect(functions.invoke.mock.calls).toEqual([
      [ACCOUNT, ID, { a: 1 }, undefined, NEW_TRACE],
      [ACCOUNT, ID, 2, undefined, NEW_TRACE],
    ]);
    expect(asyncInvocations.queue).not.toHaveBeenCalled();
  });

  it("passes a qualifier on as Lambda's: $LATEST, a version's number or an alias's name; anything else is refused, and calls nothing", async () => {
    for (const qualifier of ['$LATEST', '3', 'prod']) expect((await invoke({ qualifier })).status).toBe(201);
    expect(functions.invoke.mock.calls.map((call) => call[3])).toEqual(['$LATEST', '3', 'prod']);

    functions.invoke.mockClear();
    for (const qualifier of ['0', '07', 'a.b', '$latest', 'x'.repeat(129), 3]) {
      const res = await invoke({ qualifier });
      expect([qualifier, res.status]).toEqual([qualifier, 400]);
    }
    expect(functions.invoke).not.toHaveBeenCalled();
  });

  it('passes the qualifier on to a call that does not wait, an Event or a DryRun, as to one that does', async () => {
    const event = await invoke({ qualifier: 'prod' }, 'Event');
    const dryRun = await invoke({ qualifier: '2', invocationType: 'DryRun' });
    const latest = await invoke({ qualifier: '$LATEST' }, 'Event');

    expect([event.status, dryRun.status, latest.status]).toEqual([202, 204, 202]);
    expect(asyncInvocations.queue.mock.calls).toEqual([
      [ACCOUNT, ID, undefined, 'prod', NEW_TRACE],
      [ACCOUNT, ID, undefined, '$LATEST', NEW_TRACE],
    ]);
    expect(asyncInvocations.dryRun.mock.calls).toEqual([[ACCOUNT, ID, undefined, '2']]);
  });

  it('keeps an Event, named by the header or the body, and answers 202 with its request ID at once', async () => {
    const byHeader = await invoke({ input: { a: 1 } }, 'Event');
    const byBody = await invoke({ input: 'x', invocationType: 'Event' });

    expect([byHeader.status, await byHeader.json(), byBody.status]).toEqual([202, { requestId: 'req-1', traceId: NEW_TRACE }, 202]);
    expect(asyncInvocations.queue.mock.calls).toEqual([
      [ACCOUNT, ID, { a: 1 }, undefined, NEW_TRACE],
      [ACCOUNT, ID, 'x', undefined, NEW_TRACE],
    ]);
    expect(functions.invoke).not.toHaveBeenCalled();
  });

  it("makes each call part of its caller's trace, X-Amzn-Trace-Id's Root, or of a new one, and gives it back in that header", async () => {
    const traced = await invoke({}, undefined, { 'X-Amzn-Trace-Id': 'Parent=53995c3f42cd8ad8;Root=1-5759E988-BD862E3FE1BE46A994272793;Sampled=1' });
    const started = await invoke({});
    const queued = await invoke({}, 'Event', { 'X-Amzn-Trace-Id': 'Root=1-5759e988-bd862e3fe1be46a994272793' });
    const unreadable = await invoke({}, undefined, { 'X-Amzn-Trace-Id': 'Root=1-not-a-trace' });

    const given = [functions.invoke.mock.calls[0][4], functions.invoke.mock.calls[1][4], asyncInvocations.queue.mock.calls[0][4], functions.invoke.mock.calls[2][4]];
    expect(given).toEqual(['1-5759e988-bd862e3fe1be46a994272793', NEW_TRACE, '1-5759e988-bd862e3fe1be46a994272793', NEW_TRACE]);
    expect([given[1], given[3]]).not.toContain('1-5759e988-bd862e3fe1be46a994272793');
    expect([traced, started, queued, unreadable].map((res) => res.headers.get('x-amzn-trace-id'))).toEqual(given.map((traceId) => `Root=${String(traceId)}`));
    expect(await queued.json()).toEqual({ requestId: 'req-1', traceId: '1-5759e988-bd862e3fe1be46a994272793' });
  });

  it('only checks a DryRun: 204, with no body', async () => {
    const res = await invoke({ input: { a: 1 } }, 'DryRun');

    expect([res.status, await res.text()]).toEqual([204, '']);
    expect(asyncInvocations.dryRun).toHaveBeenCalledWith(ACCOUNT, ID, { a: 1 }, undefined);
    expect([functions.invoke.mock.calls.length, asyncInvocations.queue.mock.calls.length]).toEqual([0, 0]);
  });

  it("takes the header's type over the body's, as Lambda reads the header", async () => {
    await invoke({ invocationType: 'Event' }, 'RequestResponse');

    expect([functions.invoke.mock.calls.length, asyncInvocations.queue.mock.calls.length]).toEqual([1, 0]);
  });

  it('refuses a type Lambda has not, in the header or the body, and calls nothing', async () => {
    const header = await invoke({}, 'Later');
    const body = await invoke({ invocationType: 'event' });

    expect([header.status, (await header.json()).message, body.status]).toEqual([
      400,
      'X-Amz-Invocation-Type must be RequestResponse, Event, DryRun: "Later" is none of them',
      400,
    ]);
    expect([functions.invoke.mock.calls.length, asyncInvocations.queue.mock.calls.length]).toEqual([0, 0]);
  });

  it('reads the type as Lambda does: the header, else the body, else RequestResponse', () => {
    expect([invocationTypeOf(undefined, undefined), invocationTypeOf(undefined, InvocationType.EVENT), invocationTypeOf('DryRun', InvocationType.EVENT)]).toEqual([
      InvocationType.REQUEST_RESPONSE,
      InvocationType.EVENT,
      InvocationType.DRY_RUN,
    ]);
  });
});

describe('GET /functions/:id/logs (L1, P-40, P-43)', () => {
  const LOGS = { lines: [{ time: '2026-10-17T10:00:00.000000000Z', instance: 'fn-a', requestId: null, stream: 'stdout', message: 'hi' }], next: 'older' };
  const functions = {
    logs: jest.fn(async () => LOGS),
    liveLogs: jest.fn(async (..._args: unknown[]) => of({ data: LOGS.lines[0] }, { type: 'ping', data: '' }, { type: 'end', data: { message: 'over' } })),
  };
  let app: INestApplication;
  let baseUrl: string;
  const get = (query: string) => fetch(`${baseUrl}/functions/${ID}/logs${query}`);

  beforeAll(async () => {
    ({ app, baseUrl } = await serve('viewer', functions));
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it("gives the caller's account's function's page, the service choosing the defaults", async () => {
    const res = await get('');

    expect([res.status, await res.json()]).toEqual([200, LOGS]);
    expect(functions.logs).toHaveBeenCalledWith(ACCOUNT, ID, {});
  });

  it("passes `ff logs`'s tail and window on, as numbers", async () => {
    await get('?tail=1000&sinceSeconds=2592000');

    expect(functions.logs).toHaveBeenCalledWith(ACCOUNT, ID, { tail: 1000, sinceSeconds: 2592000 });
  });

  it("passes the store's parameters on: the page's size, the window, the phrase, the call and the cursor", async () => {
    const callId = '0b7c6f2e-5d1a-4c3b-9e8f-7a6b5c4d3e2f';
    await get(`?limit=50&start=2026-10-17T10:00:00Z&end=2026-10-17T11:00:00.5%2B01:00&q=${encodeURIComponent('a "time out"')}&requestId=${callId}&cursor=eyJiIjoiMjAyNi0xMC0xN1QxMDowMDowMloiLCJzIjoxfQ`);

    expect(functions.logs).toHaveBeenCalledWith(ACCOUNT, ID, {
      limit: 50,
      start: '2026-10-17T10:00:00Z',
      end: '2026-10-17T11:00:00.5+01:00',
      q: 'a "time out"',
      requestId: callId,
      cursor: 'eyJiIjoiMjAyNi0xMC0xN1QxMDowMDowMloiLCJzIjoxfQ',
    });
  });

  it.each([
    ['?tail=0', 'tail must not be less than 1'],
    ['?tail=1001', 'tail must not be greater than 1000'],
    ['?tail=many', 'tail must be an integer number'],
    ['?limit=0', 'limit must not be less than 1'],
    ['?limit=1001', 'limit must not be greater than 1000'],
    ['?sinceSeconds=0', 'sinceSeconds must not be less than 1'],
    ['?sinceSeconds=2592001', 'sinceSeconds must not be greater than 2592000'],
    ['?start=2026-10-17', 'start must be an RFC 3339 time, such as 2026-10-17T10:00:00Z'],
    ['?end=yesterday', 'end must be an RFC 3339 time, such as 2026-10-17T11:00:00Z'],
    [`?q=${'x'.repeat(501)}`, 'q must be shorter than or equal to 500 characters'],
    ['?q=%20%20', 'q must have a character other than a space'],
    ['?requestId=req-1', 'requestId must be a UUID'],
    ['?cursor=a%20b', 'cursor must be the next value of the page before'],
    ['?follow=true', 'property follow should not exist'],
  ])('refuses %s', async (query, message) => {
    const res = await get(query);

    expect([res.status, (await res.json()).message]).toEqual([400, expect.arrayContaining([message])]);
    expect(functions.logs).not.toHaveBeenCalled();
  });

  it('refuses an ID that is not one', async () => {
    expect((await fetch(`${baseUrl}/functions/fn-1/logs`)).status).toBe(400);
    expect(functions.logs).not.toHaveBeenCalled();
  });

  describe('GET /functions/:id/logs/stream (P-43)', () => {
    it("streams the service's events as Server-Sent Events, with the filter and the request's signal", async () => {
      const res = await get(`/stream?q=time%20out&requestId=0b7c6f2e-5d1a-4c3b-9e8f-7a6b5c4d3e2f`);

      expect([res.status, res.headers.get('content-type'), res.headers.get('x-accel-buffering')]).toEqual([200, 'text/event-stream', 'no']);
      // Numbered events, the stream ending with them.
      expect(await res.text()).toBe(
        `id: 1\ndata: ${JSON.stringify(LOGS.lines[0])}\n\nevent: ping\nid: 2\ndata: \n\nevent: end\nid: 3\ndata: {"message":"over"}\n\n`,
      );
      const [account, id, query, signal] = functions.liveLogs.mock.calls[0];
      expect([account, id, query]).toEqual([ACCOUNT, ID, { q: 'time out', requestId: '0b7c6f2e-5d1a-4c3b-9e8f-7a6b5c4d3e2f' }]);
      expect(signal).toBeInstanceOf(AbortSignal);
    });

    it("answers another account's function with a JSON 404, before any event", async () => {
      // After a database query's time: the check is done by then, and nothing was sent yet.
      functions.liveLogs.mockImplementationOnce(
        () => new Promise((_, reject) => setTimeout(() => reject(new NotFoundException(`Function with ID ${ID} not found`)), 20)),
      );

      const res = await get('/stream');

      expect([res.status, res.headers.get('content-type')?.split(';')[0], (await res.json()).message]).toEqual([
        404,
        'application/json',
        `Function with ID ${ID} not found`,
      ]);
    });

    it.each([
      ['?requestId=req-1', 'requestId must be a UUID'],
      ['?q=%20', 'q must have a character other than a space'],
      ['?limit=5', 'property limit should not exist'],
    ])('refuses %s', async (query, message) => {
      const res = await get(`/stream${query}`);

      expect([res.status, (await res.json()).message]).toEqual([400, expect.arrayContaining([message])]);
      expect(functions.liveLogs).not.toHaveBeenCalled();
    });
  });
});

describe("GET /functions/:id/code: the function's code, as a zip AWS Lambda takes (L1)", () => {
  /** An empty zip: its end of central directory alone. */
  const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);
  const functions = { code: jest.fn(async (..._args: unknown[]) => ({ name: 'orders', zip: ZIP })) };
  let app: INestApplication;
  let baseUrl: string;
  const get = (query = '') => fetch(`${baseUrl}/functions/${ID}/code${query}`);

  beforeAll(async () => {
    ({ app, baseUrl } = await serve('viewer', functions));
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it("gives the caller's account's function's zip, a file named after it, with its length", async () => {
    const res = await get();

    expect([res.status, res.headers.get('content-type'), res.headers.get('content-disposition'), res.headers.get('content-length')]).toEqual([
      200,
      'application/zip',
      'attachment; filename="orders.zip"',
      String(ZIP.length),
    ]);
    expect(Buffer.from(await res.arrayBuffer()).equals(ZIP)).toBe(true);
    expect(functions.code).toHaveBeenCalledWith(ACCOUNT, ID, { javascript: false });
  });

  it('asks for JavaScript with javascript=true, and refuses what is neither true nor false, calling nothing', async () => {
    await get('?javascript=true');
    const refused = await get('?javascript=yes');

    expect(functions.code.mock.calls).toEqual([[ACCOUNT, ID, { javascript: true }]]);
    expect([refused.status, (await refused.json()).message]).toEqual([400, 'javascript must be true or false']);
  });

  it("names the file after a name from before Lambda's rule too, a character the rule refuses made _, as a header holds it", async () => {
    functions.code.mockResolvedValueOnce({ name: 'commandes "été"', zip: ZIP });

    expect((await get()).headers.get('content-disposition')).toBe('attachment; filename="commandes___t__.zip"');
    expect(codeFileName('orders-v2_eu')).toBe('orders-v2_eu.zip');
  });

  it('refuses an ID that is not one', async () => {
    expect((await fetch(`${baseUrl}/functions/fn-1/code`)).status).toBe(400);
    expect(functions.code).not.toHaveBeenCalled();
  });
});

describe("GET /functions/:id/key-uses: what the function's keys used, which an export's role grants (L1)", () => {
  const USES = [{ service: 'sqs', resource: 'orders', operation: 'SendMessage', firstDay: '2026-10-31', lastDay: '2026-11-02' }];
  const functions = {
    findOne: jest.fn(async (accountId: string, id: string) => {
      if (id !== ID) throw new NotFoundException(`Function with ID ${id} not found`);
      return { id, accountId };
    }),
  };
  const keyUses = { of: jest.fn(async () => USES) };
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    ({ app, baseUrl } = await serve('viewer', functions, { keyUses }));
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it("gives the uses of the caller's account's function, read under the function, which holds its keys' uses", async () => {
    const res = await fetch(`${baseUrl}/functions/${ID}/key-uses`);

    expect([res.status, await res.json()]).toEqual([200, { uses: USES }]);
    expect(functions.findOne).toHaveBeenCalledWith(ACCOUNT, ID);
    expect(keyUses.of).toHaveBeenCalledWith(ACCOUNT, ID);
  });

  it("answers another account's function, or none, with 404, reading no uses", async () => {
    const res = await fetch(`${baseUrl}/functions/00000000-0000-4000-8000-000000000000/key-uses`);

    expect([res.status, (await res.json()).message]).toEqual([404, 'Function with ID 00000000-0000-4000-8000-000000000000 not found']);
    expect(keyUses.of).not.toHaveBeenCalled();
  });
});

describe('the stack a function is in, in the answers for it (L1)', () => {
  const orders = { id: ID, accountId: ACCOUNT, name: 'orders' };
  const reports = { id: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a', accountId: ACCOUNT, name: 'reports' };
  const functions = {
    findAll: jest.fn(async () => [orders, reports]),
    describe: jest.fn(async () => ({ ...orders, environment: {} })),
    startUpdate: jest.fn(async () => ({ rollOut: async () => ({ ...orders, environment: {} }) })),
  };
  const stacks = { ofFunctions: jest.fn(async () => new Map([['orders', 'shop']])) };
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    ({ app, baseUrl } = await serve('developer', functions, { stacks }));
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it("names each listed function's stack, null for one in none, asked once for the whole list", async () => {
    const res = await fetch(`${baseUrl}/functions`);

    expect([res.status, ((await res.json()) as { name: string; stack: string | null }[]).map(({ name, stack }) => [name, stack])]).toEqual([
      200,
      [
        ['orders', 'shop'],
        ['reports', null],
      ],
    ]);
    expect(stacks.ofFunctions.mock.calls).toEqual([[ACCOUNT, ['orders', 'reports']]]);
  });

  it("names it in a function's own answer, and after a change", async () => {
    const read = await fetch(`${baseUrl}/functions/${ID}`);
    const changed = await fetch(`${baseUrl}/functions/${ID}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ memory: 256 }) });

    expect([read.status, (await read.json()).stack, changed.status, (await changed.json()).stack]).toEqual([200, 'shop', 200, 'shop']);
    expect(stacks.ofFunctions).toHaveBeenCalledWith(ACCOUNT, ['orders']);
  });
});

describe("a function's description, dead-letter queue and tags, as Lambda's, through FF's API (L1)", () => {
  const QUEUE = 'arn:aws:sqs:tn-tunis-1:000000000001:orders-failed';
  const orders = { id: ID, accountId: ACCOUNT, name: 'orders', environment: {} };
  const rollingOut = (answer: Promise<object>) => async () => ({ rollOut: () => answer });
  const functions = { startCreate: jest.fn(rollingOut(Promise.resolve(orders))), startUpdate: jest.fn(rollingOut(Promise.resolve(orders))) };
  const configs = { checkedQueue: jest.fn(async (_accountId: string, _field: string, arn: string) => arn) };
  const tags = { of: jest.fn(async () => ({ team: 'orders' })), replace: jest.fn(async () => undefined) };
  let app: INestApplication;
  let baseUrl: string;
  const send = (method: 'POST' | 'PUT', body: object) =>
    fetch(`${baseUrl}/functions${method === 'PUT' ? `/${ID}` : ''}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const created = { name: 'orders', runtime: 'nodejs', code: 'export const handler = () => 1', memory: 128, timeout: 3 };

  beforeAll(async () => {
    ({ app, baseUrl } = await serve('developer', functions, { configs, tags }));
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it("gives the description and the queue, checked the account's, to the function's change, and puts the tags once it is live, answering them", async () => {
    const res = await send('POST', { ...created, description: 'Takes orders', deadLetterTargetArn: QUEUE, tags: { team: 'orders' } });

    expect([res.status, (await res.json()).tags]).toEqual([201, { team: 'orders' }]);
    expect(configs.checkedQueue.mock.calls).toEqual([[ACCOUNT, 'deadLetterTargetArn', QUEUE]]);
    expect(functions.startCreate.mock.calls).toEqual([[ACCOUNT, created, { description: 'Takes orders', deadLetterTargetArn: QUEUE }]]);
    expect(tags.replace.mock.calls).toEqual([[ACCOUNT, { kind: 'function', id: ID, resource: `function:${ID}` }, { team: 'orders' }]]);
  });

  it('on an update, replaces the tags sent, {} removing them, keeps them when none are sent, and removes the queue for null', async () => {
    expect((await send('PUT', { tags: {} })).status).toBe(200);
    expect((await send('PUT', { memory: 256, deadLetterTargetArn: null })).status).toBe(200);

    expect(tags.replace.mock.calls).toEqual([[ACCOUNT, { kind: 'function', id: ID, resource: `function:${ID}` }, {}]]);
    expect(functions.startUpdate.mock.calls).toEqual([
      [ACCOUNT, ID, {}, { description: undefined, deadLetterTargetArn: undefined }],
      [ACCOUNT, ID, { memory: 256 }, { description: undefined, deadLetterTargetArn: null }],
    ]);
    expect(configs.checkedQueue).not.toHaveBeenCalled();
  });

  it("leaves the tags as they were when the change fails, as it leaves the rest; a queue the account hasn't stops it before it starts", async () => {
    functions.startUpdate.mockImplementationOnce(rollingOut(Promise.reject(new NotFoundException('gone meanwhile'))));
    configs.checkedQueue.mockRejectedValueOnce(new BadRequestException('deadLetterTargetArn: the account has no queue named "orders-failed"'));

    expect((await send('PUT', { tags: { team: 'orders' } })).status).toBe(404);
    const refused = await send('PUT', { deadLetterTargetArn: QUEUE });

    expect([refused.status, (await refused.json()).message]).toEqual([400, 'deadLetterTargetArn: the account has no queue named "orders-failed"']);
    expect([tags.replace.mock.calls, functions.startUpdate.mock.calls.length]).toEqual([[], 1]);
  });

  it("refuses a description past Lambda's 256 characters and tags AWS wouldn't take, before anything changes", async () => {
    const refusal = async (body: object) => {
      const res = await send('POST', { ...created, ...body });
      return [res.status, (await res.json()).message];
    };

    expect(await refusal({ description: 'd'.repeat(257) })).toEqual([400, ['description must be shorter than or equal to 256 characters']]);
    expect(await refusal({ tags: { 'aws:team': 'orders' } })).toEqual([400, ['The key aws:team starts with aws:, which AWS keeps for its own tags.']]);
    expect(await refusal({ tags: ['team'] })).toEqual([400, ["Tags are an object, each tag's value by its key."]]);
    expect(await refusal({ deadLetterTargetArn: 42 })).toEqual([400, ['deadLetterTargetArn must be shorter than or equal to 256 characters', 'deadLetterTargetArn must be a string']]);
    expect([functions.startCreate, configs.checkedQueue].map((mock) => mock.mock.calls.length)).toEqual([0, 0]);
  });
});

describe('GET /functions/:id/invocations through HTTP (L1)', () => {
  const functions = { getInvocations: jest.fn(async (..._call: unknown[]) => ({ invocations: [], total: 0 })) };
  let app: INestApplication;
  let baseUrl: string;
  const list = (query: string) => fetch(`${baseUrl}/functions/${ID}/invocations${query}`);

  beforeAll(async () => {
    ({ app, baseUrl } = await serve('viewer', functions));
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('passes a page of every call on by default, and the calls a filter keeps: what they named, what ran them, or both', async () => {
    for (const query of ['', '?limit=5&offset=10', '?resource=live', '?resource=%24LATEST', '?executedVersion=2', '?resource=live&executedVersion=$LATEST']) {
      expect([query, (await list(query)).status]).toEqual([query, 200]);
    }
    expect(functions.getInvocations.mock.calls.map(([, , page]) => page)).toEqual([
      { limit: 10, offset: 0 },
      { limit: 5, offset: 10 },
      { limit: 10, offset: 0, resource: 'live' },
      { limit: 10, offset: 0, resource: '$LATEST' },
      { limit: 10, offset: 0, executedVersion: '2' },
      { limit: 10, offset: 0, resource: 'live', executedVersion: '$LATEST' },
    ]);
  });

  it('refuses a resource that is no qualifier and an executed version that is no version, and reads nothing', async () => {
    const refused = async (query: string) => {
      const res = await list(query);
      return [res.status, (await res.json()).message];
    };

    expect(await refused('?resource=a.b')).toEqual([400, ['resource must be $LATEST, a version number or an alias name']]);
    expect(await refused('?resource=0')).toEqual([400, ['resource must be $LATEST, a version number or an alias name']]);
    expect(await refused('?executedVersion=live')).toEqual([400, ['executedVersion must be $LATEST or a version number']]);
    expect(await refused('?version=2')).toEqual([400, ['property version should not exist']]);
    expect(functions.getInvocations).not.toHaveBeenCalled();
  });
});

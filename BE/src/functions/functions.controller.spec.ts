/**
 * L1: who may call each function route (client-readiness plan, P-12, D4), as
 * the routes declare it for the global guard: writers (owners and developers)
 * change and invoke functions, viewers only read, and an account deploys and
 * invokes only once it is approved. The logs routes through HTTP (P-40, P-43).
 */
import { INestApplication, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountStatus } from '../accounts/entities/account.entity';
import { Principal } from '../auth/principal';
import { RequestIdInterceptor } from '../common/request-context';
import { ACTIVE_ACCOUNT, ROLES, SCOPE } from '../auth/route-rules';
import { INVOCATION } from '../plans/rate-limits';
import { FunctionsController, codeFileName, invocationTypeOf } from './functions.controller';
import { FunctionsService } from './functions.service';
import { AsyncInvocationsService } from './async-invocations.service';
import { InvocationType } from './dto/invoke-function.dto';
import { of } from 'rxjs';

const ACCOUNT = '000000000001';
const ID = '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f';

/**
 * The controller over HTTP, its services the given stand-ins, set up as main.ts and app.module.ts set the API up: the
 * validation pipe, and the request ID's interceptor, which changes how Nest runs a handler, and so how a failure
 * reaches the caller. Its caller is a member of the role given, of an approved account.
 */
async function serve(role: Principal['role'], functions: object, asyncInvocations: object = {}): Promise<{ app: INestApplication; baseUrl: string }> {
  const moduleRef = await Test.createTestingModule({
    controllers: [FunctionsController],
    providers: [
      { provide: FunctionsService, useValue: functions },
      { provide: AsyncInvocationsService, useValue: asyncInvocations },
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

  it.each<keyof FunctionsController>(['findAll', 'findOne', 'code', 'getInvocations', 'getScalingConfig'])(
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
  const functions = { invoke: jest.fn(async () => ({ id: 'inv-1', status: 'COMPLETED', output: 1 })) };
  const asyncInvocations = { queue: jest.fn(async () => ({ requestId: 'req-1' })), dryRun: jest.fn(async () => undefined) };
  let app: INestApplication;
  let baseUrl: string;
  const invoke = (body: object, type?: string) =>
    fetch(`${baseUrl}/functions/${ID}/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(type === undefined ? {} : { 'X-Amz-Invocation-Type': type }) },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    ({ app, baseUrl } = await serve('developer', functions, asyncInvocations));
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('waits for the call without a type, or with RequestResponse: 201 and the invocation', async () => {
    const plain = await invoke({ input: { a: 1 } });
    const named = await invoke({ input: 2 }, 'RequestResponse');

    expect([plain.status, named.status]).toEqual([201, 201]);
    expect(functions.invoke.mock.calls).toEqual([
      [ACCOUNT, ID, { a: 1 }],
      [ACCOUNT, ID, 2],
    ]);
    expect(asyncInvocations.queue).not.toHaveBeenCalled();
  });

  it('keeps an Event, named by the header or the body, and answers 202 with its request ID at once', async () => {
    const byHeader = await invoke({ input: { a: 1 } }, 'Event');
    const byBody = await invoke({ input: 'x', invocationType: 'Event' });

    expect([byHeader.status, await byHeader.json(), byBody.status]).toEqual([202, { requestId: 'req-1' }, 202]);
    expect(asyncInvocations.queue.mock.calls).toEqual([
      [ACCOUNT, ID, { a: 1 }],
      [ACCOUNT, ID, 'x'],
    ]);
    expect(functions.invoke).not.toHaveBeenCalled();
  });

  it('only checks a DryRun: 204, with no body', async () => {
    const res = await invoke({ input: { a: 1 } }, 'DryRun');

    expect([res.status, await res.text()]).toEqual([204, '']);
    expect(asyncInvocations.dryRun).toHaveBeenCalledWith(ACCOUNT, ID, { a: 1 });
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

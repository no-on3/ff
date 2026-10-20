/**
 * L1: the support routes of the admin dashboard through HTTP, with the
 * validation main.ts sets up: what each passes to the service, and what each
 * refuses. The service runs against PostgreSQL in admin-support.db.spec.ts;
 * who may call them is the guard's (auth.guard.spec.ts).
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AdminSupportController } from './admin-support.controller';
import { AdminSupportService, errorType } from './admin-support.service';
import { IS_ADMIN } from './operator';

const FN = '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f';
const CALL = '0b7c6f2e-5d1a-4c3b-9e8f-7a6b5c4d3e2f';
const REASON = 'The customer asked why their calls fail';

describe('the support routes of the admin dashboard (L1)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const support = {
    search: jest.fn(async () => ({ accounts: [], functions: [], calls: [] })),
    functionPage: jest.fn(async () => ({ function: { id: FN } })),
    viewCode: jest.fn(async () => ({ runtime: 'nodejs', code: 'export const handler = async () => 1;' })),
    viewCall: jest.fn(async () => ({ id: CALL })),
    viewLogs: jest.fn(async () => ({ lines: [], next: null })),
  };

  const call = (method: string, path: string, body?: object) =>
    fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const refusal = async (res: Response) => [res.status, (await res.json()).message];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminSupportController],
      providers: [{ provide: AdminSupportService, useValue: support }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true })); // as main.ts
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it("are the admin dashboard's routes: operators only", () => {
    expect(new Reflector().get(IS_ADMIN, AdminSupportController)).toBe(true);
  });

  it('searches for the text given, and refuses none, only spaces, or more than 200 characters', async () => {
    const res = await call('GET', '/admin/search?q=amira%40ff.test');
    expect(res.status).toBe(200);
    expect(support.search).toHaveBeenCalledWith('amira@ff.test');

    expect(await refusal(await call('GET', '/admin/search'))).toEqual([400, expect.arrayContaining(['q must be a string'])]);
    expect(await refusal(await call('GET', '/admin/search?q=%20%20'))).toEqual([400, ['q must have a character other than a space']]);
    expect(await refusal(await call('GET', `/admin/search?q=${'x'.repeat(201)}`))).toEqual([400, ['q must be shorter than or equal to 200 characters']]);
    expect(support.search).toHaveBeenCalledTimes(1);
  });

  it("gives a function's page by its ID, and refuses an ID that isn't one", async () => {
    expect((await call('GET', `/admin/functions/${FN}`)).status).toBe(200);
    expect(support.functionPage).toHaveBeenCalledWith(FN);

    expect(await refusal(await call('GET', '/admin/functions/hello'))).toEqual([400, ['id must be a UUID']]);
  });

  it("gives the code, a call's data and the logs only for a reason, which it passes on", async () => {
    expect((await call('POST', `/admin/functions/${FN}/code`, { reason: REASON })).status).toBe(200);
    expect((await call('POST', `/admin/functions/${FN}/invocations/${CALL}`, { reason: REASON })).status).toBe(200);
    expect((await call('POST', `/admin/functions/${FN}/logs`, { reason: REASON, sinceSeconds: 3600, requestId: CALL, q: 'time out' })).status).toBe(200);

    expect(support.viewCode).toHaveBeenCalledWith(FN, REASON);
    expect(support.viewCall).toHaveBeenCalledWith(FN, CALL, REASON);
    expect(support.viewLogs).toHaveBeenCalledWith(FN, REASON, { sinceSeconds: 3600, requestId: CALL, q: 'time out' });
  });

  it('refuses a look without a reason, or with a short one, and asks the service nothing', async () => {
    for (const [path, body] of [
      [`/admin/functions/${FN}/code`, {}],
      [`/admin/functions/${FN}/invocations/${CALL}`, { reason: 'no' }],
      [`/admin/functions/${FN}/logs`, { sinceSeconds: 60 }],
    ] as const) {
      const [status, message] = await refusal(await call('POST', path, body));
      expect([status, (message as string[]).some((m) => m.startsWith('reason must be longer than or equal to'))]).toEqual([400, true]);
    }
    expect(await refusal(await call('POST', `/admin/functions/${FN}/invocations/not-a-call`, { reason: REASON }))).toEqual([400, ['invocationId must be a UUID']]);
    expect(await refusal(await call('POST', `/admin/functions/${FN}/logs`, { reason: REASON, sinceSeconds: 0 }))).toEqual([400, ['sinceSeconds must not be less than 1']]);
    expect([support.viewCode, support.viewCall, support.viewLogs].map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0]);
  });
});

describe('errorType', () => {
  it.each([
    ['ValidationError: bad row for amira@example.tn', 'ValidationError'],
    ['Sandbox.Timedout: Task timed out after 2.00 seconds', 'Sandbox.Timedout'],
    ["The function failed to load: Runtime.ImportModuleError: Cannot find module 'lodash'", 'Runtime.ImportModuleError'],
    ['TooManyRequestsException: Rate exceeded', 'TooManyRequestsException'],
    ["Lost: the backend restarted during the call, so its answer is unknown. It isn't billed.", 'Lost'],
  ])("gives %j's type, without its message", (error, type) => {
    expect(errorType(error)).toBe(type);
  });

  it("gives none for FF's wording of a failure on its side, a message without a type, or no error", () => {
    expect(errorType('The invocation failed because of an internal error (request 1f0c…).')).toBeNull();
    expect(errorType('something broke for amira@example.tn')).toBeNull();
    expect([errorType(null), errorType(undefined), errorType('')]).toEqual([null, null, null]);
  });
});

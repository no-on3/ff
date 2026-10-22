/**
 * L1: who may call each route of a function's URL, as the routes declare it
 * for the global guard, and what the validation lets through.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountStatus } from '../accounts/entities/account.entity';
import { Principal } from '../auth/principal';
import { ACTIVE_ACCOUNT, ROLES, SCOPE } from '../auth/route-rules';
import { INVOCATION } from '../plans/rate-limits';
import { CustomDomainsController } from './custom-domains.controller';
import { FunctionUrlsController } from './function-urls.controller';
import { FunctionUrlsService } from './function-urls.service';

const reflector = new Reflector();
const rules = (handler: keyof FunctionUrlsController) => {
  const method = FunctionUrlsController.prototype[handler];
  return {
    roles: reflector.get<string[] | undefined>(ROLES, method) ?? 'anyone',
    activeAccount: reflector.get<boolean | undefined>(ACTIVE_ACCOUNT, method) ?? false,
    scope: reflector.get<string | undefined>(SCOPE, method) ?? 'no key',
    invocation: reflector.get<boolean | undefined>(INVOCATION, method) ?? false,
  };
};

describe('FunctionUrlsController route rules (L1)', () => {
  it.each<keyof FunctionUrlsController>(['create', 'update'])('%s: writers only, in an approved account, and a key with functions:write', (handler) => {
    expect(rules(handler)).toEqual({ roles: ['owner', 'developer'], activeAccount: true, scope: 'functions:write', invocation: false });
  });

  it('lets writers delete a URL, even in an account that is not active: it closes a public address', () => {
    expect(rules('remove')).toEqual({ roles: ['owner', 'developer'], activeAccount: false, scope: 'functions:write', invocation: false });
  });

  it('lets every member read it, viewers included, and a key with functions:read', () => {
    expect(rules('get')).toEqual({ roles: 'anyone', activeAccount: false, scope: 'functions:read', invocation: false });
  });
});

describe('CustomDomainsController route rules (L1)', () => {
  const domainRules = (handler: keyof CustomDomainsController) => {
    const method = CustomDomainsController.prototype[handler];
    return {
      roles: reflector.get<string[] | undefined>(ROLES, method) ?? 'anyone',
      activeAccount: reflector.get<boolean | undefined>(ACTIVE_ACCOUNT, method) ?? false,
      scope: reflector.get<string | undefined>(SCOPE, method) ?? 'no key',
    };
  };

  it.each<keyof CustomDomainsController>(['add', 'verify'])('%s: writers only, in an approved account, and a key with functions:write', (handler) => {
    expect(domainRules(handler)).toEqual({ roles: ['owner', 'developer'], activeAccount: true, scope: 'functions:write' });
  });

  it('lets writers remove a domain, even in an account that is not active', () => {
    expect(domainRules('remove')).toEqual({ roles: ['owner', 'developer'], activeAccount: false, scope: 'functions:write' });
  });

  it('lets every member list them, and a key with functions:read', () => {
    expect(domainRules('list')).toEqual({ roles: 'anyone', activeAccount: false, scope: 'functions:read' });
  });
});

describe('POST and PUT /functions/:id/url, validated (L1)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const urls = { create: jest.fn(async () => ({})), update: jest.fn(async () => ({})) };
  const ID = '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FunctionUrlsController],
      providers: [{ provide: FunctionUrlsService, useValue: urls }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((req: { principal?: Principal }, _res: unknown, next: () => void) => {
      req.principal = { accountId: '123456789012', accountStatus: AccountStatus.ACTIVE, planId: 'beta', role: 'owner' };
      next();
    });
    // As main.ts validates every body.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(() => app.close());

  const send = async (method: string, body: unknown) => {
    const res = await fetch(`${baseUrl}/functions/${ID}/url`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, message: ((await res.json()) as { message?: string | string[] }).message };
  };

  it("takes AWS Lambda's configuration: the auth type, CORS, the invoke mode", async () => {
    const cors = {
      allowCredentials: true,
      allowHeaders: ['content-type', 'x-request-id', '*'],
      allowMethods: ['GET', 'POST', '*'],
      allowOrigins: ['https://app.example.tn', 'http://localhost:5173', '*'],
      exposeHeaders: ['x-total-count'],
      maxAge: 86400,
    };

    expect((await send('POST', { authType: 'AWS_IAM', cors, invokeMode: 'BUFFERED' })).status).toBe(201);
    expect(urls.create).toHaveBeenLastCalledWith('123456789012', ID, expect.objectContaining({ authType: 'AWS_IAM', cors: expect.objectContaining(cors) }));
    expect((await send('PUT', { cors: null })).status).toBe(200);
    expect(urls.update).toHaveBeenLastCalledWith('123456789012', ID, { cors: null });
  });

  it.each([
    ['no auth type', 'POST', {}, 'authType must be NONE or AWS_IAM'],
    ['an auth type of its own', 'POST', { authType: 'API_KEY' }, 'authType must be NONE or AWS_IAM'],
    ['streaming', 'PUT', { invokeMode: 'RESPONSE_STREAM' }, "invokeMode must be BUFFERED: FF doesn't stream answers"],
    ['an origin with a path', 'POST', { authType: 'NONE', cors: { allowOrigins: ['https://app.example.tn/'] } }, 'cors.each of allowOrigins must be an origin, such as https://www.example.tn, or *'],
    ['a header that would split the answer', 'POST', { authType: 'NONE', cors: { allowHeaders: ['x-a\r\nset-cookie: x=1'] } }, 'cors.each of allowHeaders must be a header name, or *'],
    ['a method that is none', 'POST', { authType: 'NONE', cors: { allowMethods: ['FETCH'] } }, 'cors.each of allowMethods must be one of GET, PUT, HEAD, POST, PATCH, DELETE, *'],
    ['a preflight kept over a day', 'POST', { authType: 'NONE', cors: { maxAge: 86401 } }, 'cors.maxAge must not be greater than 86400'],
    ['a field Lambda has not', 'POST', { authType: 'NONE', cors: { allowOrigin: ['*'] } }, 'cors.property allowOrigin should not exist'],
  ])('refuses %s', async (_case, method, body, message) => {
    const answer = await send(method, body);

    expect(answer.status).toBe(400);
    expect(answer.message).toContain(message);
  });
});

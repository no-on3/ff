/**
 * L1: the routes of customers' caches in FF's API: who may call each, and
 * what the bodies may hold, through HTTP. The caches themselves, on a real
 * server, are caches.db.spec.ts's.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountStatus } from '../accounts/entities/account.entity';
import { Principal } from '../auth/principal';
import { ACTIVE_ACCOUNT, ROLES, SCOPE } from '../auth/route-rules';
import { CachesController } from './caches.controller';
import { CachesService } from './caches.service';

const ACCOUNT = '000000000001';
const reflector = new Reflector();
const rules = (handler: keyof CachesController) => {
  const method = CachesController.prototype[handler];
  return {
    roles: reflector.get<string[] | undefined>(ROLES, method) ?? 'anyone',
    activeAccount: reflector.get<boolean | undefined>(ACTIVE_ACCOUNT, method) ?? false,
    scope: reflector.get<string | undefined>(SCOPE, method) ?? 'no key',
  };
};

describe('/caches (L1)', () => {
  const caches = {
    list: jest.fn(async () => []),
    create: jest.fn(async () => ({})),
    get: jest.fn(async () => ({})),
    resetPassword: jest.fn(async () => ({})),
    remove: jest.fn(async () => undefined),
  };
  const principal: Principal = { accountId: ACCOUNT, accountStatus: AccountStatus.ACTIVE, planId: 'beta', role: 'developer' };
  let app: INestApplication;
  let baseUrl: string;
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CachesController],
      providers: [{ provide: CachesService, useValue: caches }],
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

  it('lets every member read them, writers make them and change their passwords in an active account, and delete them in any', () => {
    expect([rules('list'), rules('get')]).toEqual([
      { roles: 'anyone', activeAccount: false, scope: 'caches:read' },
      { roles: 'anyone', activeAccount: false, scope: 'caches:read' },
    ]);
    expect([rules('create'), rules('resetPassword')]).toEqual([
      { roles: ['owner', 'developer'], activeAccount: true, scope: 'caches:write' },
      { roles: ['owner', 'developer'], activeAccount: true, scope: 'caches:write' },
    ]);
    expect(rules('remove')).toEqual({ roles: ['owner', 'developer'], activeAccount: false, scope: 'caches:write' });
  });

  it("makes one by the name it is given, as ElastiCache names its clusters, for the caller's account", async () => {
    expect((await call('POST', '/caches', { name: 'sessions' })).status).toBe(201);
    expect(caches.create).toHaveBeenCalledWith(ACCOUNT, { name: 'sessions' });
    expect((await call('POST', '/caches/sessions/password')).status).toBe(200);
    expect(caches.resetPassword).toHaveBeenCalledWith(ACCOUNT, 'sessions');
    expect((await call('DELETE', '/caches/sessions')).status).toBe(204);
    expect(caches.remove).toHaveBeenCalledWith(ACCOUNT, 'sessions');
  });

  it('refuses a name ElastiCache would, and any other field, before the service', async () => {
    for (const name of ['Sessions', '1-cache', 'two--hyphens', 'last-', 'a'.repeat(41)]) {
      const res = await call('POST', '/caches', { name });
      expect([name, res.status]).toEqual([name, 400]);
    }
    const extra = await call('POST', '/caches', { name: 'sessions', memoryMb: 1024 });
    expect([extra.status, (await extra.json()).message]).toEqual([400, ['property memoryMb should not exist']]);
    expect(caches.create).not.toHaveBeenCalled();
  });
});

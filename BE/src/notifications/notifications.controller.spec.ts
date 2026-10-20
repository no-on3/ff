/**
 * L1: the notification routes through HTTP, with the validation main.ts sets
 * up: who may call each, and what they take and refuse before the service is
 * asked. The service runs against PostgreSQL in notifications.db.spec.ts.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountStatus } from '../accounts/entities/account.entity';
import { User } from '../accounts/entities/user.entity';
import { Principal } from '../auth/principal';
import { ACTIVE_ACCOUNT, ROLES, SCOPE } from '../auth/route-rules';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

const ACCOUNT = '000000000001';

describe('the notification routes (L1)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const service = {
    secret: jest.fn(async () => ({ accountId: ACCOUNT, secret: 'whsec_a', previousSecret: 'whsec_old', previousExpiresAt: null, createdAt: new Date('2026-10-19T10:00:00Z') })),
    rotate: jest.fn(async () => ({ accountId: ACCOUNT, secret: 'whsec_b', previousSecret: 'whsec_a', previousExpiresAt: new Date('2026-10-20T10:00:00Z'), createdAt: new Date('2026-10-19T10:00:00Z') })),
    test: jest.fn(async () => ({ notificationId: 'n-1', deliveries: [] })),
    deliveries: jest.fn(async () => []),
  };

  const call = (method: string, path: string, body?: object, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  const refusal = async (res: Response) => [res.status, (await res.json()).message];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [{ provide: NotificationsService, useValue: service }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    // As the guard does: a login's user, or none in development mode.
    app.use((req: { principal?: Principal; user?: Partial<User>; headers: Record<string, string> }, _res: unknown, next: () => void) => {
      req.principal = { accountId: ACCOUNT, accountStatus: AccountStatus.ACTIVE, planId: 'beta', role: 'owner' };
      if (req.headers['x-test-mode'] !== 'dev') req.user = { id: 'u-1', email: 'amira@ff.tn' };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true })); // as main.ts
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it("are the account members': the secret the owners', a test the writers', the deliveries everyone's; changes only in an active account; never an API key's", () => {
    const reflector = new Reflector();
    const rules = (handler: Parameters<Reflector['get']>[1]) => [reflector.get(ROLES, handler), reflector.get(ACTIVE_ACCOUNT, handler), reflector.get(SCOPE, handler)];
    const { secret, rotate, test, deliveries } = NotificationsController.prototype;
    expect([rules(secret), rules(rotate), rules(test), rules(deliveries)]).toEqual([
      [['owner'], undefined, undefined],
      [['owner'], true, undefined],
      [['owner', 'developer'], true, undefined],
      [undefined, undefined, undefined],
    ]);
  });

  it('gives the secret and its dates, never the previous one; a rotation answers the new one', async () => {
    const res = await call('GET', '/notifications/webhook-secret');
    expect([res.status, await res.json()]).toEqual([200, { secret: 'whsec_a', createdAt: '2026-10-19T10:00:00.000Z', previousExpiresAt: null }]);
    const rotated = await call('POST', '/notifications/webhook-secret/rotate');
    expect([rotated.status, await rotated.json()]).toEqual([200, { secret: 'whsec_b', createdAt: '2026-10-19T10:00:00.000Z', previousExpiresAt: '2026-10-20T10:00:00.000Z' }]);
    expect([service.secret.mock.calls, service.rotate.mock.calls]).toEqual([[[ACCOUNT]], [[ACCOUNT]]]);
  });

  it('accepts a test, 202, with the caller named: their address, or development mode', async () => {
    const res = await call('POST', '/notifications/test', { webhookUrl: 'https://example.tn/ff-hooks', email: true });
    expect(res.status).toBe(202);
    expect(service.test).toHaveBeenLastCalledWith(ACCOUNT, { webhookUrl: 'https://example.tn/ff-hooks', email: true }, 'amira@ff.tn');

    expect((await call('POST', '/notifications/test', { email: true }, { 'x-test-mode': 'dev' })).status).toBe(202);
    expect(service.test).toHaveBeenLastCalledWith(ACCOUNT, { email: true }, 'development mode');
  });

  it("refuses a test's fields of the wrong type, too long a URL, and a field it has no use for", async () => {
    expect(await refusal(await call('POST', '/notifications/test', { webhookUrl: 42 }))).toEqual([400, expect.arrayContaining(['webhookUrl must be a string'])]);
    expect(await refusal(await call('POST', '/notifications/test', { webhookUrl: `https://example.tn/${'a'.repeat(2048)}` }))).toEqual([
      400,
      ['webhookUrl must be shorter than or equal to 2048 characters'],
    ]);
    expect(await refusal(await call('POST', '/notifications/test', { email: 'yes' }))).toEqual([400, ['email must be a boolean value']]);
    expect(await refusal(await call('POST', '/notifications/test', { email: true, secret: 'x' }))).toEqual([400, ['property secret should not exist']]);
    expect(service.test).not.toHaveBeenCalled();
  });

  it('lists the deliveries, 50 by default, 1 to 100', async () => {
    expect((await call('GET', '/notifications/deliveries')).status).toBe(200);
    expect((await call('GET', '/notifications/deliveries?limit=100')).status).toBe(200);
    expect(service.deliveries.mock.calls).toEqual([
      [ACCOUNT, undefined],
      [ACCOUNT, 100],
    ]);
    for (const limit of ['0', '101', 'all']) expect((await call('GET', `/notifications/deliveries?limit=${limit}`)).status).toBe(400);
    expect(service.deliveries).toHaveBeenCalledTimes(2);
  });
});

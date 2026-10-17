/**
 * L1: what the audit log records about the caller (client-readiness plan,
 * P-17), through a real HTTP server with the backend's request interceptor.
 * A stand-in for the global guard puts a caller on the request, as the real
 * one does; the handler records an event.
 */
import { CanActivate, Controller, ExecutionContext, INestApplication, Logger, Post } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RequestIdInterceptor } from '../common/request-context';
import { ROLES, SCOPE } from '../auth/route-rules';
import { AuditEntry } from './audit-entry.entity';
import { AuditController } from './audit.controller';
import { AuditService, SYSTEM } from './audit.service';

const entries = { insert: jest.fn() };

@Controller('probe')
class ProbeController {
  constructor(private readonly audit: AuditService) {}

  @Post()
  async change() {
    await this.audit.record({ accountId: '123456789012', action: 'function.delete', resource: 'function:f-1', details: { name: 'hello' } });
    return { ok: true };
  }
}

/** The callers the real guard leaves on requests: an API key, a user's token, development mode. */
class StandInGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string>; principal?: object; user?: object }>();
    const as = request.headers['x-as'];
    if (as === 'key') request.principal = { accountId: '123456789012', keyId: '0123456789ab', keyName: 'CI deploys', userId: 'u-1' };
    if (as === 'user') {
      request.principal = { accountId: '123456789012', userId: 'u-1' };
      request.user = { id: 'u-1', email: 'amira@ff.test' };
    }
    if (as === 'dev') request.principal = { accountId: '123456789012', userId: 'dev' };
    return true;
  }
}

describe('the audit log (L1, P-17)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let audit: AuditService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        AuditService,
        { provide: getRepositoryToken(AuditEntry), useValue: entries },
        { provide: APP_GUARD, useClass: StandInGuard },
        { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    audit = moduleRef.get(AuditService);
  });

  afterAll(() => app.close());

  beforeEach(() => {
    entries.insert.mockReset();
  });

  /** The row the probe's change recorded, and the answer's request ID. */
  async function recordAs(as: string) {
    const res = await fetch(`${baseUrl}/probe`, { method: 'POST', headers: { 'x-as': as } });
    expect(res.status).toBe(201);
    expect(entries.insert).toHaveBeenCalledTimes(1);
    return { row: entries.insert.mock.calls[0][0], requestId: res.headers.get('x-ff-request-id') };
  }

  it("names a user by ID and e-mail, with the request's address and ID", async () => {
    const { row, requestId } = await recordAs('user');

    expect(row).toEqual({
      accountId: '123456789012',
      actor: 'user:u-1',
      actorLabel: 'amira@ff.test',
      action: 'function.delete',
      resource: 'function:f-1',
      ip: '127.0.0.1',
      requestId,
      details: { name: 'hello' },
    });
  });

  it('names an API key by its ID and name, not its creator: the key acted', async () => {
    const { row } = await recordAs('key');

    expect(row).toMatchObject({ actor: 'key:0123456789ab', actorLabel: 'API key "CI deploys"' });
  });

  it('names development mode as such', async () => {
    const { row } = await recordAs('dev');

    expect(row).toMatchObject({ actor: 'dev', actorLabel: 'development mode' });
  });

  it('names FF itself outside a request, as for a timer', async () => {
    await audit.record({ accountId: '123456789012', action: 'account.plan' });

    expect(entries.insert.mock.calls[0][0]).toMatchObject({ actor: SYSTEM.id, actorLabel: 'FF', ip: null, requestId: null });
  });

  it('keeps an actor and address given explicitly, as the guard gives them for a user who joins', async () => {
    await audit.record({ accountId: '123456789012', action: 'member.join', actor: { id: 'user:u-2', label: 'salma@ff.test' }, ip: '10.0.0.7' });

    expect(entries.insert.mock.calls[0][0]).toMatchObject({ actor: 'user:u-2', actorLabel: 'salma@ff.test', ip: '10.0.0.7' });
  });

  it("logs a record it couldn't write, without failing the change it describes", async () => {
    entries.insert.mockRejectedValue(new Error('connection lost'));
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(audit.record({ accountId: '123456789012', action: 'api_key.revoke', resource: 'api_key:k' })).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalledWith('Could not record api_key.revoke on api_key:k: connection lost');
    logged.mockRestore();
  });

  it("writes through the caller's transaction when given one, and fails with it", async () => {
    const manager = { insert: jest.fn().mockRejectedValue(new Error('serialization failure')) };

    await expect(audit.record({ accountId: '123456789012', action: 'function.create' }, manager as never)).rejects.toThrow('serialization failure');
    expect(entries.insert).not.toHaveBeenCalled();
  });
});

describe('GET /audit-log route rules (L1, P-17)', () => {
  it("is the account's owners', with a user's token: no scope, so no API key", () => {
    const reflector = new Reflector();
    const list = AuditController.prototype.list;

    expect(reflector.get(ROLES, list)).toEqual(['owner']);
    expect(reflector.get(SCOPE, list)).toBeUndefined();
  });
});

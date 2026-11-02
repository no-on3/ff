/**
 * L1: the routes of a function's versions: who may call each, and what the
 * body and the path may hold, through HTTP.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountStatus } from '../accounts/entities/account.entity';
import { Principal } from '../auth/principal';
import { ACTIVE_ACCOUNT, ROLES, SCOPE } from '../auth/route-rules';
import { FunctionVersionsController } from './versions.controller';
import { FunctionVersionsService } from './versions.service';

const ACCOUNT = '000000000001';
const ID = '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f';
const reflector = new Reflector();
const rules = (handler: keyof FunctionVersionsController) => {
  const method = FunctionVersionsController.prototype[handler];
  return {
    roles: reflector.get<string[] | undefined>(ROLES, method) ?? 'anyone',
    activeAccount: reflector.get<boolean | undefined>(ACTIVE_ACCOUNT, method) ?? false,
    scope: reflector.get<string | undefined>(SCOPE, method) ?? 'no key',
  };
};

describe('/functions/:id/versions (L1)', () => {
  const versions = { publish: jest.fn(async () => ({})), list: jest.fn(async () => []), get: jest.fn(async () => ({})), remove: jest.fn(async () => undefined) };
  let app: INestApplication;
  let baseUrl: string;
  const publish = (body: unknown) =>
    fetch(`${baseUrl}/functions/${ID}/versions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FunctionVersionsController],
      providers: [{ provide: FunctionVersionsService, useValue: versions }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((req: { principal?: Principal }, _res: unknown, next: () => void) => {
      req.principal = { accountId: ACCOUNT, accountStatus: AccountStatus.ACTIVE, planId: 'beta', role: 'developer' };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true })); // as main.ts
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('lets every member read them, writers publish in an active account, and delete in any', () => {
    expect([rules('list'), rules('get'), rules('publish'), rules('remove')]).toEqual([
      { roles: 'anyone', activeAccount: false, scope: 'functions:read' },
      { roles: 'anyone', activeAccount: false, scope: 'functions:read' },
      { roles: ['owner', 'developer'], activeAccount: true, scope: 'functions:write' },
      { roles: ['owner', 'developer'], activeAccount: false, scope: 'functions:write' },
    ]);
  });

  it("takes Lambda's PublishVersion checks, each optional, and passes them on", async () => {
    const body = { description: 'Receipts in French', codeSha256: 'n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=', revisionId: '6a1f3c2e-8b7d-4c6a-9e5f-1a2b3c4d5e6f' };
    expect((await publish(body)).status).toBe(201);
    expect((await publish({})).status).toBe(201);
    expect(versions.publish.mock.calls).toEqual([
      [ACCOUNT, ID, body],
      [ACCOUNT, ID, {}],
    ]);
  });

  it('refuses a description over 256 characters, a revision that is no UUID, and fields Lambda has not', async () => {
    for (const body of [{ description: 'x'.repeat(257) }, { revisionId: 'latest' }, { functionVersion: '3' }]) {
      expect((await publish(body)).status).toBe(400);
    }
    expect(versions.publish).not.toHaveBeenCalled();
  });

  it('reads and deletes a version by its number, and refuses one that is no number', async () => {
    expect((await fetch(`${baseUrl}/functions/${ID}/versions/3`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/functions/${ID}/versions/3`, { method: 'DELETE' })).status).toBe(204);
    expect(versions.get.mock.calls).toEqual([[ACCOUNT, ID, 3]]);
    expect(versions.remove.mock.calls).toEqual([[ACCOUNT, ID, 3]]);
    expect((await fetch(`${baseUrl}/functions/${ID}/versions/$LATEST`)).status).toBe(400);
  });
});

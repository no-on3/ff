/**
 * L1: the routes of a function's aliases: who may call each, and what the
 * body and the path may hold, through HTTP.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountStatus } from '../accounts/entities/account.entity';
import { Principal } from '../auth/principal';
import { ACTIVE_ACCOUNT, ROLES, SCOPE } from '../auth/route-rules';
import { FunctionAliasesController } from './aliases.controller';
import { FunctionAliasesService } from './aliases.service';

const ACCOUNT = '000000000001';
const ID = '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f';
const reflector = new Reflector();
const rules = (handler: keyof FunctionAliasesController) => {
  const method = FunctionAliasesController.prototype[handler];
  return {
    roles: reflector.get<string[] | undefined>(ROLES, method) ?? 'anyone',
    activeAccount: reflector.get<boolean | undefined>(ACTIVE_ACCOUNT, method) ?? false,
    scope: reflector.get<string | undefined>(SCOPE, method) ?? 'no key',
  };
};

describe('/functions/:id/aliases (L1)', () => {
  const aliases = {
    create: jest.fn(async () => ({})),
    list: jest.fn(async () => []),
    get: jest.fn(async () => ({})),
    update: jest.fn(async () => ({})),
    remove: jest.fn(async () => undefined),
  };
  let app: INestApplication;
  let baseUrl: string;
  const send = (method: string, path: string, body: unknown) =>
    fetch(`${baseUrl}/functions/${ID}/aliases${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FunctionAliasesController],
      providers: [{ provide: FunctionAliasesService, useValue: aliases }],
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

  it('lets every member read them, writers make and change them in an active account, and delete them in any', () => {
    expect([rules('list'), rules('get'), rules('create'), rules('update'), rules('remove')]).toEqual([
      { roles: 'anyone', activeAccount: false, scope: 'functions:read' },
      { roles: 'anyone', activeAccount: false, scope: 'functions:read' },
      { roles: ['owner', 'developer'], activeAccount: true, scope: 'functions:write' },
      { roles: ['owner', 'developer'], activeAccount: true, scope: 'functions:write' },
      { roles: ['owner', 'developer'], activeAccount: false, scope: 'functions:write' },
    ]);
  });

  it("takes Lambda's CreateAlias: a name, a version or $LATEST, a description and another version's share, and passes them on", async () => {
    const weighted = { name: 'live', functionVersion: '3', description: 'What the shop runs', routingConfig: { additionalVersionWeights: { '4': 0.1 } } };
    for (const body of [weighted, { name: 'dev_1-a', functionVersion: '$LATEST' }, { name: 'x'.repeat(128), functionVersion: '1', routingConfig: { additionalVersionWeights: {} } }]) {
      expect((await send('POST', '', body)).status).toBe(201);
    }
    expect(aliases.create.mock.calls[0]).toEqual([ACCOUNT, ID, weighted]);
  });

  it("refuses a name Lambda refuses, a version that is no number, a share that isn't one version's from 0 to 1, and fields Lambda has not", async () => {
    const bodies = [
      { name: '12', functionVersion: '1' }, // digits alone name a version
      { name: 'v1.2', functionVersion: '1' },
      { name: 'x'.repeat(129), functionVersion: '1' },
      { name: 'live', functionVersion: 'latest' },
      { name: 'live', functionVersion: '0' },
      { name: 'live', functionVersion: '1', routingConfig: { additionalVersionWeights: { '2': 0.1, '3': 0.1 } } },
      { name: 'live', functionVersion: '1', routingConfig: { additionalVersionWeights: { '2': 1.5 } } },
      { name: 'live', functionVersion: '1', routingConfig: { additionalVersionWeights: { $LATEST: 0.5 } } },
      { name: 'live', functionVersion: '1', routingConfig: {} },
      { name: 'live', functionVersion: '1', description: 'x'.repeat(257) },
      { name: 'live', functionVersion: '1', revisionId: '6a1f3c2e-8b7d-4c6a-9e5f-1a2b3c4d5e6f' },
      { functionVersion: '1' },
    ];
    for (const body of bodies) expect([JSON.stringify(body), (await send('POST', '', body)).status]).toEqual([JSON.stringify(body), 400]);
    expect(aliases.create).not.toHaveBeenCalled();
  });

  it("takes Lambda's UpdateAlias, each field optional, a revision a UUID, and passes the alias's name on", async () => {
    const body = { functionVersion: '$LATEST', routingConfig: { additionalVersionWeights: {} }, revisionId: '6a1f3c2e-8b7d-4c6a-9e5f-1a2b3c4d5e6f' };
    expect((await send('PUT', '/live', body)).status).toBe(200);
    expect((await send('PUT', '/live', {})).status).toBe(200);
    for (const refused of [{ revisionId: 'latest' }, { name: 'other' }, { functionVersion: '-1' }]) expect((await send('PUT', '/live', refused)).status).toBe(400);
    expect(aliases.update.mock.calls).toEqual([
      [ACCOUNT, ID, 'live', body],
      [ACCOUNT, ID, 'live', {}],
    ]);
  });

  it('reads and deletes an alias by its name', async () => {
    expect((await fetch(`${baseUrl}/functions/${ID}/aliases/live`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/functions/${ID}/aliases/live`, { method: 'DELETE' })).status).toBe(204);
    expect(aliases.get.mock.calls).toEqual([[ACCOUNT, ID, 'live']]);
    expect(aliases.remove.mock.calls).toEqual([[ACCOUNT, ID, 'live']]);
  });
});

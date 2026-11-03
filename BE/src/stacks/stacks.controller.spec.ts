/**
 * L1: the routes of stacks in FF's API (ADR 0016): who may call each, and
 * what a PUT's body may hold, through HTTP. The stacks themselves, in FF's
 * database, are stacks.db.spec.ts's.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountStatus } from '../accounts/entities/account.entity';
import { Principal } from '../auth/principal';
import { ACTIVE_ACCOUNT, ROLES, SCOPE } from '../auth/route-rules';
import { MAX_STACK_RESOURCES } from './dto/stack.dto';
import { StacksController } from './stacks.controller';
import { StacksService } from './stacks.service';

const ACCOUNT = '000000000001';
const SHA = 'b5bb9d8014a0f9b1d61e21e796d78dccdf1352f23cd32812f4850b878ae4944c';
const reflector = new Reflector();
const rules = (handler: keyof StacksController) => {
  const method = StacksController.prototype[handler];
  return {
    roles: reflector.get<string[] | undefined>(ROLES, method) ?? 'anyone',
    activeAccount: reflector.get<boolean | undefined>(ACTIVE_ACCOUNT, method) ?? false,
    scope: reflector.get<string | undefined>(SCOPE, method) ?? 'no key',
  };
};

describe('/stacks (L1)', () => {
  const stacks = {
    list: jest.fn(async () => []),
    get: jest.fn(async () => ({})),
    put: jest.fn(async () => ({})),
    remove: jest.fn(async () => undefined),
  };
  const principal: Principal = { accountId: ACCOUNT, accountStatus: AccountStatus.ACTIVE, planId: 'beta', role: 'developer' };
  let app: INestApplication;
  let baseUrl: string;
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const put = (body: unknown) => call('PUT', '/stacks/shop', body);
  const refusal = async (body: unknown) => {
    const res = await put(body);
    return [res.status, (await res.json()).message];
  };
  const function_ = { logicalId: 'OrdersFunction', type: 'AWS::Serverless::Function', physicalId: 'orders' };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [StacksController],
      providers: [{ provide: StacksService, useValue: stacks }],
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

  it('lets every member read them, writers put them in an active account, and forget them in any', () => {
    expect([rules('list'), rules('get')]).toEqual([
      { roles: 'anyone', activeAccount: false, scope: 'stacks:read' },
      { roles: 'anyone', activeAccount: false, scope: 'stacks:read' },
    ]);
    expect(rules('put')).toEqual({ roles: ['owner', 'developer'], activeAccount: true, scope: 'stacks:write' });
    expect(rules('remove')).toEqual({ roles: ['owner', 'developer'], activeAccount: false, scope: 'stacks:write' });
  });

  it("puts, reads and forgets the caller's account's stack by its name", async () => {
    const body = { templateSha256: SHA, parameters: { Stage: 'prod' }, resources: [function_, { logicalId: 'OrdersPermission', type: 'AWS::Lambda::Permission', physicalId: null }] };
    expect((await put(body)).status).toBe(200);
    expect(stacks.put).toHaveBeenCalledWith(ACCOUNT, 'shop', body);
    expect([(await call('GET', '/stacks')).status, (await call('GET', '/stacks/shop')).status, (await call('DELETE', '/stacks/shop')).status]).toEqual([200, 200, 204]);
    expect([stacks.list.mock.calls, stacks.get.mock.calls, stacks.remove.mock.calls]).toEqual([[[ACCOUNT]], [[ACCOUNT, 'shop']], [[ACCOUNT, 'shop']]]);
  });

  it("refuses a body CloudFormation's names wouldn't fit, before the service", async () => {
    expect(await refusal({ templateSha256: SHA.toUpperCase(), resources: [] })).toEqual([400, ['templateSha256 is a SHA-256, 64 lowercase hexadecimal characters']]);
    expect(await refusal({ templateSha256: SHA, resources: [{ ...function_, logicalId: 'Orders-Function' }] })).toEqual([
      400,
      ["resources.0.logicalId is letters and digits, as CloudFormation's"],
    ]);
    expect(await refusal({ templateSha256: SHA, resources: [{ ...function_, type: 'Serverless::Function' }] })).toEqual([
      400,
      ['resources.0.type is a resource type, as AWS::Serverless::Function'],
    ]);
    expect(await refusal({ templateSha256: SHA, resources: [{ ...function_, physicalId: 42 }] })).toEqual([
      400,
      ['resources.0.physicalId must be longer than or equal to 1 and shorter than or equal to 1024 characters', 'resources.0.physicalId must be a string'],
    ]);
    expect(await refusal({ templateSha256: SHA, resources: Array.from({ length: MAX_STACK_RESOURCES + 1 }, (_, i) => ({ ...function_, logicalId: `F${i}` })) })).toEqual([
      400,
      ['resources must contain no more than 500 elements'],
    ]);
    expect(await refusal({ templateSha256: SHA, parameters: { 'Stage-Name': 'prod', Memory: 512 }, resources: [] })).toEqual([
      400,
      ['parameters: "Stage-Name" isn\'t a parameter\'s name, letters and digits, 255 at most; parameters: Memory\'s value is a string'],
    ]);
    expect(await refusal({ templateSha256: SHA, resources: [], template: 'Resources: {}' })).toEqual([400, ['property template should not exist']]);
    expect(stacks.put).not.toHaveBeenCalled();
  });
});

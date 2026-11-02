/**
 * L1: Lambda's reads of functions over FF's (GetFunction,
 * GetFunctionConfiguration, ListFunctions, GetFunctionCodeSigningConfig,
 * GetAccountSettings): FF's records under Lambda's names, a qualifier read as
 * a version or an alias, the code as a link, the list a page at a time.
 */
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { FunctionVersionView } from '../functions/dto/versions.dto';
import { EventFormat, Function, FunctionStatus, PackageType, Runtime } from '../functions/entities/function.entity';
import { FunctionAliasesService } from '../functions/aliases.service';
import { FunctionsService } from '../functions/functions.service';
import { FunctionVersionsService } from '../functions/versions.service';
import { PackagesService } from '../packages/packages.service';
import { plan } from '../plans/test-fixtures';
import { EncryptionService } from '../encryption/encryption.service';
import { DEVELOPMENT_KEY } from '../encryption/key-ring';
import { awsEndpointsOf } from '../common/aws-endpoint';
import { LambdaError } from './lambda-error';
import { LambdaCodeLinks } from './lambda-code-links';
import { LambdaFunctionReads, lambdaTime, latestConfiguration, statesOf } from './lambda-functions';
import { LambdaCall, LambdaCaller, LambdaHandlers, LambdaOperations, operationOf } from './lambda-operations';

const ACCOUNT = '000000000001';
const REGION = 'tn-tunis-1';
const ARN = `arn:aws:lambda:${REGION}:${ACCOUNT}:function`;
const UPDATED = new Date('2026-11-02T10:20:30.456Z');

const fn = (name: string, more: Partial<Function> = {}): Function =>
  Object.assign(new Function(), {
    id: `f-${name}`,
    accountId: ACCOUNT,
    name,
    runtime: Runtime.NODEJS,
    handler: 'index.handler',
    packageType: PackageType.ZIP,
    codeSha256: 'c2hhLW9mLXRoZS16aXA=',
    codeSize: 1234,
    memory: 256,
    timeout: 30,
    status: FunctionStatus.ACTIVE,
    error: null,
    revisionId: `rev-${name}`,
    updatedAt: UPDATED,
    ...more,
  });

const version = (name: string, number: number, more: Partial<FunctionVersionView> = {}): FunctionVersionView => ({
  functionId: `f-${name}`,
  functionArn: `${ARN}:${name}:${number}`,
  version: String(number),
  description: `version ${number}`,
  runtime: Runtime.PYTHON,
  handler: 'app.handler',
  packageType: PackageType.ZIP,
  codeSha256: `sha-${number}`,
  codeSize: 100 * number,
  memory: 128,
  timeout: 10,
  eventFormat: EventFormat.LAMBDA,
  awsEndpoints: awsEndpointsOf(),
  revisionId: `rev-${name}-${number}`,
  createdAt: new Date('2026-11-01T08:00:00.000Z'),
  environment: { STAGE: `v${number}` },
  ...more,
});

describe("Lambda's reads of functions (L1)", () => {
  const config = new ConfigService({ lambda: { base: 'http://lambda.ff.test' }, encryption: { keys: [DEVELOPMENT_KEY] } });
  const links = new LambdaCodeLinks(new EncryptionService(config), config);
  let functions: Function[];
  /** Each function's versions, by its name. */
  let versionsOf: Record<string, FunctionVersionView[]>;
  let aliasesOf: Record<string, Record<string, string>>;
  let reads: LambdaFunctionReads;

  beforeEach(() => {
    functions = [fn('orders'), fn('billing', { runtime: Runtime.PYTHON }), fn('archive'), fn('secret-sauce')];
    versionsOf = { orders: [version('orders', 1), version('orders', 3)], billing: [version('billing', 1)] };
    aliasesOf = { orders: { live: '3', edge: '$LATEST' } };
    const byId = (id: string) => functions.find((function_) => function_.id === id) as Function;
    const service = {
      findAll: jest.fn(async () => [...functions].reverse()),
      describe: jest.fn(async (_account: string, id: string) => ({ ...byId(id), environment: byId(id).name === 'orders' ? { TABLE: 'orders' } : {} })),
    } as unknown as FunctionsService;
    const versions = {
      list: jest.fn(async (_account: string, id: string) => (versionsOf[byId(id).name] ?? []).map(({ environment: _, ...listed }) => listed)),
      get: jest.fn(async (_account: string, id: string, number: number) => {
        const found = (versionsOf[byId(id).name] ?? []).find((candidate) => candidate.version === String(number));
        if (!found) throw new NotFoundException('no such version');
        return found;
      }),
    } as unknown as FunctionVersionsService;
    const aliases = {
      get: jest.fn(async (_account: string, id: string, name: string) => {
        const target = aliasesOf[byId(id).name]?.[name];
        if (!target) throw new NotFoundException('no such alias');
        return { name, functionVersion: target };
      }),
    } as unknown as FunctionAliasesService;
    const packages = { namedBytes: jest.fn(async () => 5_000_000) } as unknown as PackagesService;
    reads = new LambdaFunctionReads(service, versions, aliases, packages, links);
  });

  /** The front door's work for a request: the operation by its path, the function a path names, the key's reach. */
  async function ask(method: string, target: string, { qualifier, readable = () => true }: { qualifier?: string; readable?: (name: string) => boolean } = {}) {
    const [path, rawQuery = ''] = target.split('?');
    const route = operationOf(method, path);
    if (!route) throw new Error(`no operation at ${method} ${path}`);
    const call: LambdaCall = { operation: route.operation, groups: route.groups, query: new URLSearchParams(rawQuery), input: {}, body: Buffer.alloc(0), headers: {} };
    const named = route.groups[0];
    const caller: LambdaCaller = {
      accountId: ACCOUNT,
      region: REGION,
      key: {} as LambdaCaller['key'],
      plan: plan({ codeStorageMb: 2048, quota: { pods: 20, cpu: '4', memory: '8Gi' } }),
      ...(named ? { function_: functions.find((function_) => function_.name === named), named: { name: named, ...(qualifier ? { qualifier } : {}) } } : {}),
      mayUse: (name) => readable(name),
      actor: { id: 'access_key:AKFF', label: 'access key AKFF' },
    };
    return (await reads.handlers[route.operation.name](call, caller)).document as Record<string, unknown>;
  }

  /** The error an operation throws, as the front door answers it: its status, its type and its message. */
  async function refused(answer: Promise<unknown>): Promise<[number, string, string]> {
    const error = await answer.then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    if (!(error instanceof LambdaError)) throw new Error(`not refused in Lambda's words: ${String(error)}`);
    return [error.status, error.type, error.message];
  }

  describe("a function's configuration", () => {
    it("is FF's record under Lambda's names: the runtime's, the ARN, the time as Lambda writes it, its variables and never its secrets", () => {
      expect(latestConfiguration(fn('orders'), REGION, { TABLE: 'orders' })).toEqual({
        FunctionName: 'orders',
        FunctionArn: `${ARN}:orders`,
        Runtime: 'nodejs24.x',
        Handler: 'index.handler',
        CodeSize: 1234,
        Description: '',
        Timeout: 30,
        MemorySize: 256,
        CodeSha256: 'c2hhLW9mLXRoZS16aXA=',
        Environment: { Variables: { TABLE: 'orders' } },
        TracingConfig: { Mode: 'PassThrough' },
        PackageType: 'Zip',
        Architectures: ['x86_64'],
        EphemeralStorage: { Size: 512 },
        SnapStart: { ApplyOn: 'None', OptimizationStatus: 'Off' },
        LoggingConfig: { LogFormat: 'Text', LogGroup: '/aws/lambda/orders' },
        LastModified: '2026-11-02T10:20:30.456+0000',
        Version: '$LATEST',
        RevisionId: 'rev-orders',
        State: 'Active',
        LastUpdateStatus: 'Successful',
      });
      expect(latestConfiguration(fn('billing', { runtime: Runtime.PYTHON }), REGION, {})).toMatchObject({ Runtime: 'python3.13' });
      expect(latestConfiguration(fn('billing'), REGION, {})).not.toHaveProperty('Environment');
      expect(lambdaTime(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000+0000');
    });

    it('says a deploy under way is Pending, and one that failed Failed with its diagnosis, as the waiters read them', () => {
      expect(statesOf({ status: FunctionStatus.CREATING, error: null })).toEqual({
        State: 'Pending',
        StateReason: 'The function is being created.',
        StateReasonCode: 'Creating',
        LastUpdateStatus: 'InProgress',
        LastUpdateStatusReason: 'The function is being created.',
        LastUpdateStatusReasonCode: 'Creating',
      });
      expect(statesOf({ status: FunctionStatus.ACTIVE, error: null })).toEqual({ State: 'Active', LastUpdateStatus: 'Successful' });
      expect(statesOf({ status: FunctionStatus.ERROR, error: 'The handler threw at its import' })).toEqual({
        State: 'Failed',
        StateReason: 'The handler threw at its import',
        StateReasonCode: 'InvalidConfiguration',
        LastUpdateStatus: 'Failed',
        LastUpdateStatusReason: 'The handler threw at its import',
        LastUpdateStatusReasonCode: 'InvalidConfiguration',
      });
    });
  });

  describe('GetFunction and GetFunctionConfiguration', () => {
    it("give $LATEST's configuration, and GetFunction its code as a link of FF's that opens to the function", async () => {
      const answer = await ask('GET', '/2015-03-31/functions/orders');
      const code = answer.Code as { RepositoryType: string; Location: string };

      expect(answer.Configuration).toEqual(latestConfiguration(fn('orders'), REGION, { TABLE: 'orders' }));
      expect(code.RepositoryType).toBe('S3');
      expect(links.open(code.Location.replace('http://lambda.ff.test/code/', ''))).toEqual({ accountId: ACCOUNT, functionId: 'f-orders' });
      expect(await ask('GET', '/2015-03-31/functions/orders/configuration')).toEqual(answer.Configuration);
    });

    it("give a version's configuration for its number, and an alias's version's for its name, its link to that version's code", async () => {
      const three = await ask('GET', '/2015-03-31/functions/orders', { qualifier: '3' });
      const configuration = three.Configuration as Record<string, unknown>;

      expect(configuration).toMatchObject({
        FunctionArn: `${ARN}:orders:3`,
        Version: '3',
        Description: 'version 3',
        Runtime: 'python3.13',
        CodeSha256: 'sha-3',
        Environment: { Variables: { STAGE: 'v3' } },
        RevisionId: 'rev-orders-3',
        LastModified: '2026-11-01T08:00:00.000+0000',
        State: 'Active',
        LastUpdateStatus: 'Successful',
      });
      expect(links.open((three.Code as { Location: string }).Location.replace('http://lambda.ff.test/code/', ''))).toEqual({ accountId: ACCOUNT, functionId: 'f-orders', version: 3 });
      expect(await ask('GET', '/2015-03-31/functions/orders/configuration', { qualifier: 'live' })).toEqual(configuration);
      expect(await ask('GET', '/2015-03-31/functions/orders/configuration', { qualifier: 'edge' })).toMatchObject({ Version: '$LATEST' });
      expect(await ask('GET', '/2015-03-31/functions/orders/configuration', { qualifier: '$LATEST' })).toMatchObject({ Version: '$LATEST' });
    });

    it('answer a version or an alias the function lacks as a missing function, its qualified ARN named', async () => {
      expect(await refused(ask('GET', '/2015-03-31/functions/orders', { qualifier: '2' }))).toEqual([404, 'ResourceNotFoundException', `Function not found: ${ARN}:orders:2`]);
      expect(await refused(ask('GET', '/2015-03-31/functions/orders/configuration', { qualifier: 'beta' }))).toEqual([
        404,
        'ResourceNotFoundException',
        `Function not found: ${ARN}:orders:beta`,
      ]);
    });
  });

  describe('ListFunctions', () => {
    const names = (answer: Record<string, unknown>) => (answer.Functions as Array<{ FunctionName: string; Version: string }>).map((entry) => `${entry.FunctionName}:${entry.Version}`);

    it('lists the functions the key may read, by name, each with its configuration', async () => {
      const answer = await ask('GET', '/2015-03-31/functions/', { readable: (name) => name !== 'secret-sauce' });

      expect(names(answer)).toEqual(['archive:$LATEST', 'billing:$LATEST', 'orders:$LATEST']);
      expect((answer.Functions as unknown[])[2]).toEqual(latestConfiguration(fn('orders'), REGION, { TABLE: 'orders' }));
      expect(answer).not.toHaveProperty('NextMarker');
    });

    it('gives a page of MaxItems, then the next from its NextMarker; with FunctionVersion=ALL, each function followed by its versions', async () => {
      const first = await ask('GET', '/2015-03-31/functions/?FunctionVersion=ALL&MaxItems=3');
      const second = await ask('GET', `/2015-03-31/functions/?FunctionVersion=ALL&MaxItems=3&Marker=${String(first.NextMarker)}`);

      expect(names(first)).toEqual(['archive:$LATEST', 'billing:$LATEST', 'billing:1']);
      expect(names(second)).toEqual(['orders:$LATEST', 'orders:1', 'orders:3']);
      expect((second.Functions as unknown[])[2]).toMatchObject({ FunctionArn: `${ARN}:orders:3`, Environment: { Variables: { STAGE: 'v3' } } });
      expect(second).toHaveProperty('NextMarker');
      expect(names(await ask('GET', `/2015-03-31/functions/?FunctionVersion=ALL&MaxItems=3&Marker=${String(second.NextMarker)}`))).toEqual(['secret-sauce:$LATEST']);
    });

    it("refuses a page size out of Lambda's range, a marker it never gave, another FunctionVersion, and Lambda@Edge's MasterRegion", async () => {
      expect(await refused(ask('GET', '/2015-03-31/functions/?MaxItems=0'))).toEqual([400, 'InvalidParameterValueException', 'MaxItems must be a whole number from 1 to 10000, not 0.']);
      expect(await refused(ask('GET', '/2015-03-31/functions/?MaxItems=lots'))).toEqual([400, 'InvalidParameterValueException', 'MaxItems must be a whole number from 1 to 10000, not lots.']);
      expect(await refused(ask('GET', '/2015-03-31/functions/?Marker=bm9wZQ'))).toEqual([400, 'InvalidParameterValueException', 'Marker is not one that ListFunctions gave.']);
      expect(await refused(ask('GET', '/2015-03-31/functions/?FunctionVersion=SOME'))).toEqual([400, 'InvalidParameterValueException', 'FunctionVersion must be ALL, not SOME.']);
      expect(await refused(ask('GET', '/2015-03-31/functions/?FunctionVersion=ALL&MasterRegion=us-east-1'))).toEqual([
        400,
        'InvalidParameterValueException',
        "MasterRegion names a Lambda@Edge function's replicas: FF has none.",
      ]);
    });
  });

  it('GetFunctionCodeSigningConfig answers that there is none, as Terraform reads it', async () => {
    expect(await ask('GET', '/2020-06-30/functions/orders/code-signing-config')).toEqual({ CodeSigningConfigArn: '', FunctionName: 'orders' });
  });

  it("GetAccountSettings gives the plan's limits under Lambda's names, and what the account uses", async () => {
    expect(await ask('GET', '/2016-08-19/account-settings/')).toEqual({
      AccountLimit: {
        TotalCodeSize: 2048 * 1024 * 1024,
        CodeSizeUnzipped: 250 * 1024 * 1024,
        CodeSizeZipped: 50 * 1024 * 1024,
        ConcurrentExecutions: 20,
        UnreservedConcurrentExecutions: 20,
      },
      AccountUsage: { TotalCodeSize: 5_000_000, FunctionCount: 4 },
    });
  });

  describe("the operations' table", () => {
    const group = (...names: string[]): LambdaHandlers => ({ handlers: Object.fromEntries(names.map((name) => [name, async () => ({ status: 200 })])) });

    it("takes each group's handlers, the reads among them", () => {
      const operations = new LambdaOperations(reads);

      expect(['GetFunction', 'GetFunctionConfiguration', 'ListFunctions', 'GetFunctionCodeSigningConfig', 'GetAccountSettings'].every((name) => operations.handler(name))).toBe(true);
      expect(operations.handler('Invoke')).toBeUndefined();
    });

    it("refuses two handlers for one operation, and one for an operation it doesn't route", () => {
      expect(() => new LambdaOperations(group('GetFunction'), group('GetFunction'))).toThrow("Two handlers for Lambda's GetFunction");
      expect(() => new LambdaOperations(group('ListLayers'))).toThrow("A handler for ListLayers, which isn't among Lambda's operations here");
    });
  });
});

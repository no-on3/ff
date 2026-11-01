import { BadRequestException, ConflictException, HttpException, HttpStatus, InternalServerErrorException, Logger, MessageEvent, NotFoundException, PayloadTooLargeException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Not } from 'typeorm';
import { MetricsService } from '../metrics/metrics.service';
import { ObjectStoreService, StoredObjectMissingError } from '../object-store/object-store.service';
import {
  FunctionLoadError,
  FunctionRuntimeError,
  FunctionThrottledError,
  FunctionTimeoutError,
  InvalidLogCursorError,
  LogStoreUnavailableError,
  OrchestratorError,
} from '../orchestrator/orchestrator.errors';
import { ORCHESTRATOR, Orchestrator } from '../orchestrator/orchestrator.types';
import { PlanView } from '../plans/plan-limits';
import { PlansService } from '../plans/plans.service';
import { AuditService } from '../audit/audit.service';
import { UsageService } from '../usage/usage.service';
import { CreditService } from '../billing/credit.service';
import { InsufficientCreditException } from '../billing/credit-policy';
import { withInitMs } from '../orchestrator/orchestrator.errors';
import { BETA_LIMITS, plan } from '../plans/test-fixtures';
import { FunctionInvocation, InvocationSource, InvocationStatus } from './entities/function-invocation.entity';
import { FunctionUrl } from './entities/function-url.entity';
import { FunctionVersion } from './entities/function-version.entity';
import { Schedule } from '../schedules/schedule.entity';
import { inlineCodeFacts } from './code-package';
import { inlinePackage } from './inline-package';
import { lambdaJavaScript } from './lambda-javascript';
import { AwsEndpoint, awsEndpointsOf } from '../common/aws-endpoint';
import { EventFormat, Function, FunctionStatus, PackageType, Runtime } from './entities/function.entity';
import { EnvironmentStore } from './environment.store';
import { CodeImagesService } from '../packages/code-images.service';
import { packageKey } from '../packages/package.entity';
import { PackagesService } from '../packages/packages.service';
import { filesOf, zipOf } from '../packages/test-fixtures';
import { RegistryError } from '../packages/registry';
import { FunctionKeys } from '../storage/function-keys.service';
import { FunctionsService, workloadOf } from './functions.service';
import { memoryEnvironments } from './test-fixtures';
import { TAIL_ENDED, TAIL_UNAVAILABLE } from './live-tail';
import { Observable } from 'rxjs';

/** What the caller sees of a platform failure (D4): no details, and the request ID. */
const internal = (action: string) => new RegExp(`^${action} failed because of an internal error \\(request [0-9a-f-]{36}\\)\\.$`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('FunctionsService (orchestrator-agnostic)', () => {
  let service: FunctionsService;
  let orchestrator: jest.Mocked<Orchestrator>;
  /** The n-th invocation the service made, as it made it: its ID is its request's. */
  const created = (n = 0) => invocationsRepo.create.mock.results[n].value as FunctionInvocation;
  let savedStatuses: FunctionStatus[];
  const functionsRepo = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    remove: jest.fn(),
  };
  const invocationsRepo = { create: jest.fn(), save: jest.fn(), insert: jest.fn(), findAndCount: jest.fn() };
  const storage = { uploadCode: jest.fn(), deleteCode: jest.fn(), getDocument: jest.fn() };
  const metrics = { recordMetric: jest.fn(), invocationStarted: jest.fn(), invocationFinished: jest.fn() };
  /** The account's plan, and how many functions it has: the transaction that saves a new one counts them. */
  let accountPlan: PlanView;
  let existingFunctions: number;
  /** Whether a write of the account's namespace runs inside PlansService.withTenant, under the account's lock. */
  let underLock: boolean;
  const plans = { forAccount: jest.fn(), withTenant: jest.fn() };
  const transaction = { query: jest.fn(), countBy: jest.fn(), save: jest.fn(), existsBy: jest.fn() };
  /** The names the account's other functions have; and those another request takes after an update checked its new name. */
  let namesInUse: Set<string>;
  let takenMeanwhile: Set<string>;
  const TENANT = { quota: BETA_LIMITS.quota, internetEgress: false };
  const audit = { record: jest.fn() };
  const usage = { record: jest.fn() };
  /** D9's balance check (P-33): every account may invoke unless a test says otherwise. */
  const credit = { admit: jest.fn(async (_accountId: string) => undefined) };
  /** The account's packages, and the registry their images go to. */
  const packages = { name: jest.fn(), storeInline: jest.fn(), named: jest.fn(), restoreInlineZip: jest.fn() };
  const codeImages = { available: true, assertAvailable: jest.fn(), imageFor: jest.fn(), ensureImage: jest.fn(), hasMounted: jest.fn() };
  /** The image the registry gives a package, by its SHA-256. */
  const imageOf = (codeSha256: string) => `ff-dev-registry:5000/ff-code/user-1@sha256:${Buffer.from(codeSha256, 'base64').toString('hex')}`;
  /** The transaction that ends an invocation: it locks the row, saves the final state, then writes the usage record (D6). */
  const ending = { findOne: jest.fn(), save: jest.fn() };
  /** Each function's variables and secrets, as the service saved them. */
  let environments: ReturnType<typeof memoryEnvironments>;
  /** Functions' own keys to their account's buckets: none, unless a test gives them (FF without the front door's address for functions). */
  const functionKeys = { credentialsFor: jest.fn(), revoke: jest.fn() };

  const activeFunction = (): Function =>
    ({
      id: 'fn-1',
      name: 'hello',
      accountId: 'user-1',
      runtime: Runtime.NODEJS,
      code: 'export const handler = async () => 1;',
      packageType: PackageType.INLINE,
      handler: 'function.handler',
      ...inlineCodeFacts('export const handler = async () => 1;'),
      memory: 128,
      timeout: 5,
      minInstances: 0,
      maxInstances: 3,
      scaleToZero: true,
      awsEndpoints: awsEndpointsOf(),
      status: FunctionStatus.ACTIVE,
    }) as Function;

  let logged: jest.SpyInstance;

  beforeEach(async () => {
    jest.resetAllMocks();
    jest.restoreAllMocks();
    logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    savedStatuses = [];
    environments = memoryEnvironments();
    functionsRepo.create.mockImplementation((dto) => ({ ...dto }));
    functionsRepo.save.mockImplementation(async (entity) => {
      savedStatuses.push(entity.status);
      entity.id ??= 'fn-1';
      return entity;
    });
    accountPlan = plan();
    existingFunctions = 0;
    codeImages.imageFor.mockImplementation(async (_accountId: string, codeSha256: string) => imageOf(codeSha256));
    plans.forAccount.mockImplementation(async () => accountPlan);
    underLock = false;
    plans.withTenant.mockImplementation(async (_accountId: string, write: (tenant: unknown) => Promise<unknown>) => {
      underLock = true;
      try {
        return await write({ quota: accountPlan.limits.quota, internetEgress: false });
      } finally {
        underLock = false;
      }
    });
    transaction.countBy.mockImplementation(async () => existingFunctions);
    transaction.save.mockImplementation(async (_target, entity) => functionsRepo.save(entity));
    namesInUse = new Set();
    takenMeanwhile = new Set();
    const named = (where: { name: string }) => namesInUse.has(where.name);
    transaction.existsBy.mockImplementation(async (_target, where: { name: string }) => named(where) || takenMeanwhile.has(where.name));
    Object.assign(functionsRepo, {
      manager: { transaction: jest.fn(async (work) => work(transaction)), existsBy: jest.fn(async (_target, where: { name: string }) => named(where)) },
    });
    // The row as made, with the database's time.
    invocationsRepo.create.mockImplementation((dto) => ({ ...dto, createdAt: new Date('2026-10-17T10:00:00Z') }));
    ending.findOne.mockImplementation(async () => ({ status: InvocationStatus.RUNNING }));
    ending.save.mockImplementation(async (_target, entity) => invocationsRepo.save({ ...entity, updatedAt: new Date('2026-10-17T10:00:02Z') }));
    Object.assign(invocationsRepo, { manager: { transaction: jest.fn(async (work) => work(ending)) } });
    invocationsRepo.save.mockImplementation(async (entity) => entity);
    orchestrator = {
      deploy: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      removeTenant: jest.fn(),
      deleteLogs: jest.fn(),
      waitUntilReady: jest.fn(),
      invoke: jest.fn(),
      scale: jest.fn(),
      readyInstances: jest.fn(),
      desiredInstances: jest.fn(),
      readyInstancesByFunction: jest.fn(),
      codeImagesByFunction: jest.fn(),
      applyTenantLimits: jest.fn(),
      logs: jest.fn(),
      tailLogs: jest.fn(),
      ping: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        FunctionsService,
        { provide: getRepositoryToken(Function), useValue: functionsRepo },
        { provide: getRepositoryToken(FunctionInvocation), useValue: invocationsRepo },
        { provide: ObjectStoreService, useValue: storage },
        { provide: ORCHESTRATOR, useValue: orchestrator },
        // Return each key's default, as ConfigService does without overrides.
        { provide: ConfigService, useValue: { get: jest.fn((_key: string, fallback?: unknown) => fallback) } },
        { provide: MetricsService, useValue: metrics },
        { provide: PlansService, useValue: plans },
        { provide: AuditService, useValue: audit },
        { provide: UsageService, useValue: usage },
        { provide: CreditService, useValue: credit },
        { provide: EnvironmentStore, useValue: environments },
        { provide: PackagesService, useValue: packages },
        { provide: CodeImagesService, useValue: codeImages },
        { provide: FunctionKeys, useValue: functionKeys },
      ],
    }).compile();
    service = moduleRef.get(FunctionsService);
  });

  describe('create', () => {
    const dto = { name: 'hello', runtime: Runtime.NODEJS, code: 'x', memory: 128, timeout: 5 };

    it('creates the function for the calling tenant, deploys it, waits until ready, then marks it ACTIVE', async () => {
      const result = await service.create('user-42', dto);

      expect(storage.uploadCode).toHaveBeenCalledWith('fn-1/code.ts', 'x');
      expect(orchestrator.deploy).toHaveBeenCalledWith(expect.objectContaining({ id: 'fn-1', accountId: 'user-42' }), TENANT);
      expect(orchestrator.waitUntilReady).toHaveBeenCalledWith(expect.objectContaining({ id: 'fn-1' }), 90_000);
      expect(savedStatuses).toEqual([FunctionStatus.CREATING, FunctionStatus.ACTIVE]);
      expect(result.status).toBe(FunctionStatus.ACTIVE);
    });

    it("makes inline code a one-file package, kept with the account's, and mounts its image; the record names that package", async () => {
      const built = inlinePackage('x', Runtime.NODEJS);

      const result = await service.create('user-42', dto);

      expect(packages.storeInline).toHaveBeenCalledWith('user-42', built);
      expect(codeImages.imageFor).toHaveBeenCalledWith('user-42', built.codeSha256);
      expect(orchestrator.deploy).toHaveBeenCalledWith(expect.objectContaining({ codeImage: imageOf(built.codeSha256) }), TENANT);
      expect(functionsRepo.save).toHaveBeenCalledWith(expect.objectContaining({ packageSha256: built.codeSha256 }));
      // The answer gives the code's own hash, as for inline code: the package is the backend's to know.
      expect(result).toMatchObject({ packageType: PackageType.INLINE, ...inlineCodeFacts('x') });
    });

    it('refuses with 503, saving nothing, where this FF has no registry: no code reaches its pods without one', async () => {
      codeImages.assertAvailable.mockImplementation(() => {
        throw new ServiceUnavailableException("This FF has no code registry, so it can't deploy a function");
      });

      await expect(service.create('user-1', dto)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(packages.storeInline).not.toHaveBeenCalled();
      expect(functionsRepo.save).not.toHaveBeenCalled();
    });

    it("marks the function ERROR with its own load error, which its owner sees, and releases its pod", async () => {
      orchestrator.waitUntilReady.mockRejectedValue(new FunctionLoadError('Runtime.ImportModuleError', "Cannot find module 'lodash'"));

      const failure = service.create('user-1', dto);

      await expect(failure).rejects.toBeInstanceOf(BadRequestException);
      await expect(failure).rejects.toThrow("The function failed to load: Runtime.ImportModuleError: Cannot find module 'lodash'");
      expect(functionsRepo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: FunctionStatus.ERROR, error: expect.stringContaining("Cannot find module 'lodash'") }),
      );
      // The idle sweep only scales ACTIVE functions: without this, the pod would hold the quota for good.
      expect(orchestrator.scale).toHaveBeenCalledWith(expect.objectContaining({ id: 'fn-1' }), 0);
      expect(orchestrator.remove).not.toHaveBeenCalled();
    });

    it('answers a platform failure with a generic message and the request ID, in the record too; the details only go to the log (D4)', async () => {
      orchestrator.waitUntilReady.mockRejectedValue(
        new OrchestratorError('Function "hello" did not become ready within 90 s: no pods were created: exceeded quota ff-quota in ff-t-6b86b273ff34'),
      );

      const failure = service.create('user-1', dto);

      await expect(failure).rejects.toBeInstanceOf(InternalServerErrorException);
      await expect(failure).rejects.toThrow(internal('Deploying the function'));
      const [record] = functionsRepo.save.mock.calls.at(-1)!;
      expect(record).toMatchObject({ status: FunctionStatus.ERROR, error: expect.stringMatching(internal('Deploying the function')) });
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('exceeded quota ff-quota in ff-t-6b86b273ff34'), expect.anything());
      expect(orchestrator.scale).toHaveBeenCalledWith(expect.objectContaining({ id: 'fn-1' }), 0);
    });

    it('treats a failed deploy call as a platform failure', async () => {
      orchestrator.deploy.mockRejectedValue(new Error('scheduler unavailable'));

      await expect(service.create('user-1', dto)).rejects.toThrow(internal('Deploying the function'));
      expect(savedStatuses).toEqual([FunctionStatus.CREATING, FunctionStatus.ERROR]);
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('scheduler unavailable'), expect.anything());
    });

    it('still answers when the pod cannot be released', async () => {
      orchestrator.waitUntilReady.mockRejectedValue(new FunctionLoadError('Error', 'boom at init'));
      orchestrator.scale.mockRejectedValue(new Error('api down'));

      await expect(service.create('user-1', dto)).rejects.toThrow('The function failed to load: Error: boom at init');
      expect(savedStatuses).toEqual([FunctionStatus.CREATING, FunctionStatus.ERROR]);
    });

    // The function is saved before it is deployed: a client that took the failure for "nothing
    // created" would create it again, as the console did, and the account would have two.
    it.each([
      ['its code failed to load', new FunctionLoadError('Error', 'boom at init'), 400],
      ['the platform failed', new OrchestratorError('no pods were created'), 500],
    ])('names the function it saved, as ERROR, in the failure answer when %s', async (_case, error, status) => {
      orchestrator.deploy.mockRejectedValue(error);

      const failure = (await service.create('user-1', dto).catch((err: unknown) => err)) as HttpException;

      expect(failure.getStatus()).toBe(status);
      expect(failure.getResponse()).toMatchObject({ statusCode: status, message: failure.message, functionId: 'fn-1' });
      expect(savedStatuses.at(-1)).toBe(FunctionStatus.ERROR);
    });

    it('names no function when the request was refused before anything was saved', async () => {
      const failure = (await service.create('user-1', { ...dto, memory: 999_999 }).catch((err: unknown) => err)) as HttpException;

      expect(failure).toBeInstanceOf(BadRequestException);
      expect(failure.getResponse()).not.toHaveProperty('functionId');
      expect(functionsRepo.save).not.toHaveBeenCalled();
    });

    it("keeps its code's hash and size, as AWS Lambda's CodeSha256 and CodeSize, and its handler, function.handler unless it names another", async () => {
      const result = await service.create('user-42', dto);

      expect(result).toMatchObject({ packageType: PackageType.INLINE, handler: 'function.handler', codeSha256: 'LXEWQrcmsEQBYnyp+6wy9chTD7GQPMTbAiWHF5IaSIE=', codeSize: 1 });
      expect(orchestrator.deploy).toHaveBeenCalledWith(expect.objectContaining({ handler: 'function.handler' }), TENANT);

      await service.create('user-42', { ...dto, name: 'main', handler: 'function.main' });
      expect(orchestrator.deploy).toHaveBeenLastCalledWith(expect.objectContaining({ handler: 'function.main' }), TENANT);
    });

    it('refuses a handler outside the one file inline code is, before saving anything', async () => {
      const failure = (await service.create('user-1', { ...dto, handler: 'src/app.handler' }).catch((err: unknown) => err)) as HttpException;

      expect(failure).toBeInstanceOf(BadRequestException);
      expect(failure.getResponse()).toMatchObject({
        message: ['handler must be function.<name> for inline code, which is the file function.ts: function.handler, for example'],
      });
      expect(functionsRepo.save).not.toHaveBeenCalled();
      expect(orchestrator.deploy).not.toHaveBeenCalled();
    });
  });

  describe("a function made from a package (CLI plan, C-23)", () => {
    const PACKAGE = 'n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=';
    const IMAGE = 'ff-dev-registry:5000/ff-code/user-1@sha256:' + 'f'.repeat(64);
    const dto = { name: 'orders', runtime: Runtime.NODEJS, memory: 128, timeout: 5, codeSha256: PACKAGE, handler: 'src/orders.create' };
    const refusal = async (attempt: Promise<unknown>) => {
      const error = (await attempt.catch((err: unknown) => err)) as HttpException;
      return [error.getStatus(), (error.getResponse() as { message: unknown }).message];
    };

    beforeEach(() => {
      packages.name.mockResolvedValue({ codeSize: 4096, files: ['node_modules/left-pad/index.js', 'src/orders.js'] });
      codeImages.imageFor.mockResolvedValue(IMAGE);
    });

    it("runs the account's package: zip, its size, its handler found in its files, its pods mounting its image, no inline copy", async () => {
      const result = await service.create('user-1', dto);

      expect(packages.name).toHaveBeenCalledWith('user-1', PACKAGE);
      expect(codeImages.imageFor).toHaveBeenCalledWith('user-1', PACKAGE);
      expect(orchestrator.deploy).toHaveBeenCalledWith(expect.objectContaining({ codeImage: IMAGE, packageType: PackageType.ZIP, handler: 'src/orders.create' }), TENANT);
      expect(result).toMatchObject({ packageType: PackageType.ZIP, code: '', codeSha256: PACKAGE, codeSize: 4096, status: FunctionStatus.ACTIVE });
      expect(storage.uploadCode).not.toHaveBeenCalled();
    });

    it('refuses, before saving anything: code and a package both, a package the account hasn\'t, a handler the package lacks', async () => {
      expect(await refusal(service.create('user-1', { ...dto, code: 'exports.handler = 1' }))).toEqual([
        400,
        ['Send code or codeSha256, not both: inline code, or a package uploaded with POST /packages'],
      ]);
      expect(await refusal(service.create('user-1', { ...dto, handler: 'index.handler' }))).toEqual([
        400,
        ['The package has no index.js, .mjs, .cjs or .ts, nor a folder index/, which the handler index.handler names'],
      ]);
      packages.name.mockResolvedValue(undefined);
      expect(await refusal(service.create('user-1', dto))).toEqual([
        400,
        [`The account has no package ${PACKAGE}: upload it with POST /packages, which answers its SHA-256`],
      ]);
      expect(functionsRepo.save).not.toHaveBeenCalled();
      expect(orchestrator.deploy).not.toHaveBeenCalled();
    });

    it('refuses with 503 where this FF has no registry to run packages from, before saving anything', async () => {
      codeImages.assertAvailable.mockImplementation(() => {
        throw new ServiceUnavailableException("This FF has no code registry, so it can't run a package: its operator sets FF_CODE_REGISTRY (ADR 0003)");
      });

      expect((await refusal(service.create('user-1', dto)))[0]).toBe(503);
      expect(functionsRepo.save).not.toHaveBeenCalled();
    });

    it('moves an inline function to a package in one rollout with its handler, its inline copy deleted; and back with code', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());

      const zipped = await service.update('user-1', 'fn-1', { codeSha256: PACKAGE, handler: 'src/orders.create', memory: 256 });

      expect(orchestrator.update).toHaveBeenCalledTimes(1);
      expect(orchestrator.update).toHaveBeenLastCalledWith(expect.objectContaining({ codeImage: IMAGE, handler: 'src/orders.create', memory: 256 }), TENANT);
      expect(zipped).toMatchObject({ packageType: PackageType.ZIP, code: '', codeSha256: PACKAGE, codeSize: 4096 });
      expect(storage.deleteCode).toHaveBeenCalledWith('fn-1/code.ts');
      expect(storage.uploadCode).not.toHaveBeenCalled();

      functionsRepo.findOne.mockResolvedValue({ ...zipped });
      const inline = await service.update('user-1', 'fn-1', { code: 'export const main = async () => 2;', handler: 'function.main' });

      // Inline code goes the same way: its one-file package, kept with the account's, and that package's image.
      const built = inlinePackage('export const main = async () => 2;', Runtime.NODEJS);
      expect(packages.storeInline).toHaveBeenLastCalledWith('user-1', built);
      expect(codeImages.imageFor).toHaveBeenLastCalledWith('user-1', built.codeSha256);
      expect(inline).toMatchObject({ packageType: PackageType.INLINE, ...inlineCodeFacts('export const main = async () => 2;') });
      expect(storage.uploadCode).toHaveBeenCalledWith('fn-1/code.ts', 'export const main = async () => 2;');
    });

    it("checks a new handler or runtime against the package's files, keeping the package another hour", async () => {
      functionsRepo.findOne.mockResolvedValue({ ...activeFunction(), packageType: PackageType.ZIP, code: '', codeSha256: PACKAGE, codeSize: 4096, handler: 'src/orders.create' });

      expect(await refusal(service.update('user-1', 'fn-1', { runtime: Runtime.PYTHON }))).toEqual([
        400,
        ['The package has no src/orders.py, nor a package src/orders/, which the handler src/orders.create names'],
      ]);
      await service.update('user-1', 'fn-1', { handler: 'src/orders.list' });
      expect(packages.name).toHaveBeenLastCalledWith('user-1', PACKAGE);
      expect(orchestrator.update).toHaveBeenCalledWith(expect.objectContaining({ handler: 'src/orders.list', codeImage: IMAGE }), TENANT);
    });

    it("answers 503 when the registry can't be reached, and changes nothing: no function saved, no rollout, no rollback", async () => {
      codeImages.imageFor.mockRejectedValue(new RegistryError('HEAD /v2/ff-code/user-1/manifests/sha256:… got no answer: connect ECONNREFUSED'));
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      expect(await refusal(service.create('user-1', dto))).toEqual([503, "The code registry can't be reached: nothing changed, try again in a moment"]);
      expect(functionsRepo.save).not.toHaveBeenCalled();

      const working = { ...activeFunction(), packageType: PackageType.ZIP, code: '', codeSha256: PACKAGE, codeSize: 4096, handler: 'src/orders.create' };
      functionsRepo.findOne.mockResolvedValue(working);
      expect((await refusal(service.update('user-1', 'fn-1', { memory: 256 })))[0]).toBe(503);
      expect(orchestrator.update).not.toHaveBeenCalled();
      expect(functionsRepo.save).not.toHaveBeenCalled();
    });

    it('rolls a failed update back to the version before, its code image included', async () => {
      const before = { ...activeFunction(), packageType: PackageType.ZIP, code: '', codeSha256: PACKAGE, codeSize: 4096, handler: 'src/orders.create' };
      functionsRepo.findOne.mockResolvedValue(before);
      orchestrator.waitUntilReady.mockRejectedValueOnce(new FunctionLoadError('Runtime.ImportModuleError', 'boom'));

      await service.update('user-1', 'fn-1', { code: 'broken', handler: 'function.handler' }).catch(() => undefined);

      // The attempt ran inline code's package; the rollback, the package before.
      expect(codeImages.imageFor.mock.calls.map(([, codeSha256]) => codeSha256)).toEqual([inlinePackage('broken', Runtime.NODEJS).codeSha256, PACKAGE]);
      expect(orchestrator.update.mock.calls.map(([workload]) => (workload as { codeImage?: string }).codeImage)).toEqual([IMAGE, IMAGE]);
    });
  });

  describe("a function's code, as AWS Lambda takes it", () => {
    const PACKAGE = 'n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=';
    const TYPESCRIPT = 'enum Greeting { Hello = "Ahlan" }\nexport const handler = async (event: { name: string }) => `${Greeting.Hello}, ${event.name}`;\n';
    const named = (fields: Partial<Function>) => functionsRepo.findOne.mockResolvedValue({ ...activeFunction(), ...fields });

    it('gives a package as it was uploaded, read from where object storage keeps it, with javascript too', async () => {
      const zip = zipOf([{ name: 'src/orders.ts', data: 'export const create = async () => 201;' }]);
      named({ name: 'orders', packageType: PackageType.ZIP, code: '', codeSha256: PACKAGE, handler: 'src/orders.create' });
      storage.getDocument.mockResolvedValue({ body: zip, contentType: 'application/zip' });

      await expect(service.code('user-1', 'fn-1')).resolves.toEqual({ name: 'orders', zip });
      await expect(service.code('user-1', 'fn-1', { javascript: true })).resolves.toEqual({ name: 'orders', zip });
      expect(storage.getDocument.mock.calls).toEqual([[packageKey('user-1', PACKAGE)], [packageKey('user-1', PACKAGE)]]);
    });

    it('gives inline code as the one-file package its pods run, byte for byte', async () => {
      named({ name: 'greet', code: TYPESCRIPT, ...inlineCodeFacts(TYPESCRIPT) });

      const { name, zip } = await service.code('user-1', 'fn-1');

      expect(name).toBe('greet');
      expect(zip.equals(inlinePackage(TYPESCRIPT, Runtime.NODEJS).zip)).toBe(true);
      expect(storage.getDocument).not.toHaveBeenCalled();
    });

    it("gives inline Node.js code as JavaScript with javascript, in function.js, which the function's handler names on Lambda", async () => {
      named({ code: TYPESCRIPT, ...inlineCodeFacts(TYPESCRIPT), handler: 'function.handler' });

      const { zip } = await service.code('user-1', 'fn-1', { javascript: true });

      expect(await filesOf(zip)).toEqual({ 'function.js': await lambdaJavaScript(TYPESCRIPT) });
    });

    it('gives Python code as it is, with javascript too', async () => {
      const python = 'def handler(event, context):\n    return "Ahlan"\n';
      named({ runtime: Runtime.PYTHON, code: python, ...inlineCodeFacts(python) });

      expect(await filesOf((await service.code('user-1', 'fn-1', { javascript: true })).zip)).toEqual({ 'function.py': python });
    });
  });

  describe('the restore of code images the registry has lost (ADR 0003)', () => {
    const UPLOADED = 'n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=';
    const INLINE = inlinePackage('export const handler = async () => 1;', Runtime.NODEJS);
    /** An image another backend made of the same package, which the registry has lost: another digest. */
    const LOST = 'ff-dev-registry:5000/ff-code/user-1@sha256:' + '0'.repeat(64);
    /** The advisory lock, free unless a test says another backend holds it. */
    let lockFree: boolean;
    const runner = { connect: jest.fn(), release: jest.fn(), query: jest.fn() };
    /** The working functions' packages, and what each function's pods mount. */
    let working: Array<{ id: string; accountId: string; packageSha256: string }>;

    beforeEach(() => {
      lockFree = true;
      codeImages.available = true;
      runner.query.mockImplementation(async (sql: string) => (sql.includes('pg_try_advisory_lock') ? [{ locked: lockFree }] : []));
      // No version's code makes a one-file package, unless a test says one does.
      Object.assign((functionsRepo as unknown as { manager: object }).manager, { connection: { createQueryRunner: () => runner }, find: jest.fn(async () => []) });
      working = [];
      functionsRepo.find.mockImplementation(async ({ where }: { where: { packageType?: PackageType } }) =>
        // The functions whose code makes a one-file package; or the working functions' packages.
        where.packageType === PackageType.INLINE ? [activeFunction()] : working,
      );
      codeImages.ensureImage.mockImplementation(async (_accountId: string, codeSha256: string) => ({ reference: imageOf(codeSha256), made: false }));
      orchestrator.codeImagesByFunction.mockResolvedValue(new Map());
    });

    it("makes again the image of each package in use that the registry lost, and rolls nothing out whose pods mount it as it is", async () => {
      packages.named.mockResolvedValue([
        { accountId: 'user-1', codeSha256: UPLOADED, inline: false },
        { accountId: 'user-1', codeSha256: INLINE.codeSha256, inline: true },
      ]);
      codeImages.ensureImage.mockImplementation(async (_accountId: string, codeSha256: string) => ({ reference: imageOf(codeSha256), made: codeSha256 === UPLOADED }));
      working = [{ id: 'fn-1', accountId: 'user-1', packageSha256: UPLOADED }];
      orchestrator.codeImagesByFunction.mockResolvedValue(new Map([['fn-1', imageOf(UPLOADED)]]));

      expect(await service.restoreCodeImages()).toEqual({ packages: 2, imagesMade: 1, zipsMade: 0, rolledOut: 0, failures: 0 });
      expect(codeImages.ensureImage.mock.calls).toEqual([
        ['user-1', UPLOADED],
        ['user-1', INLINE.codeSha256],
      ]);
      expect(orchestrator.update).not.toHaveBeenCalled();
      // One backend at a time: the lock taken, and given back.
      expect(runner.query.mock.calls.map(([sql]) => sql)).toEqual([
        "SELECT pg_try_advisory_lock(hashtext('ff_code_images_restore')) AS \"locked\"",
        "SELECT pg_advisory_unlock(hashtext('ff_code_images_restore'))",
      ]);
      expect(runner.release).toHaveBeenCalled();
    });

    it("rolls a working function whose pods mount a lost image out with its package's, as its record has it; one mounting an image the registry has stays", async () => {
      packages.named.mockResolvedValue([{ accountId: 'user-1', codeSha256: INLINE.codeSha256, inline: true }]);
      codeImages.ensureImage.mockResolvedValue({ reference: imageOf(INLINE.codeSha256), made: true });
      working = [
        { id: 'fn-1', accountId: 'user-1', packageSha256: INLINE.codeSha256 },
        { id: 'fn-2', accountId: 'user-1', packageSha256: INLINE.codeSha256 },
      ];
      // fn-2's pods mount the image of an update under way, which the registry has whole.
      const UPDATING = imageOf(UPLOADED);
      orchestrator.codeImagesByFunction.mockResolvedValue(new Map([['fn-1', LOST], ['fn-2', UPDATING]]));
      codeImages.hasMounted.mockImplementation(async (reference: string) => reference === UPDATING);
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      await environments.save({ id: 'fn-1', accountId: 'user-1' }, { variables: { TABLE: 'orders' }, secrets: {}, revision: 'r1' });

      expect(await service.restoreCodeImages()).toMatchObject({ imagesMade: 1, rolledOut: 1, failures: 0 });
      expect(orchestrator.update).toHaveBeenCalledTimes(1);
      expect(orchestrator.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'fn-1', codeImage: imageOf(INLINE.codeSha256), environment: { revision: 'r1', values: { TABLE: 'orders' } } }),
        TENANT,
      );
      expect(orchestrator.waitUntilReady).toHaveBeenCalledWith(expect.objectContaining({ id: 'fn-1' }), 90_000);
      // Its record as it is now, still running that package; and nothing saved, nothing audited: its version is the same.
      expect(functionsRepo.findOne).toHaveBeenCalledWith({ where: { id: 'fn-1', accountId: 'user-1', status: FunctionStatus.ACTIVE, packageSha256: INLINE.codeSha256 } });
      expect(functionsRepo.save).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it("makes a one-file package's zip again of its function's code when object storage lost it too; an upload's lost zip is a failure, saying where it comes back from", async () => {
      packages.named.mockResolvedValue([
        { accountId: 'user-1', codeSha256: INLINE.codeSha256, inline: true },
        { accountId: 'user-1', codeSha256: UPLOADED, inline: false },
      ]);
      const zipLost = () => new StoredObjectMissingError('Object storage has no packages/user-1/….zip');
      codeImages.ensureImage
        .mockRejectedValueOnce(zipLost())
        .mockResolvedValueOnce({ reference: imageOf(INLINE.codeSha256), made: true })
        .mockRejectedValueOnce(zipLost());

      expect(await service.restoreCodeImages()).toEqual({ packages: 2, imagesMade: 1, zipsMade: 1, rolledOut: 0, failures: 1 });
      expect(packages.restoreInlineZip).toHaveBeenCalledWith('user-1', INLINE);
      expect(functionsRepo.find).toHaveBeenCalledWith({ where: { accountId: 'user-1', packageType: PackageType.INLINE, packageSha256: INLINE.codeSha256 } });
      expect(logged).toHaveBeenCalledWith(expect.stringContaining(`package ${UPLOADED} of account user-1 again: its zip is lost too; restore the packages from the second site`));
    });

    it("makes a one-file package's zip again of a version's code, once its function's code has moved on", async () => {
      packages.named.mockResolvedValue([{ accountId: 'user-1', codeSha256: INLINE.codeSha256, inline: true }]);
      codeImages.ensureImage.mockRejectedValueOnce(new StoredObjectMissingError('Object storage has no packages/user-1/….zip'));
      functionsRepo.find.mockImplementation(async ({ where }: { where: { packageType?: PackageType } }) => (where.packageType === PackageType.INLINE ? [] : working));
      const { manager } = functionsRepo as unknown as { manager: { find: jest.Mock } };
      manager.find.mockResolvedValue([{ functionId: 'fn-1', version: 3, code: 'export const handler = async () => 1;', runtime: Runtime.NODEJS }]);
      const warned = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      expect(await service.restoreCodeImages()).toMatchObject({ zipsMade: 1, failures: 0 });
      expect(packages.restoreInlineZip).toHaveBeenCalledWith('user-1', INLINE);
      expect(manager.find).toHaveBeenCalledWith(FunctionVersion, { where: { accountId: 'user-1', packageType: PackageType.INLINE, packageSha256: INLINE.codeSha256 } });
      expect(warned).toHaveBeenCalledWith(expect.stringContaining("made again of version 3 of function fn-1's code"));
      expect(logged).not.toHaveBeenCalled();
    });

    it('logs a function it could not roll out, and goes on to the next', async () => {
      packages.named.mockResolvedValue([{ accountId: 'user-1', codeSha256: INLINE.codeSha256, inline: true }]);
      working = [
        { id: 'fn-1', accountId: 'user-1', packageSha256: INLINE.codeSha256 },
        { id: 'fn-2', accountId: 'user-1', packageSha256: INLINE.codeSha256 },
      ];
      orchestrator.codeImagesByFunction.mockResolvedValue(new Map([['fn-1', LOST], ['fn-2', LOST]]));
      codeImages.hasMounted.mockResolvedValue(false);
      functionsRepo.findOne.mockImplementation(async ({ where }: { where: { id: string } }) => ({ ...activeFunction(), id: where.id }));
      orchestrator.waitUntilReady.mockRejectedValueOnce(new OrchestratorError('fn-1 did not become ready'));

      expect(await service.restoreCodeImages()).toMatchObject({ rolledOut: 1, failures: 1 });
      expect(orchestrator.update.mock.calls.map(([workload]) => workload.id)).toEqual(['fn-1', 'fn-2']);
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('Could not roll function fn-1 out with its code image'));
    });

    it('does nothing while another backend runs it, nor where this FF has no registry', async () => {
      lockFree = false;
      expect(await service.restoreCodeImages()).toEqual({ packages: 0, imagesMade: 0, zipsMade: 0, rolledOut: 0, failures: 0 });
      expect(packages.named).not.toHaveBeenCalled();
      expect(runner.release).toHaveBeenCalled();

      runner.connect.mockClear();
      codeImages.available = false;
      await service.restoreCodeImages();
      expect(runner.connect).not.toHaveBeenCalled();
    });
  });

  describe('names, unique within an account', () => {
    const dto = { name: 'hello', runtime: Runtime.NODEJS, code: 'x', memory: 128, timeout: 5 };
    const taken = (name: string) => `A function named "${name}" already exists in this account: choose another name, or change that function`;
    const failureOf = (promise: Promise<unknown>) => promise.then(() => undefined, (err: unknown) => err as HttpException);
    const LOCK = 'SELECT 1 FROM "accounts" WHERE "id" = $1 FOR NO KEY UPDATE';

    it("refuses a create with another function's name, with 409, before saving, archiving or deploying anything", async () => {
      namesInUse.add('hello');

      const failure = await failureOf(service.create('user-1', dto));

      expect(failure).toBeInstanceOf(ConflictException);
      expect(failure?.message).toBe(taken('hello'));
      expect(transaction.existsBy).toHaveBeenCalledWith(Function, { accountId: 'user-1', name: 'hello' });
      // Checked under the lock the plan's count takes: two creates at once can't both pass.
      expect(transaction.query).toHaveBeenCalledWith(LOCK, ['user-1']);
      expect(transaction.query.mock.invocationCallOrder[0]).toBeLessThan(transaction.existsBy.mock.invocationCallOrder[0]);
      expect(functionsRepo.save).not.toHaveBeenCalled();
      expect(storage.uploadCode).not.toHaveBeenCalled();
      expect(orchestrator.deploy).not.toHaveBeenCalled();
    });

    it("refuses a rename to another function's name before rolling anything out", async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      namesInUse.add('taken');

      const failure = await failureOf(service.update('user-1', 'fn-1', { name: 'taken', code: 'v2' }));

      expect(failure).toBeInstanceOf(ConflictException);
      expect(failure?.message).toBe(taken('taken'));
      // The account's other functions: never another account's, never the function itself.
      expect((functionsRepo as unknown as { manager: { existsBy: jest.Mock } }).manager.existsBy).toHaveBeenCalledWith(Function, {
        accountId: 'user-1',
        name: 'taken',
        id: Not('fn-1'),
      });
      expect(orchestrator.update).not.toHaveBeenCalled();
      expect(functionsRepo.save).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('checks no name an update sends unchanged', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      namesInUse.add('hello'); // as a check that didn't leave the function itself out would find

      await expect(service.update('user-1', 'fn-1', { name: 'hello', memory: 256 })).resolves.toMatchObject({ name: 'hello', memory: 256 });
    });

    it("renames when the name is free, claimed under the account's lock", async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());

      await expect(service.update('user-1', 'fn-1', { name: 'renamed' })).resolves.toMatchObject({ name: 'renamed' });

      expect(transaction.query).toHaveBeenCalledWith(LOCK, ['user-1']);
      expect(transaction.existsBy).toHaveBeenCalledWith(Function, { accountId: 'user-1', name: 'renamed', id: Not('fn-1') });
      expect(transaction.save).toHaveBeenCalledWith(Function, expect.objectContaining({ id: 'fn-1', name: 'renamed' }));
    });

    it('saves nothing when another request took the name since the check, for a rename alone', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      takenMeanwhile.add('new');

      const failure = await failureOf(service.update('user-1', 'fn-1', { name: 'new' }));

      expect(failure).toBeInstanceOf(ConflictException);
      expect(failure?.message).toBe(taken('new'));
      expect(functionsRepo.save).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('keeps the record true to a version that went live while another request took the new name: the old name, the new code, and a 409', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      takenMeanwhile.add('new');

      const failure = await failureOf(service.update('user-1', 'fn-1', { name: 'new', code: 'v2' }));

      expect(failure).toBeInstanceOf(ConflictException);
      expect(failure?.message).toBe('The new version is live, but the function keeps its name "hello": another function was given the name "new" meanwhile');
      expect(functionsRepo.save).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'hello', code: 'v2', status: FunctionStatus.ACTIVE }));
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ changed: ['code'], outcome: 'live' }) }));
      expect(storage.uploadCode).toHaveBeenCalledWith('fn-1/code.ts', 'v2');
    });

    it('keeps a failed repair under the old name when another request took the new one, and says so with the failure', async () => {
      functionsRepo.findOne.mockResolvedValue({ ...activeFunction(), status: FunctionStatus.ERROR, error: 'old diagnosis' });
      orchestrator.waitUntilReady.mockRejectedValue(new FunctionLoadError('Error', 'boom at init'));
      takenMeanwhile.add('new');

      const failure = await failureOf(service.update('user-1', 'fn-1', { name: 'new', code: 'still broken' }));

      expect(failure).toBeInstanceOf(BadRequestException);
      expect(failure?.message).toBe(
        'The function failed to load: Error: boom at init. The function keeps its name "hello": another function was given the name "new" meanwhile.',
      );
      expect(functionsRepo.save).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'hello', code: 'still broken', status: FunctionStatus.ERROR }));
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ changed: ['code'] }) }));
      expect(orchestrator.scale).toHaveBeenCalledWith(expect.objectContaining({ id: 'fn-1' }), 0);
    });
  });

  describe('update', () => {
    const notReady = () => new FunctionLoadError('Error', 'boom at init');
    const errored = (): Function => ({ ...activeFunction(), status: FunctionStatus.ERROR, error: 'old diagnosis' });

    it("makes a new version of inline code a new package, which the record names once it is live", async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      const built = inlinePackage('v2', Runtime.NODEJS);

      await service.update('user-1', 'fn-1', { code: 'v2' });

      expect(packages.storeInline).toHaveBeenCalledWith('user-1', built);
      expect(orchestrator.update).toHaveBeenCalledWith(expect.objectContaining({ codeImage: imageOf(built.codeSha256) }), TENANT);
      expect(functionsRepo.save).toHaveBeenLastCalledWith(expect.objectContaining({ code: 'v2', packageSha256: built.codeSha256 }));
    });

    it('rolls out code changes, waits until they are live, then saves them and archives the code', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());

      const result = await service.update('user-1', 'fn-1', { code: 'v2' });

      expect(orchestrator.update).toHaveBeenCalledWith(expect.objectContaining({ code: 'v2' }), TENANT);
      expect(orchestrator.waitUntilReady).toHaveBeenCalledWith(expect.objectContaining({ code: 'v2' }), 90_000);
      expect(storage.uploadCode).toHaveBeenCalledWith('fn-1/code.ts', 'v2');
      // The copy in object storage is written only once the new version is live.
      expect(storage.uploadCode.mock.invocationCallOrder[0]).toBeGreaterThan(
        orchestrator.waitUntilReady.mock.invocationCallOrder[0],
      );
      expect(result).toMatchObject({ code: 'v2', status: FunctionStatus.ACTIVE, error: null });
    });

    it("keeps the new code's hash and size with it, in the version rolled out and in the record", async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());

      const result = await service.update('user-1', 'fn-1', { code: 'é' });

      expect(orchestrator.update).toHaveBeenCalledWith(expect.objectContaining({ code: 'é', ...inlineCodeFacts('é') }), TENANT);
      expect(result).toMatchObject({ code: 'é', codeSize: 2, codeSha256: inlineCodeFacts('é').codeSha256 });
    });

    it.each([
      ['memory', { memory: 256 }],
      ['timeout', { timeout: 30 }],
      ['runtime', { runtime: Runtime.PYTHON }],
      ['handler', { handler: 'function.main' }],
      ["event format's", { eventFormat: EventFormat.WRAPPED }],
    ])('rolls out a %s change', async (_field, change) => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());

      await service.update('user-1', 'fn-1', change);

      expect(orchestrator.update).toHaveBeenCalledWith(expect.objectContaining(change), TENANT);
    });

    it("refuses the wrapped event to a function with a URL, which sends AWS Lambda's events, and rolls nothing out", async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      const { manager } = functionsRepo as unknown as { manager: { existsBy: jest.Mock } };
      manager.existsBy.mockImplementation(async (target: unknown, where: { functionId?: string }) => target === FunctionUrl && where.functionId === 'fn-1');

      await expect(service.update('user-1', 'fn-1', { eventFormat: EventFormat.WRAPPED })).rejects.toThrow(
        "The function has a URL, which sends AWS Lambda's events, and the wrapped format can't take them: delete its URL (DELETE /functions/fn-1/url) first, or keep eventFormat lambda",
      );
      expect(orchestrator.update).not.toHaveBeenCalled();
      // Back to lambda, or another change, is no business of its URL's.
      await service.update('user-1', 'fn-1', { eventFormat: EventFormat.LAMBDA, memory: 256 });
      expect(orchestrator.update).toHaveBeenCalledTimes(1);
    });

    it("refuses the wrapped event to a function with schedules, which send EventBridge's Scheduled Event", async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      const { manager } = functionsRepo as unknown as { manager: { existsBy: jest.Mock } };
      manager.existsBy.mockImplementation(async (target: unknown, where: { functionId?: string }) => target === Schedule && where.functionId === 'fn-1');

      await expect(service.update('user-1', 'fn-1', { eventFormat: EventFormat.WRAPPED })).rejects.toThrow(
        "The function has schedules, which send EventBridge's Scheduled Event, and the wrapped format can't take it: delete them (DELETE /functions/fn-1/schedules/{scheduleId}) first, or keep eventFormat lambda",
      );
      expect(orchestrator.update).not.toHaveBeenCalled();
    });

    it("refuses a handler its runtime can't find in inline code, checking the runtime the function will have", async () => {
      functionsRepo.findOne.mockResolvedValue({ ...activeFunction(), handler: 'function.handlers.main' });
      const refusal = (change: object) => service.update('user-1', 'fn-1', change).catch((err: unknown) => (err as HttpException).getResponse());

      expect(await refusal({ runtime: Runtime.PYTHON })).toMatchObject({
        message: ['handler must be function.<name> for inline code, which is the file function.py: function.handler, for example'],
      });
      expect(await refusal({ handler: 'app.handler' })).toMatchObject({
        message: ['handler must be function.<name> for inline code, which is the file function.ts: function.handler, for example'],
      });
      expect(orchestrator.update).not.toHaveBeenCalled();
      // With a handler Python finds, the change goes through.
      await service.update('user-1', 'fn-1', { runtime: Runtime.PYTHON, handler: 'function.main' });
      expect(orchestrator.update).toHaveBeenCalledWith(expect.objectContaining({ runtime: Runtime.PYTHON, handler: 'function.main' }), TENANT);
    });

    it('moves the archived copy when the runtime changes', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());

      await service.update('user-1', 'fn-1', { runtime: Runtime.PYTHON, code: 'def handler(e, c): return 1' });

      expect(storage.uploadCode).toHaveBeenCalledWith('fn-1/code.py', 'def handler(e, c): return 1');
      expect(storage.deleteCode).toHaveBeenCalledWith('fn-1/code.ts');
    });

    it('does not roll out an ACTIVE function when only the name changes, or when values are unchanged', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      await service.update('user-1', 'fn-1', { name: 'renamed' });
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      await service.update('user-1', 'fn-1', { memory: 128 });

      expect(orchestrator.update).not.toHaveBeenCalled();
      expect(storage.uploadCode).not.toHaveBeenCalled();
      expect(savedStatuses).toEqual([FunctionStatus.ACTIVE, FunctionStatus.ACTIVE]);
    });

    it('repairs a function in ERROR: a successful rollout makes it ACTIVE and clears the error', async () => {
      functionsRepo.findOne.mockResolvedValue(errored());

      const result = await service.update('user-1', 'fn-1', { code: 'fixed' });

      expect(result).toMatchObject({ code: 'fixed', status: FunctionStatus.ACTIVE, error: null });
    });

    it.each([
      ['no field', {}],
      ['only the name', { name: 'renamed' }],
    ])('rolls out a function in ERROR even when %s changes, so the same code can be retried', async (_label, change) => {
      functionsRepo.findOne.mockResolvedValue(errored());

      const result = await service.update('user-1', 'fn-1', change);

      expect(orchestrator.update).toHaveBeenCalledWith(expect.objectContaining({ code: activeFunction().code }), TENANT);
      expect(orchestrator.waitUntilReady).toHaveBeenCalled();
      expect(result.status).toBe(FunctionStatus.ACTIVE);
    });

    it('rolls a failed update of a working function back: the previous version is applied again, nothing is saved or archived', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.waitUntilReady.mockRejectedValueOnce(notReady()); // the new version; the previous one is ready

      const failure = service.update('user-1', 'fn-1', { code: 'broken' });

      await expect(failure).rejects.toBeInstanceOf(BadRequestException);
      await expect(failure).rejects.toThrow(
        'The function failed to load: Error: boom at init. The update was rolled back: the previous version is still live.',
      );
      // Named, as a failed create names the function: the new version never served it.
      expect(((await failure.catch((error: unknown) => error)) as HttpException).getResponse()).toMatchObject({ functionId: 'fn-1' });
      expect(orchestrator.update.mock.calls.map(([fn]) => fn.code)).toEqual(['broken', activeFunction().code]);
      expect(orchestrator.waitUntilReady).toHaveBeenCalledTimes(2);
      expect(functionsRepo.save).not.toHaveBeenCalled();
      expect(storage.uploadCode).not.toHaveBeenCalled();
      expect(orchestrator.scale).not.toHaveBeenCalled();
    });

    it('marks the function ERROR with both messages when the rollback fails too, and releases its pod', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.waitUntilReady
        .mockRejectedValueOnce(notReady())
        .mockRejectedValueOnce(new OrchestratorError('no pods were created: exceeded quota'));

      const failure = service.update('user-1', 'fn-1', { code: 'broken' });

      // The update's own failure as it is; the rollback's, a platform failure, generic (D4).
      await expect(failure).rejects.toBeInstanceOf(InternalServerErrorException);
      await expect(failure).rejects.toThrow(
        /^The update failed: The function failed to load: Error: boom at init\. Rolling back to the previous version failed because of an internal error \(request [0-9a-f-]{36}\)\.$/,
      );
      expect(((await failure.catch((error: unknown) => error)) as HttpException).getResponse()).toMatchObject({ statusCode: 500, functionId: 'fn-1' });
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('no pods were created: exceeded quota'), expect.anything());
      expect(functionsRepo.save).toHaveBeenCalledTimes(1);
      expect(functionsRepo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: FunctionStatus.ERROR, code: activeFunction().code }),
      );
      expect(orchestrator.scale).toHaveBeenCalledWith(expect.anything(), 0);
      expect(storage.uploadCode).not.toHaveBeenCalled();
    });

    it('keeps a failed attempt on a function in ERROR: no version to go back to, so the record shows what failed and why', async () => {
      functionsRepo.findOne.mockResolvedValue(errored());
      orchestrator.waitUntilReady.mockRejectedValueOnce(notReady());

      const failure = (await service.update('user-1', 'fn-1', { code: 'still broken' }).catch((error: unknown) => error)) as HttpException;

      expect([failure.message, failure.getResponse()]).toEqual([expect.stringContaining('boom at init'), expect.objectContaining({ functionId: 'fn-1' })]);

      expect(orchestrator.update).toHaveBeenCalledTimes(1); // no rollback
      expect(functionsRepo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ code: 'still broken', status: FunctionStatus.ERROR, error: expect.stringContaining('boom at init') }),
      );
      expect(orchestrator.scale).toHaveBeenCalledWith(expect.objectContaining({ code: 'still broken' }), 0);
      expect(storage.uploadCode).toHaveBeenCalledWith('fn-1/code.ts', 'still broken');
    });

    it('saves a successful update even when its code cannot be archived (the copy is not read yet)', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      storage.uploadCode.mockRejectedValue(new Error('storage unavailable'));

      const result = await service.update('user-1', 'fn-1', { code: 'v2' });

      expect(result).toMatchObject({ code: 'v2', status: FunctionStatus.ACTIVE });
      expect(functionsRepo.save).toHaveBeenCalledTimes(1);
    });
  });

  it('answers a failed removal as a platform failure, keeping the details in the log', async () => {
    functionsRepo.findOne.mockResolvedValue(activeFunction());
    orchestrator.remove.mockRejectedValue(new Error('namespaces "ff-t-6b86b273ff34" is forbidden'));

    await expect(service.remove('user-1', 'fn-1')).rejects.toThrow(internal('Deleting the function'));
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('ff-t-6b86b273ff34'), expect.anything());
    expect(functionsRepo.remove).not.toHaveBeenCalled();
  });

  it('remove deletes scheduler resources, stored code, and the record', async () => {
    const fn = activeFunction();
    functionsRepo.findOne.mockResolvedValue(fn);

    await service.remove('user-1', 'fn-1');

    expect(orchestrator.remove).toHaveBeenCalledWith(fn);
    expect(storage.deleteCode).toHaveBeenCalledWith('fn-1/code.ts');
    expect(functionsRepo.remove).toHaveBeenCalledWith(fn);
  });

  it("remove revokes the function's key to its account's buckets before its record goes; a failed removal keeps it", async () => {
    functionsRepo.findOne.mockResolvedValue(activeFunction());
    const order: string[] = [];
    functionKeys.revoke.mockImplementation(async () => order.push('revoke'));
    functionsRepo.remove.mockImplementation(async () => order.push('record'));

    await service.remove('user-1', 'fn-1');

    expect(functionKeys.revoke).toHaveBeenCalledWith('fn-1');
    expect(order).toEqual(['revoke', 'record']);

    functionKeys.revoke.mockClear();
    orchestrator.remove.mockRejectedValue(new Error('the API server is down'));
    await expect(service.remove('user-1', 'fn-1')).rejects.toThrow(internal('Deleting the function'));
    expect(functionKeys.revoke).not.toHaveBeenCalled();
  });

  describe('invoke', () => {
    it("refuses an input over 6 MB as JSON with 413, as AWS Lambda does, before reading the function or the credit", async () => {
      const input = { data: 'x'.repeat(6 * 1024 * 1024) };

      const refusal = (await service.invoke('user-1', 'fn-1', input).catch((error: unknown) => error)) as PayloadTooLargeException;

      expect(refusal).toBeInstanceOf(PayloadTooLargeException);
      expect(refusal.getResponse()).toEqual({
        statusCode: 413,
        error: 'RequestEntityTooLargeException',
        message: 'Request must be smaller than 6291456 bytes for the InvokeFunction operation: the input is 6291467 bytes as JSON',
      });
      expect([functionsRepo.findOne.mock.calls.length, credit.admit.mock.calls.length, orchestrator.invoke.mock.calls.length]).toEqual([0, 0, 0]);
    });

    it('takes an input of 6 MB exactly', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.invoke.mockResolvedValue({ output: 1, durationMs: 1, memoryUsedMb: 1 });
      const input = 'x'.repeat(6 * 1024 * 1024 - 2); // with its quotes, 6 MB of JSON

      await expect(service.invoke('user-1', 'fn-1', input)).resolves.toMatchObject({ input });
    });

    it("refuses with 402 when the account's credit has run out (P-33), before anything is recorded or run", async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      const refusal = new InsufficientCreditException(
        { currency: 'TND', exponent: 3, balanceMinor: -2345n, belowBufferSince: new Date('2026-10-17T10:33:00Z') },
        { bufferMinor: 1000n, graceMs: 24 * 3_600_000, shadow: false },
        { state: 'stopped', invokesStopAt: new Date('2026-10-18T10:33:00Z') },
      );
      credit.admit.mockRejectedValueOnce(refusal);

      await expect(service.invoke('user-1', 'fn-1', {})).rejects.toBe(refusal);

      expect(credit.admit).toHaveBeenCalledWith('user-1');
      expect([invocationsRepo.insert.mock.calls.length, orchestrator.invoke.mock.calls.length, usage.record.mock.calls.length]).toEqual([0, 0, 0]);
      expect(refusal.getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
    });

    it("records a call through the API as such, under a new request's ID, its first and only attempt, inserted at once", async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.invoke.mockResolvedValue({ output: 1, durationMs: 1, memoryUsedMb: 1 });

      await service.invoke('user-1', 'fn-1', {});

      expect(invocationsRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ source: InvocationSource.API, attempt: 1 }));
      expect(created().id).toMatch(UUID);
      expect(created().requestId).toBe(created().id);
    });

    it("records an asynchronous call's retry as an invocation of its own, under the request's ID with its attempt, which the runtime and the record name", async () => {
      orchestrator.invoke.mockResolvedValue({ output: 'done', durationMs: 4 });

      const outcome = await service.call(activeFunction(), { n: 1 }, { source: InvocationSource.ASYNC, requestId: 'req-3', attempt: 2 });

      expect(outcome.invocation).toMatchObject({ requestId: 'req-3', attempt: 2, source: InvocationSource.ASYNC, status: InvocationStatus.COMPLETED });
      expect(outcome.invocation.id).toMatch(UUID);
      expect(orchestrator.invoke).toHaveBeenCalledWith(expect.objectContaining({ id: 'fn-1' }), { n: 1 }, 'req-3');
      expect(usage.record).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-3' }), ending);
    });

    it('records a call that came another way under the ID its caller chose, keeping what the caller says to keep', async () => {
      orchestrator.invoke.mockResolvedValue({ output: { statusCode: 204 }, durationMs: 3, memoryUsedMb: 10 });
      const inserted: unknown[] = [];
      invocationsRepo.insert.mockImplementation(async (row: object) => inserted.push({ ...row })); // as it was then
      const event = { version: '2.0', headers: { authorization: 'Bearer their-token' } };

      const outcome = await service.call(activeFunction(), event, {
        source: InvocationSource.URL,
        requestId: 'req-1',
        history: { version: '2.0', headers: { authorization: '***' } },
      });

      // Inserted at once: the ID is new, and needs no lookup first.
      expect(inserted).toEqual([
        expect.objectContaining({ id: 'req-1', source: InvocationSource.URL, input: { version: '2.0', headers: { authorization: '***' } }, status: InvocationStatus.RUNNING }),
      ]);
      expect(orchestrator.invoke).toHaveBeenCalledWith(expect.objectContaining({ id: 'fn-1' }), event, 'req-1');
      expect(outcome).toMatchObject({ ok: true, output: { statusCode: 204 }, invocation: { id: 'req-1', status: InvocationStatus.COMPLETED } });
      expect(usage.record).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-1' }), ending);
    });

    it('answers a failed call as an outcome, so that each way in answers it its own way', async () => {
      orchestrator.invoke.mockRejectedValue(new FunctionRuntimeError('TypeError', 'x is undefined', { durationMs: 2 }));

      const outcome = await service.call(activeFunction(), {}, { source: InvocationSource.URL, requestId: 'req-2' });

      expect(outcome).toMatchObject({ ok: false, visible: 'TypeError: x is undefined', invocation: { id: 'req-2', status: InvocationStatus.ERROR } });
    });

    it('hands the function its input as the event, any JSON value, as AWS Lambda takes a payload; {} without one', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.invoke.mockResolvedValue({ output: null, durationMs: 1, memoryUsedMb: 1 });

      for (const input of ['text', 42, [1, 'two'], null, false, { a: 1 }]) await service.invoke('user-1', 'fn-1', input);
      await service.invoke('user-1', 'fn-1');

      expect(orchestrator.invoke.mock.calls.map(([, payload]) => payload)).toEqual(['text', 42, [1, 'two'], null, false, { a: 1 }, {}]);
      expect(invocationsRepo.create.mock.calls.map(([row]) => row.input)).toEqual(['text', 42, [1, 'two'], null, false, { a: 1 }, {}]);
    });

    it('stores output, runtime-reported duration and memory on a COMPLETED invocation', async () => {
      const fn = activeFunction();
      functionsRepo.findOne.mockResolvedValue(fn);
      orchestrator.invoke.mockResolvedValue({ output: { hello: 'world' }, durationMs: 12.5, memoryUsedMb: 12 });

      const invocation = await service.invoke('user-1', 'fn-1', { a: 1 });

      expect(orchestrator.invoke).toHaveBeenCalledWith(fn, { a: 1 }, created().requestId);
      expect(invocation).toMatchObject({
        status: InvocationStatus.COMPLETED,
        output: { hello: 'world' },
        duration: 12.5,
        memoryUsed: 12,
      });
      expect(metrics.recordMetric).toHaveBeenCalledWith('fn-1', expect.any(Number), 12, false);
    });

    it('counts the call as in flight while the runtime runs it: the scaling signal', async () => {
      const fn = activeFunction();
      functionsRepo.findOne.mockResolvedValue(fn);
      orchestrator.invoke.mockImplementation(async () => {
        expect(metrics.invocationStarted).toHaveBeenCalledWith(fn);
        expect(metrics.invocationFinished).not.toHaveBeenCalled();
        return { output: 1 };
      });

      await service.invoke('user-1', 'fn-1', {});

      expect(metrics.invocationFinished).toHaveBeenCalledWith(fn);
    });

    it('counts a failed call as finished too', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.invoke.mockRejectedValue(new Error('connection refused'));

      await expect(service.invoke('user-1', 'fn-1', {})).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(metrics.invocationStarted).toHaveBeenCalledTimes(1);
      expect(metrics.invocationFinished).toHaveBeenCalledTimes(1);
    });

    it('falls back to the measured end-to-end duration when the runtime reports none', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.invoke.mockResolvedValue({ output: null });

      const invocation = await service.invoke('user-1', 'fn-1');

      expect(orchestrator.invoke).toHaveBeenCalledWith(expect.anything(), {}, created().requestId);
      expect(invocation.duration).toBeGreaterThanOrEqual(0);
    });

    it('records a TIMEOUT invocation for function timeouts', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.invoke.mockRejectedValue(new FunctionTimeoutError('Task timed out after 5.00 seconds'));

      await expect(service.invoke('user-1', 'fn-1', {})).rejects.toThrow('Sandbox.Timedout: Task timed out after 5.00 seconds');
      expect(invocationsRepo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: InvocationStatus.TIMEOUT, duration: expect.any(Number) }),
      );
      expect(metrics.recordMetric).toHaveBeenCalledWith('fn-1', expect.any(Number), 0, true);
    });

    it('records the runtime error type for function errors', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.invoke.mockRejectedValue(new FunctionRuntimeError('TypeError', 'bad input'));

      await expect(service.invoke('user-1', 'fn-1', {})).rejects.toBeInstanceOf(BadRequestException);
      expect(invocationsRepo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: InvocationStatus.ERROR, error: 'TypeError: bad input' }),
      );
    });

    it("answers a call that failed with the call: its ID, which finds its logs, how it ended, its duration and memory", async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.invoke
        .mockRejectedValueOnce(new FunctionRuntimeError('Error', 'boom', { durationMs: 12, memoryUsedMb: 61 }))
        .mockRejectedValueOnce(new FunctionTimeoutError('Task timed out after 5.00 seconds', { durationMs: 5003 }));

      const raised = (await service.invoke('user-1', 'fn-1', {}).catch((error: unknown) => error)) as HttpException;
      const timedOut = (await service.invoke('user-1', 'fn-1', {}).catch((error: unknown) => error)) as HttpException;

      expect([raised.getStatus(), raised.getResponse()]).toEqual([
        400,
        { statusCode: 400, error: 'Bad Request', message: 'Error: boom', invocation: { id: created(0).id, status: InvocationStatus.ERROR, duration: 12, memoryUsed: 61 } },
      ]);
      expect(timedOut.getResponse()).toMatchObject({ invocation: { id: created(1).id, status: InvocationStatus.TIMEOUT, duration: 5003, memoryUsed: null } });
    });

    it('records a platform failure as ERROR with a generic message, in the history too; the details go to the log (D4)', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.invoke.mockRejectedValue(new OrchestratorError('Invocation failed with HTTP 503: no endpoints available for service "fn-1" in ff-t-6b86b273ff34'));

      const failure = service.invoke('user-1', 'fn-1', {});

      await expect(failure).rejects.toBeInstanceOf(InternalServerErrorException);
      await expect(failure).rejects.toThrow(internal('The invocation'));
      expect(invocationsRepo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: InvocationStatus.ERROR, error: expect.stringMatching(internal('The invocation')) }),
      );
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('no endpoints available'), expect.anything());
    });

    it('logs why a platform failure happened even when the error has no message of its own (P-09)', async () => {
      // A refused connection to every address of a host name: an AggregateError with an empty message.
      const refused = (address: string) => Object.assign(new Error(`connect ECONNREFUSED ${address}`), { code: 'ECONNREFUSED' });
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.invoke.mockRejectedValue(new AggregateError([refused('::1:6550'), refused('127.0.0.1:6550')], ''));

      await expect(service.invoke('user-1', 'fn-1', {})).rejects.toThrow(internal('The invocation'));
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining('connect ECONNREFUSED ::1:6550; connect ECONNREFUSED 127.0.0.1:6550'),
        expect.anything(),
      );
    });

    it("answers 429 with Lambda's error name when no instance could take the call in time", async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.invoke.mockRejectedValue(new FunctionThrottledError('Rate exceeded: no instance was free within 5.00 seconds'));

      const failure = await service.invoke('user-1', 'fn-1', {}).catch((error: unknown) => error);

      expect(failure).toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
        message: 'TooManyRequestsException: Rate exceeded: no instance was free within 5.00 seconds',
      });
      // Not an ERROR: the function didn't run, and D7 doesn't bill it.
      expect(invocationsRepo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: InvocationStatus.THROTTLED,
          error: 'TooManyRequestsException: Rate exceeded: no instance was free within 5.00 seconds',
        }),
      );
    });

    it('rejects functions that are not ACTIVE without calling the orchestrator', async () => {
      functionsRepo.findOne.mockResolvedValue({ ...activeFunction(), status: FunctionStatus.CREATING });

      await expect(service.invoke('user-1', 'fn-1', {})).rejects.toBeInstanceOf(BadRequestException);
      expect(orchestrator.invoke).not.toHaveBeenCalled();
    });
  });

  describe('scaling configuration', () => {
    it('reports the limits, and that a function scales to zero exactly when minInstances is 0', () => {
      expect(service.scalingConfig(activeFunction())).toEqual({ minInstances: 0, maxInstances: 3, scaleToZero: true });
      expect(service.scalingConfig({ ...activeFunction(), minInstances: 1 }).scaleToZero).toBe(false);
    });

    it('saves new limits and brings the running instances within them at once', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.desiredInstances.mockResolvedValue(4);

      const config = await service.updateScalingConfig('user-1', 'fn-1', { maxInstances: 2 });

      expect(config).toEqual({ minInstances: 0, maxInstances: 2, scaleToZero: true });
      expect(functionsRepo.save).toHaveBeenCalledWith(expect.objectContaining({ maxInstances: 2 }));
      expect(orchestrator.scale).toHaveBeenCalledWith(expect.objectContaining({ id: 'fn-1' }), 2);
    });

    it('starts the instances a higher minInstances asks for, without a rollout', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.desiredInstances.mockResolvedValue(0);

      const config = await service.updateScalingConfig('user-1', 'fn-1', { minInstances: 2 });

      expect(config).toEqual({ minInstances: 2, maxInstances: 3, scaleToZero: false });
      expect(orchestrator.scale).toHaveBeenCalledWith(expect.anything(), 2);
      expect(orchestrator.update).not.toHaveBeenCalled();
    });

    it('leaves the instances alone when they are within the new limits', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.desiredInstances.mockResolvedValue(1);

      await service.updateScalingConfig('user-1', 'fn-1', { maxInstances: 5 });

      expect(orchestrator.scale).not.toHaveBeenCalled();
    });

    it('refuses a minInstances above maxInstances, counting the stored values', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction()); // maxInstances 3

      await expect(service.updateScalingConfig('user-1', 'fn-1', { minInstances: 4 })).rejects.toThrow(
        "minInstances (4) can't be more than maxInstances (3)",
      );
      expect(functionsRepo.save).not.toHaveBeenCalled();
    });

    it('only saves the limits of a function that is not ACTIVE: its next rollout applies them', async () => {
      functionsRepo.findOne.mockResolvedValue({ ...activeFunction(), status: FunctionStatus.ERROR });

      await service.updateScalingConfig('user-1', 'fn-1', { minInstances: 1 });

      expect(functionsRepo.save).toHaveBeenCalled();
      expect(orchestrator.desiredInstances).not.toHaveBeenCalled();
      expect(orchestrator.scale).not.toHaveBeenCalled();
    });

    it('keeps the saved limits when the cluster cannot be reached', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.desiredInstances.mockRejectedValue(new Error('api down'));

      await expect(service.updateScalingConfig('user-1', 'fn-1', { maxInstances: 2 })).resolves.toMatchObject({ maxInstances: 2 });
      expect(functionsRepo.save).toHaveBeenCalled();
    });
  });

  describe("the account's plan (P-15, D5)", () => {
    const dto = { name: 'hello', runtime: Runtime.NODEJS, code: 'x', memory: 128, timeout: 5 };
    const nothingHappened = () => {
      expect(functionsRepo.save).not.toHaveBeenCalled();
      expect(orchestrator.deploy).not.toHaveBeenCalled();
      expect(orchestrator.update).not.toHaveBeenCalled();
      expect(orchestrator.scale).not.toHaveBeenCalled();
    };

    it('refuses a function larger than the plan allows, naming its limits, before saving anything', async () => {
      const failure = await service.create('user-1', { ...dto, memory: 2048, timeout: 600 }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(BadRequestException);
      expect((failure as BadRequestException).getResponse()).toMatchObject({
        message: ['memory must be at most 1024 MB on the Beta plan', 'timeout must be at most 300 s on the Beta plan'],
      });
      nothingHappened();
    });

    it("lets another plan's larger limits through: they are the plan's, not the code's", async () => {
      accountPlan = plan({ memoryMb: 2048, timeoutSeconds: 900 }, 'pro', 'Pro');

      await expect(service.create('user-1', { ...dto, memory: 2048, timeout: 900 })).resolves.toMatchObject({ status: FunctionStatus.ACTIVE });
    });

    it("refuses a function beyond the plan's number, counted while the account is locked", async () => {
      existingFunctions = 25;

      await expect(service.create('user-1', dto)).rejects.toThrow(
        new BadRequestException('The Beta plan allows 25 functions per account: delete one first'),
      );
      expect(transaction.query).toHaveBeenCalledWith('SELECT 1 FROM "accounts" WHERE "id" = $1 FOR NO KEY UPDATE', ['user-1']);
      expect(transaction.countBy).toHaveBeenCalledWith(Function, { accountId: 'user-1' });
      expect(transaction.query.mock.invocationCallOrder[0]).toBeLessThan(transaction.countBy.mock.invocationCallOrder[0]);
      nothingHappened();
    });

    it('says "1 function" for a plan that allows one', async () => {
      accountPlan = plan({ functions: 1 }, 'solo', 'Solo');
      existingFunctions = 1;

      await expect(service.create('user-1', dto)).rejects.toThrow('The Solo plan allows 1 function per account: delete one first');
    });

    it("saves the plan's last function in the same transaction as the count", async () => {
      existingFunctions = 24;

      await service.create('user-1', dto);

      expect(transaction.save).toHaveBeenCalledWith(Function, expect.objectContaining({ accountId: 'user-1' }));
      expect(savedStatuses[0]).toBe(FunctionStatus.CREATING); // saved by the transaction, before the deploy
      expect(orchestrator.deploy).toHaveBeenCalled();
    });

    it('refuses an update above the plan, and rolls nothing out', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());

      const failure = await service.update('user-1', 'fn-1', { memory: 4096 }).catch((error: unknown) => error);

      expect((failure as BadRequestException).getResponse()).toMatchObject({ message: ['memory must be at most 1024 MB on the Beta plan'] });
      nothingHappened();
    });

    it('keeps what an older, larger plan gave a function: only the values that change are checked', async () => {
      functionsRepo.findOne.mockResolvedValue({ ...activeFunction(), memory: 2048, maxInstances: 20 });

      await expect(service.update('user-1', 'fn-1', { code: 'v2', memory: 2048 })).resolves.toMatchObject({ code: 'v2', memory: 2048 });
      await expect(service.updateScalingConfig('user-1', 'fn-1', { minInstances: 1 })).resolves.toMatchObject({ maxInstances: 20 });
    });

    it('refuses instance limits above the plan, naming its limit', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());

      const failure = await service.updateScalingConfig('user-1', 'fn-1', { minInstances: 11, maxInstances: 12 }).catch((e: unknown) => e);

      expect((failure as BadRequestException).getResponse()).toMatchObject({
        message: ['minInstances must be at most 10 on the Beta plan', 'maxInstances must be at most 10 on the Beta plan'],
      });
      nothingHappened();
    });

    it("rolls a failed update back within the same plan's quota", async () => {
      accountPlan = plan({ quota: { pods: 7, cpu: '2', memory: '3Gi' } });
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.waitUntilReady.mockRejectedValueOnce(new FunctionLoadError('Error', 'boom'));

      await service.update('user-1', 'fn-1', { code: 'broken' }).catch(() => undefined);

      expect(orchestrator.update.mock.calls.map(([, tenant]) => tenant)).toEqual([
        { quota: { pods: 7, cpu: '2', memory: '3Gi' }, internetEgress: false },
        { quota: { pods: 7, cpu: '2', memory: '3Gi' }, internetEgress: false },
      ]);
    });

    // The operator's change of plan or internet egress takes the account for update while it applies its own: a
    // write that read the old value under the lock can't put it back after.
    it("writes the account's namespace only with the limits read under the account's lock: deploy, update and rollback", async () => {
      const writes: Array<[string, boolean]> = [];
      orchestrator.deploy.mockImplementation(async () => void writes.push(['deploy', underLock]));
      orchestrator.update.mockImplementation(async () => void writes.push(['update', underLock]));
      await service.create('user-1', { name: 'hello', runtime: Runtime.NODEJS, code: 'x', memory: 128, timeout: 5 });
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.waitUntilReady.mockRejectedValueOnce(new FunctionLoadError('Error', 'boom'));

      await service.update('user-1', 'fn-1', { code: 'broken' }).catch(() => undefined);

      expect(writes).toEqual([['deploy', true], ['update', true], ['update', true]]);
      expect(plans.withTenant.mock.calls.map(([accountId]) => accountId)).toEqual(['user-1', 'user-1', 'user-1']);
    });
  });

  describe('usage records (P-20, D6, D7)', () => {
    const record = () => usage.record.mock.calls[0][0];

    it("sends the invocation's ID to the runtime, and writes its usage record, with the function's memory and minInstances, in the transaction that ends it", async () => {
      functionsRepo.findOne.mockResolvedValue({ ...activeFunction(), memory: 256, minInstances: 1 });
      orchestrator.invoke.mockResolvedValue({ output: 1, durationMs: 1.09, memoryUsedMb: 50 });

      await service.invoke('user-1', 'fn-1', { name: 'x' });

      expect(orchestrator.invoke).toHaveBeenCalledWith(expect.objectContaining({ id: 'fn-1' }), { name: 'x' }, created().requestId);
      expect(usage.record).toHaveBeenCalledWith(
        {
          requestId: created().requestId,
          startedAt: new Date('2026-10-17T10:00:00Z'),
          endedAt: new Date('2026-10-17T10:00:02Z'),
          accountId: 'user-1',
          functionId: 'fn-1',
          functionName: 'hello',
          runtime: 'nodejs',
          memoryMb: 256,
          minInstances: 1,
          durationMs: '1.090',
          billedMs: 2,
          initMs: null,
          status: 'success',
        },
        ending,
      );
      expect(ending.save.mock.invocationCallOrder[0]).toBeLessThan(usage.record.mock.invocationCallOrder[0]);
    });

    it("records a function's error with the runtime's duration and memory, which its answer's headers carried", async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.invoke.mockRejectedValue(new FunctionRuntimeError('Error', 'boom', { durationMs: 12.3, memoryUsedMb: 61 }));

      await service.invoke('user-1', 'fn-1', {}).catch(() => undefined);

      expect(invocationsRepo.save).toHaveBeenLastCalledWith(expect.objectContaining({ status: InvocationStatus.ERROR, duration: 12.3, memoryUsed: 61 }));
      expect(record()).toMatchObject({ status: 'error', durationMs: '12.300', billedMs: 13 });
    });

    it.each([
      ['a timeout bills the function\'s timeout', new FunctionTimeoutError('Task timed out after 5.00 seconds', { durationMs: 5003 }), 'timeout', 5000],
      ['a throttled call bills nothing', new FunctionThrottledError('Rate exceeded'), 'throttled', 0],
      ['a platform failure bills nothing', new OrchestratorError('pod unreachable'), 'platform_error', 0],
      ['a cold start that failed to load bills nothing', new FunctionLoadError('Runtime.ImportModuleError', 'nope'), 'platform_error', 0],
    ])('%s', async (_case, error, status, billed) => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.invoke.mockRejectedValue(error);

      await service.invoke('user-1', 'fn-1', {}).catch(() => undefined);

      expect(record()).toMatchObject({ status, billedMs: billed });
    });

    it('records the cold start, apart from the billed duration (D7)', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.invoke.mockResolvedValue({ output: 1, durationMs: 3.2, initMs: 7400 });

      await service.invoke('user-1', 'fn-1', {});

      expect(record()).toMatchObject({ initMs: 7400, billedMs: 4 });
    });

    it('records the cold start before a failed call, and bills nothing for it', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.invoke.mockRejectedValue(withInitMs(new OrchestratorError('no instance became ready'), 90000));

      await service.invoke('user-1', 'fn-1', {}).catch(() => undefined);

      expect(record()).toMatchObject({ status: 'platform_error', initMs: 90000, billedMs: 0 });
    });

    it("times a call itself when the runtime didn't, leaving the cold start out (D7)", async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      // 7 s from sending the call to its answer, of which 5 s waited for an instance to start.
      jest.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(8_000).mockReturnValueOnce(20_000).mockReturnValueOnce(27_000);
      orchestrator.invoke.mockResolvedValueOnce({ output: 1, initMs: 5_000 });
      orchestrator.invoke.mockRejectedValueOnce(withInitMs(new OrchestratorError('connection reset'), 5_000));

      const invocation = await service.invoke('user-1', 'fn-1', {});
      await service.invoke('user-1', 'fn-1', {}).catch(() => undefined);

      expect(invocation.duration).toBe(2_000);
      expect(usage.record.mock.calls.map(([written]) => [written.status, written.durationMs, written.billedMs, written.initMs])).toEqual([
        ['success', '2000.000', 2_000, 5_000],
        ['platform_error', '2000.000', 0, 5_000],
      ]);
    });

    it('locks the invocation before ending it, as the reaper does', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.invoke.mockResolvedValue({ output: 1, durationMs: 1 });

      await service.invoke('user-1', 'fn-1', {});

      expect(ending.findOne).toHaveBeenCalledWith(FunctionInvocation, { where: { id: created().id }, lock: { mode: 'pessimistic_write' } });
      expect(ending.findOne.mock.invocationCallOrder[0]).toBeLessThan(ending.save.mock.invocationCallOrder[0]);
    });

    it('leaves a call the reaper already marked LOST as it is: its record says so, and the caller still gets the answer', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.invoke.mockResolvedValue({ output: 'late', durationMs: 1 });
      ending.findOne.mockResolvedValue({ status: InvocationStatus.LOST });

      const invocation = await service.invoke('user-1', 'fn-1', {});

      expect(invocation.output).toBe('late');
      expect(ending.save).not.toHaveBeenCalled();
      expect(usage.record).not.toHaveBeenCalled();
    });

    it('bills a call whose function was deleted while it ran: the history went with the function, the record stays', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.invoke.mockResolvedValue({ output: 1, durationMs: 30.5 });
      ending.findOne.mockResolvedValue(null);

      await service.invoke('user-1', 'fn-1', {});

      expect(ending.save).not.toHaveBeenCalled();
      expect(record()).toMatchObject({ requestId: created().requestId, status: 'success', billedMs: 31, endedAt: expect.any(Date) });
    });
  });

  describe("a function's environment variables", () => {
    const dto = { name: 'hello', runtime: Runtime.NODEJS, code: 'x', memory: 128, timeout: 5 };
    const notReady = () => new FunctionLoadError('Error', 'boom at init');
    /** The environment the orchestrator was given at each deploy or update, in order. */
    const given = () => [...orchestrator.deploy.mock.calls, ...orchestrator.update.mock.calls].map(([fn]) => fn.environment);
    const stored = (variables: Record<string, string>, revision = 'r0') =>
      environments.saved.set('fn-1', { revision, variables, secrets: {} });

    it('saves them with the new function, deploys them with a revision, and answers with them', async () => {
      const result = await service.create('user-1', { ...dto, environment: { TABLE: 'orders', LOG_LEVEL: 'debug' } });

      const saved = environments.saved.get('fn-1')!;
      expect(saved).toEqual({ revision: expect.stringMatching(/^[0-9a-f]{16}$/), variables: { TABLE: 'orders', LOG_LEVEL: 'debug' }, secrets: {} });
      expect(given()).toEqual([{ revision: saved.revision, values: { TABLE: 'orders', LOG_LEVEL: 'debug' } }]);
      expect(result.environment).toEqual({ TABLE: 'orders', LOG_LEVEL: 'debug' });
    });

    it('gives a function without any no environment at all', async () => {
      const result = await service.create('user-1', { ...dto, environment: {} });

      expect(environments.saved.size).toBe(0);
      expect(given()).toEqual([undefined]);
      expect(result.environment).toEqual({});
    });

    it('answers GET with the variables', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      stored({ TABLE: 'orders' });

      expect((await service.describe('user-1', 'fn-1')).environment).toEqual({ TABLE: 'orders' });
    });

    it('rolls out new variables with a new revision, all of them replaced, and saves them once they are live', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      stored({ TABLE: 'orders', OLD: 'x' });

      const result = await service.update('user-1', 'fn-1', { environment: { TABLE: 'invoices' } });

      const [rolledOut] = given();
      expect(rolledOut).toEqual({ revision: expect.stringMatching(/^[0-9a-f]{16}$/), values: { TABLE: 'invoices' } });
      expect(rolledOut!.revision).not.toBe('r0');
      expect(environments.saved.get('fn-1')).toEqual({ revision: rolledOut!.revision, variables: { TABLE: 'invoices' }, secrets: {} });
      expect(result.environment).toEqual({ TABLE: 'invoices' });
    });

    it('keeps the revision when the code changes and the variables do not, so their Secret stays where it is', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      stored({ TABLE: 'orders' });

      await service.update('user-1', 'fn-1', { code: 'v2', environment: { TABLE: 'orders' } });

      expect(given()).toEqual([{ revision: 'r0', values: { TABLE: 'orders' } }]);
    });

    it('rolls nothing out when the same variables are sent again', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      stored({ TABLE: 'orders' });

      await service.update('user-1', 'fn-1', { environment: { TABLE: 'orders' } });

      expect(orchestrator.update).not.toHaveBeenCalled();
      expect(environments.saved.get('fn-1')!.revision).toBe('r0');
    });

    it('removes them all with an empty map: a version without any, and no row left', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      stored({ TABLE: 'orders' });

      await service.update('user-1', 'fn-1', { environment: {} });

      expect(given()).toEqual([undefined]);
      expect(environments.saved.has('fn-1')).toBe(false);
    });

    it('rolls a failed change back with the previous variables, and saves nothing', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      stored({ TABLE: 'orders' });
      orchestrator.waitUntilReady.mockRejectedValueOnce(notReady());

      await expect(service.update('user-1', 'fn-1', { environment: { TABLE: 'broken' } })).rejects.toBeInstanceOf(BadRequestException);

      expect(given().map((environment) => environment?.values)).toEqual([{ TABLE: 'broken' }, { TABLE: 'orders' }]);
      expect(given()[1]!.revision).toBe('r0');
      expect(environments.saved.get('fn-1')).toEqual({ revision: 'r0', variables: { TABLE: 'orders' }, secrets: {} });
    });

    it('keeps the variables of a failed repair with the attempt: the Deployment holds them', async () => {
      functionsRepo.findOne.mockResolvedValue({ ...activeFunction(), status: FunctionStatus.ERROR, error: 'earlier' });
      stored({ TABLE: 'orders' });
      orchestrator.waitUntilReady.mockRejectedValueOnce(notReady());

      await expect(service.update('user-1', 'fn-1', { environment: { TABLE: 'retry' } })).rejects.toBeInstanceOf(BadRequestException);

      expect(environments.saved.get('fn-1')!.variables).toEqual({ TABLE: 'retry' });
    });

    it('names the variables in the audit log, never their values', async () => {
      await service.create('user-1', { ...dto, environment: { TABLE: 'orders', API_TOKEN: 'tok-123' } });
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      stored({ TABLE: 'orders', API_TOKEN: 'tok-123', OLD: 'gone' });

      await service.update('user-1', 'fn-1', { environment: { TABLE: 'orders', API_TOKEN: 'tok-456', NEW: 'v' } });

      const [created, updated] = audit.record.mock.calls.map(([event]) => event);
      expect(created.details).toEqual({
        name: 'hello',
        runtime: 'nodejs',
        handler: 'function.handler',
        codeSha256: inlineCodeFacts('x').codeSha256,
        memory: 128,
        timeout: 5,
        environment: ['API_TOKEN', 'TABLE'],
      });
      expect(updated.details).toEqual({ changed: ['environment'], environment: { added: ['NEW'], changed: ['API_TOKEN'], removed: ['OLD'] }, outcome: 'live' });
      expect(JSON.stringify(audit.record.mock.calls)).not.toMatch(/tok-123|tok-456|orders/);
    });
  });

  describe("a function's secrets", () => {
    const dto = { name: 'hello', runtime: Runtime.NODEJS, code: 'x', memory: 128, timeout: 5 };
    const notReady = () => new FunctionLoadError('Error', 'boom at init');
    const given = () => [...orchestrator.deploy.mock.calls, ...orchestrator.update.mock.calls].map(([fn]) => fn.environment);
    const set = '2026-10-20T08:00:00.000Z';
    /** Why a call was refused with 400: its messages. */
    const refused = async (call: Promise<unknown>) => {
      const failure = await call.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(BadRequestException);
      return ((failure as BadRequestException).getResponse() as { message: string[] }).message;
    };
    const tooLarge = (bytes: number) =>
      `The environment is ${bytes} bytes as JSON text: AWS Lambda allows 4096 (4 KB) for a function's variables and secrets together`;
    const stored = (secrets: Record<string, string>, variables: Record<string, string> = {}) =>
      environments.saved.set('fn-1', {
        revision: 'r0',
        variables,
        secrets: Object.fromEntries(Object.entries(secrets).map(([name, value]) => [name, { value, updatedAt: set }])),
      });

    it('are saved with the new function and given to it with its variables, and its answer holds none of them', async () => {
      const result = await service.create('user-1', { ...dto, environment: { DB_USER: 'ff' }, secrets: { DB_PASSWORD: 'hunter2' } });

      expect(environments.saved.get('fn-1')!.secrets).toEqual({ DB_PASSWORD: { value: 'hunter2', updatedAt: expect.any(String) } });
      expect(given()).toEqual([{ revision: expect.any(String), values: { DB_USER: 'ff', DB_PASSWORD: 'hunter2' } }]);
      expect(result.environment).toEqual({ DB_USER: 'ff' });
      expect(JSON.stringify(result)).not.toContain('hunter2');
      expect(audit.record.mock.calls[0][0].details).toMatchObject({ environment: ['DB_USER'], secrets: ['DB_PASSWORD'] });
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain('hunter2');
    });

    it('refuse a name that is a variable too, or 4 KB with the variables, before anything is saved or deployed', async () => {
      expect(await refused(service.create('user-1', { ...dto, environment: { TOKEN: 'a' }, secrets: { TOKEN: 'b' } }))).toEqual([
        'TOKEN is both a variable and a secret: a name is one or the other',
      ]);
      // {"BIG":"…","MORE":"…"}: 20 bytes around the values.
      expect(await refused(service.create('user-1', { ...dto, environment: { BIG: 'x'.repeat(3000) }, secrets: { MORE: 'y'.repeat(1100) } }))).toEqual([
        tooLarge(4120),
      ]);
      expect(functionsRepo.save).not.toHaveBeenCalled();
      expect(orchestrator.deploy).not.toHaveBeenCalled();
    });

    it("keep variables from taking a secret's name, or the 4 KB, in an update, which then rolls nothing out", async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      stored({ DB_PASSWORD: 'hunter2' });

      expect(await refused(service.update('user-1', 'fn-1', { environment: { DB_PASSWORD: 'x' } }))).toEqual([
        'DB_PASSWORD is both a variable and a secret: a name is one or the other',
      ]);
      expect(orchestrator.update).not.toHaveBeenCalled();
    });

    it('are listed by name and date, never by value', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      stored({ DB_PASSWORD: 'hunter2', API_TOKEN: 'tok' });

      const listed = await service.listSecrets('user-1', 'fn-1');

      expect(listed).toEqual({ secrets: [{ name: 'API_TOKEN', updatedAt: set }, { name: 'DB_PASSWORD', updatedAt: set }] });
    });

    it("of another account's function are not found, as the function isn't", async () => {
      functionsRepo.findOne.mockResolvedValue(null);

      await expect(service.listSecrets('user-2', 'fn-1')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.updateSecrets('user-2', 'fn-1', { X_SECRET: 'v' })).rejects.toBeInstanceOf(NotFoundException);
      expect(orchestrator.update).not.toHaveBeenCalled();
    });

    it('set and removed by name roll out a new version with them, then are saved, and the answer names them', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      stored({ DB_PASSWORD: 'hunter2', OLD_TOKEN: 'old' }, { DB_USER: 'ff' });

      const result = await service.updateSecrets('user-1', 'fn-1', { DB_PASSWORD: 'correct-horse', OLD_TOKEN: null, API_KEY: 'k' });

      const [rolledOut] = given();
      expect(rolledOut).toEqual({ revision: expect.stringMatching(/^[0-9a-f]{16}$/), values: { DB_USER: 'ff', DB_PASSWORD: 'correct-horse', API_KEY: 'k' } });
      expect(rolledOut!.revision).not.toBe('r0');
      expect(environments.saved.get('fn-1')).toMatchObject({ revision: rolledOut!.revision, variables: { DB_USER: 'ff' } });
      expect(result.secrets.map((secret) => secret.name)).toEqual(['API_KEY', 'DB_PASSWORD']);
      expect(JSON.stringify(result)).not.toMatch(/correct-horse|"k"/);
    });

    it('names the secrets added, changed and removed in the audit log, never their values', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      stored({ DB_PASSWORD: 'hunter2', OLD_TOKEN: 'old' });

      await service.updateSecrets('user-1', 'fn-1', { DB_PASSWORD: 'correct-horse', OLD_TOKEN: null, API_KEY: 'k' });

      expect(audit.record).toHaveBeenCalledWith({
        accountId: 'user-1',
        action: 'function.update',
        resource: 'function:fn-1',
        details: { changed: ['secrets'], secrets: { added: ['API_KEY'], changed: ['DB_PASSWORD'], removed: ['OLD_TOKEN'] }, outcome: 'live' },
      });
      expect(JSON.stringify(audit.record.mock.calls)).not.toMatch(/hunter2|correct-horse/);
    });

    it('roll nothing out for a value already set, or a name already gone', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      stored({ DB_PASSWORD: 'hunter2' });

      const result = await service.updateSecrets('user-1', 'fn-1', { DB_PASSWORD: 'hunter2', NEVER_SET: null });

      expect(orchestrator.update).not.toHaveBeenCalled();
      expect(result).toEqual({ secrets: [{ name: 'DB_PASSWORD', updatedAt: set }] });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('roll the function back to the previous secrets when the new version fails, and save nothing', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      stored({ DB_PASSWORD: 'hunter2' });
      orchestrator.waitUntilReady.mockRejectedValueOnce(notReady());

      await expect(service.updateSecrets('user-1', 'fn-1', { DB_PASSWORD: 'broken' })).rejects.toBeInstanceOf(BadRequestException);

      expect(given().map((environment) => environment?.values)).toEqual([{ DB_PASSWORD: 'broken' }, { DB_PASSWORD: 'hunter2' }]);
      expect(environments.saved.get('fn-1')!.secrets.DB_PASSWORD.value).toBe('hunter2');
    });

    it('refuse more than 4 KB with the variables, and roll nothing out', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      stored({}, { BIG: 'x'.repeat(4000) });

      // {"BIG":"…","MORE":"…"}: 20 bytes around the values.
      expect(await refused(service.updateSecrets('user-1', 'fn-1', { MORE: 'y'.repeat(100) }))).toEqual([tooLarge(4120)]);
      expect(orchestrator.update).not.toHaveBeenCalled();
    });

    it('can repair a function in ERROR: one that failed to load without its secret becomes ACTIVE with it', async () => {
      functionsRepo.findOne.mockResolvedValue({ ...activeFunction(), status: FunctionStatus.ERROR, error: 'missing DB_PASSWORD' });

      await service.updateSecrets('user-1', 'fn-1', { DB_PASSWORD: 'hunter2' });

      expect(functionsRepo.save).toHaveBeenLastCalledWith(expect.objectContaining({ status: FunctionStatus.ACTIVE, error: null }));
      expect(environments.saved.get('fn-1')!.secrets.DB_PASSWORD.value).toBe('hunter2');
    });
  });

  describe("a function's key to its account's buckets", () => {
    const dto = { name: 'hello', runtime: Runtime.NODEJS, code: 'x', memory: 128, timeout: 5 };
    const KEY = 'AKFF7Q2MLKX4RTZB3W5N';
    const credentials = {
      revision: KEY,
      variables: {
        AWS_ACCESS_KEY_ID: KEY,
        AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        AWS_REGION: 'tn-tunis-1',
        AWS_DEFAULT_REGION: 'tn-tunis-1',
        AWS_ENDPOINT_URL_S3: 'http://10.43.0.251:3002',
        AWS_ENDPOINT_URL_SQS: 'http://10.43.0.251:3003',
      },
    };
    const given = () => [...orchestrator.deploy.mock.calls, ...orchestrator.update.mock.calls].map(([fn]) => fn.environment);

    it('reaches its pods with their variables and secrets, under the names AWS\'s SDKs read, and never its answer', async () => {
      functionKeys.credentialsFor.mockResolvedValue(credentials);

      const result = await service.create('user-1', { ...dto, environment: { TABLE: 'orders' }, secrets: { DB_PASSWORD: 'hunter2' } });

      expect(functionKeys.credentialsFor).toHaveBeenCalledWith(expect.objectContaining({ id: 'fn-1', accountId: 'user-1' }));
      const [environment] = given();
      expect(environment).toEqual({ revision: expect.stringMatching(new RegExp(`^[0-9a-f]{16}\\.${KEY}$`)), values: { TABLE: 'orders', DB_PASSWORD: 'hunter2', ...credentials.variables } });
      expect(JSON.stringify(result)).not.toContain(credentials.variables.AWS_SECRET_ACCESS_KEY);
      expect(environments.saved.get('fn-1')!.variables).toEqual({ TABLE: 'orders' });
    });

    it('is given to a function without variables too, which then has an environment of its key alone', async () => {
      functionKeys.credentialsFor.mockResolvedValue(credentials);

      await service.create('user-1', dto);

      expect(given()).toEqual([{ revision: KEY, values: credentials.variables }]);
      expect(environments.saved.has('fn-1')).toBe(false);
    });

    it('takes every endpoint unless the function names fewer, kept in their order, and gives the key the ones it takes', async () => {
      functionKeys.credentialsFor.mockResolvedValue(credentials);

      await service.create('user-1', dto);
      await service.create('user-1', { ...dto, awsEndpoints: [AwsEndpoint.SESV2, AwsEndpoint.SQS] });

      expect(functionsRepo.save.mock.calls.map(([fn]) => (fn as Function).awsEndpoints)).toEqual([
        [AwsEndpoint.S3, AwsEndpoint.SQS, AwsEndpoint.SESV2],
        [AwsEndpoint.S3, AwsEndpoint.SQS, AwsEndpoint.SESV2],
        [AwsEndpoint.SQS, AwsEndpoint.SESV2],
        [AwsEndpoint.SQS, AwsEndpoint.SESV2],
      ]);
      expect(functionKeys.credentialsFor.mock.calls.map(([fn]) => fn.awsEndpoints)).toEqual([
        [AwsEndpoint.S3, AwsEndpoint.SQS, AwsEndpoint.SESV2],
        [AwsEndpoint.SQS, AwsEndpoint.SESV2],
      ]);
    });

    it('rolls out an update that leaves an endpoint out, its record saying so, and changes nothing for the same ones in another order', async () => {
      functionKeys.credentialsFor.mockResolvedValue(credentials);
      functionsRepo.findOne.mockImplementation(async () => activeFunction());

      const left = await service.update('user-1', 'fn-1', { awsEndpoints: [AwsEndpoint.SQS, AwsEndpoint.S3] });
      await service.update('user-1', 'fn-1', { awsEndpoints: [AwsEndpoint.SESV2, AwsEndpoint.SQS, AwsEndpoint.S3] });

      expect(left.awsEndpoints).toEqual([AwsEndpoint.S3, AwsEndpoint.SQS]);
      expect(orchestrator.update).toHaveBeenCalledTimes(1);
      expect(functionKeys.credentialsFor).toHaveBeenCalledWith(expect.objectContaining({ awsEndpoints: [AwsEndpoint.S3, AwsEndpoint.SQS] }));
      expect(audit.record.mock.calls.map(([event]) => event.details)).toEqual([
        { changed: ['awsEndpoints'], awsEndpoints: [AwsEndpoint.S3, AwsEndpoint.SQS], outcome: 'live' },
      ]);
    });

    it('goes with every rollout: an update, and the rollback of a failed one', async () => {
      functionKeys.credentialsFor.mockResolvedValue(credentials);
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.waitUntilReady.mockRejectedValueOnce(new FunctionLoadError('Error', 'boom at init'));

      await service.update('user-1', 'fn-1', { code: 'v2' }).catch(() => undefined);

      expect(orchestrator.update).toHaveBeenCalledTimes(2);
      expect(given()).toEqual([
        { revision: KEY, values: credentials.variables },
        { revision: KEY, values: credentials.variables },
      ]);
    });

    it('fails a create as a platform failure when it can\'t be made: the function is kept, ERROR, with nothing deployed', async () => {
      functionKeys.credentialsFor.mockRejectedValue(new Error('connection terminated'));

      await expect(service.create('user-1', dto)).rejects.toThrow(internal('Deploying the function'));
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('connection terminated'), expect.anything());
      expect(orchestrator.deploy).not.toHaveBeenCalled();
      expect(savedStatuses).toEqual([FunctionStatus.CREATING, FunctionStatus.ERROR]);
    });

    describe('workloadOf', () => {
      const fn = activeFunction();
      const environment = { revision: '0123456789abcdef', variables: { TABLE: 'orders' }, secrets: {} };

      it('gives nothing where FF gives functions no key, as before', () => {
        expect(workloadOf(fn, { revision: '', variables: {}, secrets: {} }, 'image').environment).toBeUndefined();
        expect(workloadOf(fn, environment, 'image').environment).toEqual({ revision: '0123456789abcdef', values: { TABLE: 'orders' } });
      });

      it("makes new credentials a new version, as a new environment is, and the same credentials and environment the same one", () => {
        const first = workloadOf(fn, environment, 'image', credentials).environment;
        const again = workloadOf(fn, environment, 'image', credentials).environment;
        const newKey = workloadOf(fn, environment, 'image', { ...credentials, revision: 'AKFFBBBBBBBBBBBBBBBB' }).environment;

        expect(first?.revision).toBe(`0123456789abcdef.${KEY}`);
        expect(again?.revision).toBe(first?.revision);
        expect(newKey?.revision).not.toBe(first?.revision);
      });

      it("keeps FF's names FF's, over a variable a function was given before they were reserved", () => {
        const before = { ...environment, variables: { AWS_ENDPOINT_URL_S3: 'https://s3.amazonaws.com', AWS_ENDPOINT_URL_SQS: 'https://sqs.us-east-1.amazonaws.com' } };

        expect(workloadOf(fn, before, 'image', credentials).environment?.values).toMatchObject({
          AWS_ENDPOINT_URL_S3: 'http://10.43.0.251:3002',
          AWS_ENDPOINT_URL_SQS: 'http://10.43.0.251:3003',
        });
      });
    });
  });

  describe('the audit log (P-17)', () => {
    const dto = { name: 'hello', runtime: Runtime.NODEJS, code: 'x', memory: 128, timeout: 5 };
    const recorded = () => audit.record.mock.calls.map(([event]) => event);

    it('records a new function in the transaction that saves it, so a deploy that fails later still says who created it', async () => {
      orchestrator.waitUntilReady.mockRejectedValue(new FunctionLoadError('Runtime.ImportModuleError', 'nope'));

      await service.create('user-1', dto).catch(() => undefined);

      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        {
          accountId: 'user-1',
          action: 'function.create',
          resource: 'function:fn-1',
          details: { name: 'hello', runtime: 'nodejs', handler: 'function.handler', codeSha256: inlineCodeFacts('x').codeSha256, memory: 128, timeout: 5 },
        },
        transaction,
      );
    });

    it("records the fields an update changed, with their new values, but the code's hash rather than the code", async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());

      await service.update('user-1', 'fn-1', { code: 'v2', memory: 256, timeout: 5 });

      expect(recorded()).toEqual([
        {
          accountId: 'user-1',
          action: 'function.update',
          resource: 'function:fn-1',
          details: { changed: ['code', 'memory'], memory: 256, codeSha256: inlineCodeFacts('v2').codeSha256, outcome: 'live' },
        },
      ]);
    });

    it('records a rename, which needs no rollout, and nothing for an update that changes nothing', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      await service.update('user-1', 'fn-1', { name: 'renamed' });
      await service.update('user-1', 'fn-1', { timeout: 5 });

      expect(recorded()).toEqual([
        { accountId: 'user-1', action: 'function.update', resource: 'function:fn-1', details: { changed: ['name'], name: 'renamed', outcome: 'saved' } },
      ]);
    });

    it('records a failed attempt that was kept, and nothing for one that was rolled back: nothing changed', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.waitUntilReady.mockRejectedValueOnce(new FunctionLoadError('Error', 'boom'));
      await service.update('user-1', 'fn-1', { code: 'broken' }).catch(() => undefined);
      expect(recorded()).toEqual([]);

      functionsRepo.findOne.mockResolvedValue({ ...activeFunction(), status: FunctionStatus.ERROR });
      orchestrator.waitUntilReady.mockRejectedValueOnce(new FunctionLoadError('Error', 'boom'));
      await service.update('user-1', 'fn-1', { code: 'still broken' }).catch(() => undefined);
      expect(recorded()).toEqual([
        expect.objectContaining({
          action: 'function.update',
          details: { changed: ['code'], codeSha256: inlineCodeFacts('still broken').codeSha256, outcome: 'failed, kept: ERROR' },
        }),
      ]);
    });

    it('records a deletion and a scaling change', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());

      await service.updateScalingConfig('user-1', 'fn-1', { maxInstances: 5 });
      await service.remove('user-1', 'fn-1');

      expect(recorded()).toEqual([
        { accountId: 'user-1', action: 'function.scaling', resource: 'function:fn-1', details: { minInstances: 0, maxInstances: 5 } },
        { accountId: 'user-1', action: 'function.delete', resource: 'function:fn-1', details: { name: 'hello' } },
      ]);
    });

    it('records nothing for a delete that failed', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.remove.mockRejectedValue(new Error('api down'));

      await service.remove('user-1', 'fn-1').catch(() => undefined);

      expect(recorded()).toEqual([]);
    });
  });

  describe('every method acts for one account (P-10, D4)', () => {
    const ID = '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f';
    // One function, of account user-1. The repositories filter as the database would.
    const owned = (): Function => ({ ...activeFunction(), id: ID });
    const matches = (row: object, where: object) =>
      Object.entries(where).every(([key, value]) => (row as Record<string, unknown>)[key] === value);

    beforeEach(() => {
      functionsRepo.findOne.mockImplementation(async ({ where }) => [owned()].find((row) => matches(row, where)) ?? null);
      functionsRepo.find.mockImplementation(async ({ where }) => [owned()].filter((row) => matches(row, where)));
      invocationsRepo.findAndCount.mockResolvedValue([[], 0]);
      orchestrator.invoke.mockResolvedValue({ output: 'hi' });
      orchestrator.desiredInstances.mockResolvedValue(1);
      orchestrator.logs.mockResolvedValue({ lines: [], next: null });
      orchestrator.tailLogs.mockReturnValue((async function* () {})());
    });

    const calls: Array<[string, (accountId: string, id?: string) => Promise<unknown>]> = [
      ['findOne', (accountId, id = ID) => service.findOne(accountId, id)],
      ['code', (accountId, id = ID) => service.code(accountId, id)],
      ['update', (accountId, id = ID) => service.update(accountId, id, { code: 'v2' })],
      ['remove', (accountId, id = ID) => service.remove(accountId, id)],
      ['invoke', (accountId, id = ID) => service.invoke(accountId, id, {})],
      ['getInvocations', (accountId, id = ID) => service.getInvocations(accountId, id, { limit: 10, offset: 0 })],
      ['updateScalingConfig', (accountId, id = ID) => service.updateScalingConfig(accountId, id, { maxInstances: 2 })],
      ['logs', (accountId, id = ID) => service.logs(accountId, id, { tail: 200 })],
      ['liveLogs', (accountId, id = ID) => service.liveLogs(accountId, id, {}, new AbortController().signal)],
    ];

    it.each(calls)("%s answers another account exactly as for a function that doesn't exist, and does nothing", async (_name, call) => {
      const otherAccount = await call('user-2').catch((error: unknown) => error);
      const missing = await call('user-1', '00000000-0000-4000-8000-000000000000').catch((error: unknown) => error);

      expect(otherAccount).toBeInstanceOf(NotFoundException);
      expect((otherAccount as Error).message).toBe(`Function with ID ${ID} not found`);
      expect((missing as Error).message).toBe('Function with ID 00000000-0000-4000-8000-000000000000 not found');
      for (const write of [functionsRepo.save, functionsRepo.remove, invocationsRepo.save, storage.uploadCode, storage.deleteCode]) {
        expect(write).not.toHaveBeenCalled();
      }
      for (const method of Object.values(orchestrator)) expect(method).not.toHaveBeenCalled();
      expect(metrics.invocationStarted).not.toHaveBeenCalled();
    });

    it.each(calls)('%s works for the account that owns the function', async (_name, call) => {
      await expect(call('user-1')).resolves.not.toBeInstanceOf(NotFoundException);
    });

    it("lists only the calling account's functions", async () => {
      await expect(service.findAll('user-2')).resolves.toEqual([]);
      await expect(service.findAll('user-1')).resolves.toEqual([owned()]);
    });

    it('finds the function of a name, its own account\'s only, compared exactly', async () => {
      const { name } = owned();

      await expect(service.findAll('user-1', name)).resolves.toEqual([owned()]);
      await expect(service.findAll('user-1', name.toUpperCase())).resolves.toEqual([]);
      await expect(service.findAll('user-2', name)).resolves.toEqual([]);
    });

    describe('logs (P-43)', () => {
      const page = {
        lines: [{ time: '2026-10-17T10:00:00.000000000Z', instance: 'fn-a', requestId: null, stream: 'stdout' as const, message: 'hi' }],
        next: 'next-page',
      };

      it("reads a page of the account's function's lines from the store, over its plan's retention, with the request", async () => {
        accountPlan = plan({ logRetentionDays: 7 });
        orchestrator.logs.mockResolvedValue(page);
        const before = Date.now();

        await expect(service.logs('user-1', ID, { tail: 20, q: 'time out', requestId: 'r-1', cursor: 'c-1' })).resolves.toEqual(page);

        const [fn, query] = orchestrator.logs.mock.calls[0] as unknown as [unknown, { start: Date; end: Date }];
        expect(fn).toEqual(owned());
        expect(query).toMatchObject({ limit: 20, q: 'time out', requestId: 'r-1', cursor: 'c-1' });
        expect(query.end.getTime()).toBeGreaterThanOrEqual(before);
        expect(query.end.getTime() - query.start.getTime()).toBe(7 * 86_400_000);
      });

      it('asks the store nothing when the whole window is older than the retention', async () => {
        await expect(service.logs('user-1', ID, { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' })).resolves.toEqual({ lines: [], next: null });
        expect(orchestrator.logs).not.toHaveBeenCalled();
      });

      it('answers 400 for a cursor that no page gave', async () => {
        orchestrator.logs.mockRejectedValue(new InvalidLogCursorError());

        const error = await service.logs('user-1', ID, { cursor: 'nope' }).catch((err: unknown) => err);

        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as Error).message).toBe('Invalid cursor: pass the next value of the page before');
      });

      it('answers 503 when the store is unavailable, its details only in the server log (D4)', async () => {
        orchestrator.logs.mockRejectedValue(new LogStoreUnavailableError('The log store answered 503: no endpoints available for service "victoria-logs"'));

        const error = await service.logs('user-1', ID, {}).catch((err: unknown) => err);

        expect(error).toBeInstanceOf(ServiceUnavailableException);
        expect((error as Error).message).toBe('Logs are unavailable right now. Try again in a minute.');
        expect(logged).toHaveBeenCalledWith(`The logs of function ${ID} could not be read: The log store answered 503: no endpoints available for service "victoria-logs"`);
      });

      it('passes any other failure on, as a platform failure', async () => {
        orchestrator.logs.mockRejectedValue(new Error('boom'));

        await expect(service.logs('user-1', ID, {})).rejects.toThrow('boom');
      });

      const line = page.lines[0];
      const events = (stream: Observable<MessageEvent>) =>
        new Promise<MessageEvent[]>((resolve) => {
          const got: MessageEvent[] = [];
          stream.subscribe({ next: (event) => got.push(event), complete: () => resolve(got) });
        });

      it("tails the account's function with the filter and the request's signal, as events", async () => {
        orchestrator.tailLogs.mockReturnValue((async function* () { yield line; })());
        const signal = new AbortController().signal;

        const stream = await service.liveLogs('user-1', ID, { q: 'time out', requestId: 'r-1' }, signal);

        expect(orchestrator.tailLogs).toHaveBeenCalledWith(owned(), { q: 'time out', requestId: 'r-1' }, signal);
        expect(await events(stream)).toEqual([{ data: line }, { type: 'end', data: { message: TAIL_ENDED } }]);
      });

      it.each([
        ["can't start the tail", new LogStoreUnavailableError('The log store answered 503: no endpoints')],
        ['fails on the way', new Error('socket hang up')],
      ])("ends the stream with 'unavailable' when the store %s, the cause in the server log alone (D4)", async (_, cause) => {
        const failing: AsyncIterable<never> = { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(cause) }) };
        orchestrator.tailLogs.mockReturnValue(failing);

        const got = await events(await service.liveLogs('user-1', ID, {}, new AbortController().signal));

        expect(got).toEqual([{ type: 'unavailable', data: { message: TAIL_UNAVAILABLE } }]);
        expect(logged).toHaveBeenCalledWith(`The live tail of function ${ID} stopped: ${cause.message}`);
      });
    });

    it('puts the account in the history query itself, not only in the check before it', async () => {
      await service.getInvocations('user-1', ID, { limit: 5, offset: 10 });

      expect(invocationsRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: { functionId: ID, function: { accountId: 'user-1' } }, take: 5, skip: 10 }),
      );
    });
  });
});

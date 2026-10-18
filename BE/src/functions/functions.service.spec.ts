import { BadRequestException, HttpStatus, InternalServerErrorException, Logger, MessageEvent, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MetricsService } from '../metrics/metrics.service';
import { MinioClientService } from '../minio-client/minio-client.service';
import {
  CodeTooLargeError,
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
import { FunctionInvocation, InvocationStatus } from './entities/function-invocation.entity';
import { Function, FunctionStatus, Runtime } from './entities/function.entity';
import { FunctionsService } from './functions.service';
import { TAIL_ENDED, TAIL_UNAVAILABLE } from './live-tail';
import { Observable } from 'rxjs';

/** What the caller sees of a platform failure (D4): no details, and the request ID. */
const internal = (action: string) => new RegExp(`^${action} failed because of an internal error \\(request [0-9a-f-]{36}\\)\\.$`);

describe('FunctionsService (orchestrator-agnostic)', () => {
  let service: FunctionsService;
  let orchestrator: jest.Mocked<Orchestrator>;
  let savedStatuses: FunctionStatus[];
  const functionsRepo = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    remove: jest.fn(),
  };
  const invocationsRepo = { create: jest.fn(), save: jest.fn(), findAndCount: jest.fn() };
  const storage = { uploadCode: jest.fn(), deleteCode: jest.fn() };
  const metrics = { recordMetric: jest.fn(), invocationStarted: jest.fn(), invocationFinished: jest.fn() };
  /** The account's plan, and how many functions it has: the transaction that saves a new one counts them. */
  let accountPlan: PlanView;
  let existingFunctions: number;
  const plans = { forAccount: jest.fn() };
  const transaction = { query: jest.fn(), countBy: jest.fn(), save: jest.fn() };
  const TENANT = { quota: BETA_LIMITS.quota };
  const audit = { record: jest.fn() };
  const usage = { record: jest.fn() };
  /** D9's balance check (P-33): every account may invoke unless a test says otherwise. */
  const credit = { admit: jest.fn(async (_accountId: string) => undefined) };
  /** The transaction that ends an invocation: it locks the row, saves the final state, then writes the usage record (D6). */
  const ending = { findOne: jest.fn(), save: jest.fn() };

  const activeFunction = (): Function =>
    ({
      id: 'fn-1',
      name: 'hello',
      accountId: 'user-1',
      runtime: Runtime.NODEJS,
      code: 'export const handler = async () => 1;',
      memory: 128,
      timeout: 5,
      minInstances: 0,
      maxInstances: 3,
      scaleToZero: true,
      status: FunctionStatus.ACTIVE,
    }) as Function;

  let logged: jest.SpyInstance;

  beforeEach(async () => {
    jest.resetAllMocks();
    jest.restoreAllMocks();
    logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    savedStatuses = [];
    functionsRepo.create.mockImplementation((dto) => ({ ...dto }));
    functionsRepo.save.mockImplementation(async (entity) => {
      savedStatuses.push(entity.status);
      entity.id ??= 'fn-1';
      return entity;
    });
    accountPlan = plan();
    existingFunctions = 0;
    plans.forAccount.mockImplementation(async () => accountPlan);
    transaction.countBy.mockImplementation(async () => existingFunctions);
    transaction.save.mockImplementation(async (_target, entity) => functionsRepo.save(entity));
    Object.assign(functionsRepo, { manager: { transaction: jest.fn(async (work) => work(transaction)) } });
    invocationsRepo.create.mockImplementation((dto) => ({ ...dto, id: 'inv-1', createdAt: new Date('2026-10-17T10:00:00Z') }));
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
      applyTenantLimits: jest.fn(),
      logs: jest.fn(),
      tailLogs: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        FunctionsService,
        { provide: getRepositoryToken(Function), useValue: functionsRepo },
        { provide: getRepositoryToken(FunctionInvocation), useValue: invocationsRepo },
        { provide: MinioClientService, useValue: storage },
        { provide: ORCHESTRATOR, useValue: orchestrator },
        // Return each key's default, as ConfigService does without overrides.
        { provide: ConfigService, useValue: { get: jest.fn((_key: string, fallback?: unknown) => fallback) } },
        { provide: MetricsService, useValue: metrics },
        { provide: PlansService, useValue: plans },
        { provide: AuditService, useValue: audit },
        { provide: UsageService, useValue: usage },
        { provide: CreditService, useValue: credit },
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

    it('does not try to release anything when the code was refused before reaching the cluster', async () => {
      orchestrator.deploy.mockRejectedValue(new CodeTooLargeError(2_000_000, 921_600));

      await expect(service.create('user-1', dto)).rejects.toThrow('the current limit is 921600 bytes');
      expect(orchestrator.scale).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    const notReady = () => new FunctionLoadError('Error', 'boom at init');
    const errored = (): Function => ({ ...activeFunction(), status: FunctionStatus.ERROR, error: 'old diagnosis' });

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

    it.each([
      ['memory', { memory: 256 }],
      ['timeout', { timeout: 30 }],
      ['runtime', { runtime: Runtime.PYTHON }],
    ])('rolls out a %s change', async (_field, change) => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());

      await service.update('user-1', 'fn-1', change);

      expect(orchestrator.update).toHaveBeenCalledWith(expect.objectContaining(change), TENANT);
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

      await expect(service.update('user-1', 'fn-1', { code: 'still broken' })).rejects.toThrow('boom at init');

      expect(orchestrator.update).toHaveBeenCalledTimes(1); // no rollback
      expect(functionsRepo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ code: 'still broken', status: FunctionStatus.ERROR, error: expect.stringContaining('boom at init') }),
      );
      expect(orchestrator.scale).toHaveBeenCalledWith(expect.objectContaining({ code: 'still broken' }), 0);
      expect(storage.uploadCode).toHaveBeenCalledWith('fn-1/code.ts', 'still broken');
    });

    it('changes nothing when the code is refused before reaching the cluster', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.update.mockRejectedValueOnce(new CodeTooLargeError(2_000_000, 921_600));

      await expect(service.update('user-1', 'fn-1', { code: 'x'.repeat(10) })).rejects.toThrow('the current limit is 921600 bytes');
      expect(orchestrator.update).toHaveBeenCalledTimes(1);
      expect(orchestrator.waitUntilReady).not.toHaveBeenCalled();
      expect(functionsRepo.save).not.toHaveBeenCalled();
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

  describe('invoke', () => {
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
      expect([invocationsRepo.save.mock.calls.length, orchestrator.invoke.mock.calls.length, usage.record.mock.calls.length]).toEqual([0, 0, 0]);
      expect(refusal.getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
    });

    it('stores output, runtime-reported duration and memory on a COMPLETED invocation', async () => {
      const fn = activeFunction();
      functionsRepo.findOne.mockResolvedValue(fn);
      orchestrator.invoke.mockResolvedValue({ output: { hello: 'world' }, durationMs: 12.5, memoryUsedMb: 12 });

      const invocation = await service.invoke('user-1', 'fn-1', { a: 1 });

      expect(orchestrator.invoke).toHaveBeenCalledWith(fn, { a: 1 }, 'inv-1');
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

      expect(orchestrator.invoke).toHaveBeenCalledWith(expect.anything(), {}, 'inv-1');
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
        { quota: { pods: 7, cpu: '2', memory: '3Gi' } },
        { quota: { pods: 7, cpu: '2', memory: '3Gi' } },
      ]);
    });
  });

  describe('usage records (P-20, D6, D7)', () => {
    const record = () => usage.record.mock.calls[0][0];

    it("sends the invocation's ID to the runtime, and writes its usage record, with the function's memory and minInstances, in the transaction that ends it", async () => {
      functionsRepo.findOne.mockResolvedValue({ ...activeFunction(), memory: 256, minInstances: 1 });
      orchestrator.invoke.mockResolvedValue({ output: 1, durationMs: 1.09, memoryUsedMb: 50 });

      await service.invoke('user-1', 'fn-1', { name: 'x' });

      expect(orchestrator.invoke).toHaveBeenCalledWith(expect.objectContaining({ id: 'fn-1' }), { name: 'x' }, 'inv-1');
      expect(usage.record).toHaveBeenCalledWith(
        {
          requestId: 'inv-1',
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

      expect(ending.findOne).toHaveBeenCalledWith(FunctionInvocation, { where: { id: 'inv-1' }, lock: { mode: 'pessimistic_write' } });
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
      expect(record()).toMatchObject({ requestId: 'inv-1', status: 'success', billedMs: 31, endedAt: expect.any(Date) });
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
          details: { name: 'hello', runtime: 'nodejs', memory: 128, timeout: 5 },
        },
        transaction,
      );
    });

    it('records the fields an update changed, with their new values but never the code', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());

      await service.update('user-1', 'fn-1', { code: 'v2', memory: 256, timeout: 5 });

      expect(recorded()).toEqual([
        { accountId: 'user-1', action: 'function.update', resource: 'function:fn-1', details: { changed: ['code', 'memory'], memory: 256, outcome: 'live' } },
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
      expect(recorded()).toEqual([expect.objectContaining({ action: 'function.update', details: { changed: ['code'], outcome: 'failed, kept: ERROR' } })]);
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

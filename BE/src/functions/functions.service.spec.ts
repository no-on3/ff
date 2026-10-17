import { BadRequestException, HttpStatus, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
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
  OrchestratorError,
} from '../orchestrator/orchestrator.errors';
import { ORCHESTRATOR, Orchestrator } from '../orchestrator/orchestrator.types';
import { FunctionInvocation, InvocationStatus } from './entities/function-invocation.entity';
import { Function, FunctionStatus, Runtime } from './entities/function.entity';
import { FunctionsService } from './functions.service';

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

  const activeFunction = (): Function =>
    ({
      id: 'fn-1',
      name: 'hello',
      userId: 'user-1',
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
    invocationsRepo.create.mockImplementation((dto) => ({ ...dto, createdAt: new Date() }));
    invocationsRepo.save.mockImplementation(async (entity) => entity);
    orchestrator = {
      deploy: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      waitUntilReady: jest.fn(),
      invoke: jest.fn(),
      scale: jest.fn(),
      readyInstances: jest.fn(),
      desiredInstances: jest.fn(),
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
      ],
    }).compile();
    service = moduleRef.get(FunctionsService);
  });

  describe('create', () => {
    const dto = { name: 'hello', runtime: Runtime.NODEJS, code: 'x', memory: 128, timeout: 5 };

    it('creates the function for the calling tenant, deploys it, waits until ready, then marks it ACTIVE', async () => {
      const result = await service.create('user-42', dto);

      expect(storage.uploadCode).toHaveBeenCalledWith('fn-1/code.ts', 'x');
      expect(orchestrator.deploy).toHaveBeenCalledWith(expect.objectContaining({ id: 'fn-1', userId: 'user-42' }));
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

      expect(orchestrator.update).toHaveBeenCalledWith(expect.objectContaining({ code: 'v2' }));
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

      expect(orchestrator.update).toHaveBeenCalledWith(expect.objectContaining(change));
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

      expect(orchestrator.update).toHaveBeenCalledWith(expect.objectContaining({ code: activeFunction().code }));
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
    it('stores output, runtime-reported duration and memory on a COMPLETED invocation', async () => {
      const fn = activeFunction();
      functionsRepo.findOne.mockResolvedValue(fn);
      orchestrator.invoke.mockResolvedValue({ output: { hello: 'world' }, durationMs: 12.5, memoryUsedMb: 12 });

      const invocation = await service.invoke('user-1', 'fn-1', { a: 1 });

      expect(orchestrator.invoke).toHaveBeenCalledWith(fn, { a: 1 });
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

      expect(orchestrator.invoke).toHaveBeenCalledWith(expect.anything(), {});
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
      expect(invocationsRepo.save).toHaveBeenLastCalledWith(expect.objectContaining({ status: InvocationStatus.ERROR }));
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
    });

    const calls: Array<[string, (accountId: string, id?: string) => Promise<unknown>]> = [
      ['findOne', (accountId, id = ID) => service.findOne(accountId, id)],
      ['update', (accountId, id = ID) => service.update(accountId, id, { code: 'v2' })],
      ['remove', (accountId, id = ID) => service.remove(accountId, id)],
      ['invoke', (accountId, id = ID) => service.invoke(accountId, id, {})],
      ['getInvocations', (accountId, id = ID) => service.getInvocations(accountId, id, { limit: 10, offset: 0 })],
      ['updateScalingConfig', (accountId, id = ID) => service.updateScalingConfig(accountId, id, { maxInstances: 2 })],
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

    it('puts the account in the history query itself, not only in the check before it', async () => {
      await service.getInvocations('user-1', ID, { limit: 5, offset: 10 });

      expect(invocationsRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: { functionId: ID, function: { userId: 'user-1' } }, take: 5, skip: 10 }),
      );
    });
  });
});

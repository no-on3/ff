import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MetricsService } from '../metrics/metrics.service';
import { MinioClientService } from '../minio-client/minio-client.service';
import {
  CodeTooLargeError,
  FunctionRuntimeError,
  FunctionTimeoutError,
  OrchestratorError,
} from '../orchestrator/orchestrator.errors';
import { ORCHESTRATOR, Orchestrator } from '../orchestrator/orchestrator.types';
import { FunctionInvocation, InvocationStatus } from './entities/function-invocation.entity';
import { Function, FunctionStatus, Runtime } from './entities/function.entity';
import { FunctionsService } from './functions.service';

describe('FunctionsService (orchestrator-agnostic)', () => {
  let service: FunctionsService;
  let orchestrator: jest.Mocked<Orchestrator>;
  let savedStatuses: FunctionStatus[];
  const functionsRepo = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    remove: jest.fn(),
  };
  const invocationsRepo = { create: jest.fn(), save: jest.fn() };
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

  beforeEach(async () => {
    jest.resetAllMocks();
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
      const result = await service.create(dto, 'user-42');

      expect(storage.uploadCode).toHaveBeenCalledWith('fn-1/code.ts', 'x');
      expect(orchestrator.deploy).toHaveBeenCalledWith(expect.objectContaining({ id: 'fn-1', userId: 'user-42' }));
      expect(orchestrator.waitUntilReady).toHaveBeenCalledWith(expect.objectContaining({ id: 'fn-1' }), 90_000);
      expect(savedStatuses).toEqual([FunctionStatus.CREATING, FunctionStatus.ACTIVE]);
      expect(result.status).toBe(FunctionStatus.ACTIVE);
    });

    it('marks the function ERROR with the message when the deploy fails', async () => {
      orchestrator.deploy.mockRejectedValue(new Error('scheduler unavailable'));

      await expect(service.create(dto, 'user-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(savedStatuses).toEqual([FunctionStatus.CREATING, FunctionStatus.ERROR]);
      expect(functionsRepo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: FunctionStatus.ERROR, error: 'scheduler unavailable' }),
      );
    });

    it('marks the function ERROR with the diagnostics when it never becomes ready, and releases its pod', async () => {
      orchestrator.waitUntilReady.mockRejectedValue(
        new OrchestratorError('Function "hello" did not become ready within 90 s: CrashLoopBackOff'),
      );

      await expect(service.create(dto, 'user-1')).rejects.toThrow('CrashLoopBackOff');
      expect(functionsRepo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: FunctionStatus.ERROR, error: expect.stringContaining('did not become ready') }),
      );
      // The idle sweep only scales ACTIVE functions: without this, the pod would hold the quota for good.
      expect(orchestrator.scale).toHaveBeenCalledWith(expect.objectContaining({ id: 'fn-1' }), 0);
      expect(orchestrator.remove).not.toHaveBeenCalled();
    });

    it('still answers with the diagnosis when the pod cannot be released', async () => {
      orchestrator.waitUntilReady.mockRejectedValue(new OrchestratorError('did not become ready'));
      orchestrator.scale.mockRejectedValue(new Error('api down'));

      await expect(service.create(dto, 'user-1')).rejects.toThrow('did not become ready');
      expect(savedStatuses).toEqual([FunctionStatus.CREATING, FunctionStatus.ERROR]);
    });

    it('does not try to release anything when the code was refused before reaching the cluster', async () => {
      orchestrator.deploy.mockRejectedValue(new CodeTooLargeError(2_000_000, 921_600));

      await expect(service.create(dto, 'user-1')).rejects.toThrow('the current limit is 921600 bytes');
      expect(orchestrator.scale).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    const notReady = () => new OrchestratorError('Function "hello" did not become ready within 90 s: boom at init');
    const errored = (): Function => ({ ...activeFunction(), status: FunctionStatus.ERROR, error: 'old diagnosis' });

    it('rolls out code changes, waits until they are live, then saves them and archives the code', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());

      const result = await service.update('fn-1', { code: 'v2' });

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

      await service.update('fn-1', change);

      expect(orchestrator.update).toHaveBeenCalledWith(expect.objectContaining(change));
    });

    it('moves the archived copy when the runtime changes', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());

      await service.update('fn-1', { runtime: Runtime.PYTHON, code: 'def handler(e, c): return 1' });

      expect(storage.uploadCode).toHaveBeenCalledWith('fn-1/code.py', 'def handler(e, c): return 1');
      expect(storage.deleteCode).toHaveBeenCalledWith('fn-1/code.ts');
    });

    it('does not roll out an ACTIVE function when only the name changes, or when values are unchanged', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      await service.update('fn-1', { name: 'renamed' });
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      await service.update('fn-1', { memory: 128 });

      expect(orchestrator.update).not.toHaveBeenCalled();
      expect(storage.uploadCode).not.toHaveBeenCalled();
      expect(savedStatuses).toEqual([FunctionStatus.ACTIVE, FunctionStatus.ACTIVE]);
    });

    it('repairs a function in ERROR: a successful rollout makes it ACTIVE and clears the error', async () => {
      functionsRepo.findOne.mockResolvedValue(errored());

      const result = await service.update('fn-1', { code: 'fixed' });

      expect(result).toMatchObject({ code: 'fixed', status: FunctionStatus.ACTIVE, error: null });
    });

    it.each([
      ['no field', {}],
      ['only the name', { name: 'renamed' }],
    ])('rolls out a function in ERROR even when %s changes, so the same code can be retried', async (_label, change) => {
      functionsRepo.findOne.mockResolvedValue(errored());

      const result = await service.update('fn-1', change);

      expect(orchestrator.update).toHaveBeenCalledWith(expect.objectContaining({ code: activeFunction().code }));
      expect(orchestrator.waitUntilReady).toHaveBeenCalled();
      expect(result.status).toBe(FunctionStatus.ACTIVE);
    });

    it('rolls a failed update of a working function back: the previous version is applied again, nothing is saved or archived', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.waitUntilReady.mockRejectedValueOnce(notReady()); // the new version; the previous one is ready

      const failure = service.update('fn-1', { code: 'broken' });

      await expect(failure).rejects.toBeInstanceOf(BadRequestException);
      await expect(failure).rejects.toThrow(
        'did not become ready within 90 s: boom at init. The update was rolled back: the previous version is still live.',
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

      await expect(service.update('fn-1', { code: 'broken' })).rejects.toThrow(
        'The update failed: Function "hello" did not become ready within 90 s: boom at init. ' +
          'Rolling back to the previous version failed too: no pods were created: exceeded quota',
      );
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

      await expect(service.update('fn-1', { code: 'still broken' })).rejects.toThrow('boom at init');

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

      await expect(service.update('fn-1', { code: 'x'.repeat(10) })).rejects.toThrow('the current limit is 921600 bytes');
      expect(orchestrator.update).toHaveBeenCalledTimes(1);
      expect(orchestrator.waitUntilReady).not.toHaveBeenCalled();
      expect(functionsRepo.save).not.toHaveBeenCalled();
    });

    it('saves a successful update even when its code cannot be archived (the copy is not read yet)', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      storage.uploadCode.mockRejectedValue(new Error('storage unavailable'));

      const result = await service.update('fn-1', { code: 'v2' });

      expect(result).toMatchObject({ code: 'v2', status: FunctionStatus.ACTIVE });
      expect(functionsRepo.save).toHaveBeenCalledTimes(1);
    });
  });

  it('remove deletes scheduler resources, stored code, and the record', async () => {
    const fn = activeFunction();
    functionsRepo.findOne.mockResolvedValue(fn);

    await service.remove('fn-1');

    expect(orchestrator.remove).toHaveBeenCalledWith(fn);
    expect(storage.deleteCode).toHaveBeenCalledWith('fn-1/code.ts');
    expect(functionsRepo.remove).toHaveBeenCalledWith(fn);
  });

  describe('invoke', () => {
    it('stores output, runtime-reported duration and memory on a COMPLETED invocation', async () => {
      const fn = activeFunction();
      functionsRepo.findOne.mockResolvedValue(fn);
      orchestrator.invoke.mockResolvedValue({ output: { hello: 'world' }, durationMs: 12.5, memoryUsedMb: 12 });

      const invocation = await service.invoke('fn-1', { a: 1 });

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

      await service.invoke('fn-1', {});

      expect(metrics.invocationFinished).toHaveBeenCalledWith(fn);
    });

    it('counts a failed call as finished too', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.invoke.mockRejectedValue(new Error('connection refused'));

      await expect(service.invoke('fn-1', {})).rejects.toBeInstanceOf(BadRequestException);
      expect(metrics.invocationStarted).toHaveBeenCalledTimes(1);
      expect(metrics.invocationFinished).toHaveBeenCalledTimes(1);
    });

    it('falls back to the measured end-to-end duration when the runtime reports none', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.invoke.mockResolvedValue({ output: null });

      const invocation = await service.invoke('fn-1');

      expect(orchestrator.invoke).toHaveBeenCalledWith(expect.anything(), {});
      expect(invocation.duration).toBeGreaterThanOrEqual(0);
    });

    it('records a TIMEOUT invocation for function timeouts', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.invoke.mockRejectedValue(new FunctionTimeoutError('Task timed out after 5.00 seconds'));

      await expect(service.invoke('fn-1', {})).rejects.toThrow('Sandbox.Timedout: Task timed out after 5.00 seconds');
      expect(invocationsRepo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: InvocationStatus.TIMEOUT, duration: expect.any(Number) }),
      );
      expect(metrics.recordMetric).toHaveBeenCalledWith('fn-1', expect.any(Number), 0, true);
    });

    it('records the runtime error type for function errors', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.invoke.mockRejectedValue(new FunctionRuntimeError('TypeError', 'bad input'));

      await expect(service.invoke('fn-1', {})).rejects.toBeInstanceOf(BadRequestException);
      expect(invocationsRepo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: InvocationStatus.ERROR, error: 'TypeError: bad input' }),
      );
    });

    it('records an ERROR invocation when the platform fails', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.invoke.mockRejectedValue(new Error('connection refused'));

      await expect(service.invoke('fn-1', {})).rejects.toBeInstanceOf(BadRequestException);
      expect(invocationsRepo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: InvocationStatus.ERROR, error: 'connection refused' }),
      );
    });

    it('says why a call failed even when the error has no message of its own (P-09)', async () => {
      // A refused connection to every address of a host name: an AggregateError with an empty message.
      const refused = (address: string) => Object.assign(new Error(`connect ECONNREFUSED ${address}`), { code: 'ECONNREFUSED' });
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.invoke.mockRejectedValue(new AggregateError([refused('::1:6550'), refused('127.0.0.1:6550')], ''));

      await expect(service.invoke('fn-1', {})).rejects.toThrow('connect ECONNREFUSED ::1:6550; connect ECONNREFUSED 127.0.0.1:6550');
      expect(invocationsRepo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: InvocationStatus.ERROR, error: 'connect ECONNREFUSED ::1:6550; connect ECONNREFUSED 127.0.0.1:6550' }),
      );
    });

    it('rejects functions that are not ACTIVE without calling the orchestrator', async () => {
      functionsRepo.findOne.mockResolvedValue({ ...activeFunction(), status: FunctionStatus.CREATING });

      await expect(service.invoke('fn-1', {})).rejects.toBeInstanceOf(BadRequestException);
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

      const config = await service.updateScalingConfig('fn-1', { maxInstances: 2 });

      expect(config).toEqual({ minInstances: 0, maxInstances: 2, scaleToZero: true });
      expect(functionsRepo.save).toHaveBeenCalledWith(expect.objectContaining({ maxInstances: 2 }));
      expect(orchestrator.scale).toHaveBeenCalledWith(expect.objectContaining({ id: 'fn-1' }), 2);
    });

    it('starts the instances a higher minInstances asks for, without a rollout', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.desiredInstances.mockResolvedValue(0);

      const config = await service.updateScalingConfig('fn-1', { minInstances: 2 });

      expect(config).toEqual({ minInstances: 2, maxInstances: 3, scaleToZero: false });
      expect(orchestrator.scale).toHaveBeenCalledWith(expect.anything(), 2);
      expect(orchestrator.update).not.toHaveBeenCalled();
    });

    it('leaves the instances alone when they are within the new limits', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.desiredInstances.mockResolvedValue(1);

      await service.updateScalingConfig('fn-1', { maxInstances: 5 });

      expect(orchestrator.scale).not.toHaveBeenCalled();
    });

    it('refuses a minInstances above maxInstances, counting the stored values', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction()); // maxInstances 3

      await expect(service.updateScalingConfig('fn-1', { minInstances: 4 })).rejects.toThrow(
        "minInstances (4) can't be more than maxInstances (3)",
      );
      expect(functionsRepo.save).not.toHaveBeenCalled();
    });

    it('only saves the limits of a function that is not ACTIVE: its next rollout applies them', async () => {
      functionsRepo.findOne.mockResolvedValue({ ...activeFunction(), status: FunctionStatus.ERROR });

      await service.updateScalingConfig('fn-1', { minInstances: 1 });

      expect(functionsRepo.save).toHaveBeenCalled();
      expect(orchestrator.desiredInstances).not.toHaveBeenCalled();
      expect(orchestrator.scale).not.toHaveBeenCalled();
    });

    it('keeps the saved limits when the cluster cannot be reached', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.desiredInstances.mockRejectedValue(new Error('api down'));

      await expect(service.updateScalingConfig('fn-1', { maxInstances: 2 })).resolves.toMatchObject({ maxInstances: 2 });
      expect(functionsRepo.save).toHaveBeenCalled();
    });
  });
});

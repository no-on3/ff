import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MetricsService } from '../metrics/metrics.service';
import { MinioClientService } from '../minio-client/minio-client.service';
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
  const metrics = { recordMetric: jest.fn() };

  const activeFunction = (): Function =>
    ({
      id: 'fn-1',
      name: 'hello',
      userId: '1',
      runtime: Runtime.NODEJS,
      code: 'export const handler = async () => 1;',
      memory: 128,
      cpu: 100,
      timeout: 5,
      minInstances: 0,
      maxInstances: 1,
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
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        FunctionsService,
        { provide: getRepositoryToken(Function), useValue: functionsRepo },
        { provide: getRepositoryToken(FunctionInvocation), useValue: invocationsRepo },
        { provide: MinioClientService, useValue: storage },
        { provide: ORCHESTRATOR, useValue: orchestrator },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: MetricsService, useValue: metrics },
      ],
    }).compile();
    service = moduleRef.get(FunctionsService);
  });

  describe('create', () => {
    const dto = { name: 'hello', runtime: Runtime.NODEJS, code: 'x', memory: 128, timeout: 5 };

    it('stores the code, deploys through the orchestrator, then marks the function ACTIVE', async () => {
      const result = await service.create(dto, 'user-1');

      expect(storage.uploadCode).toHaveBeenCalledWith('fn-1/code.ts', 'x');
      expect(orchestrator.deploy).toHaveBeenCalledWith(expect.objectContaining({ id: 'fn-1', name: 'hello' }));
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
    it('maps the orchestrator result onto a COMPLETED invocation and records metrics', async () => {
      const fn = activeFunction();
      functionsRepo.findOne.mockResolvedValue(fn);
      orchestrator.invoke.mockResolvedValue({ output: { hello: 'world' }, memoryUsedMb: 12, cpuUsed: 3 });

      const invocation = await service.invoke('fn-1', { a: 1 });

      expect(orchestrator.invoke).toHaveBeenCalledWith(fn, { a: 1 });
      expect(invocation).toMatchObject({
        status: InvocationStatus.COMPLETED,
        output: { hello: 'world' },
        memoryUsed: 12,
        cpuUsed: 3,
      });
      expect(metrics.recordMetric).toHaveBeenCalledWith('fn-1', expect.any(Number), 3, 12, false);
    });

    it('sends an empty payload when no input is given', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.invoke.mockResolvedValue({ output: null });

      await service.invoke('fn-1');

      expect(orchestrator.invoke).toHaveBeenCalledWith(expect.anything(), {});
    });

    it('records an ERROR invocation and an error metric when the call fails', async () => {
      functionsRepo.findOne.mockResolvedValue(activeFunction());
      orchestrator.invoke.mockRejectedValue(new Error('connection refused'));

      await expect(service.invoke('fn-1', {})).rejects.toBeInstanceOf(BadRequestException);
      expect(invocationsRepo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: InvocationStatus.ERROR, error: 'connection refused' }),
      );
      expect(metrics.recordMetric).toHaveBeenCalledWith('fn-1', expect.any(Number), 0, 0, true);
    });

    it('rejects functions that are not ACTIVE without calling the orchestrator', async () => {
      functionsRepo.findOne.mockResolvedValue({ ...activeFunction(), status: FunctionStatus.CREATING });

      await expect(service.invoke('fn-1', {})).rejects.toBeInstanceOf(BadRequestException);
      expect(orchestrator.invoke).not.toHaveBeenCalled();
    });
  });
});

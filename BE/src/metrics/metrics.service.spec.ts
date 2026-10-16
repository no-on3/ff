import { ConfigService } from '@nestjs/config';
import { Function, FunctionStatus, Runtime } from '../functions/entities/function.entity';
import { Orchestrator } from '../orchestrator/orchestrator.types';
import { MetricsService } from './metrics.service';

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('MetricsService', () => {
  const now = Date.now();
  const fn = (overrides: Partial<Function> = {}): Function =>
    ({
      id: 'fn-1',
      name: 'hello',
      userId: 'user-1',
      runtime: Runtime.NODEJS,
      code: 'x',
      memory: 128,
      timeout: 5,
      minInstances: 0,
      maxInstances: 3,
      scaleToZero: true,
      status: FunctionStatus.ACTIVE,
      updatedAt: new Date(now - 3_600_000),
      ...overrides,
    }) as Function;

  let orchestrator: jest.Mocked<Orchestrator>;
  let functionRepository: { findOne: jest.Mock; find: jest.Mock };
  let metricsRepository: { save: jest.Mock; find: jest.Mock };
  let service: MetricsService;

  const create = (supportsScaleToZero = true, idleSeconds = 900) => {
    orchestrator = {
      supportsScaleToZero,
      deploy: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      waitUntilReady: jest.fn(),
      invoke: jest.fn(),
      scale: jest.fn(),
      readyInstances: jest.fn().mockResolvedValue(1),
    } as any;
    functionRepository = { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) };
    metricsRepository = { save: jest.fn(), find: jest.fn() };
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => (key === 'scaling.scaleToZeroIdleSeconds' ? idleSeconds : fallback)),
    } as unknown as ConfigService;
    service = new MetricsService(metricsRepository as any, functionRepository as any, orchestrator, config);
  };

  beforeEach(() => create());

  describe('aggregate', () => {
    it('persists window metrics and scales overloaded functions within maxInstances', async () => {
      functionRepository.findOne.mockResolvedValue(fn({ maxInstances: 2 }));
      orchestrator.readyInstances.mockResolvedValue(1);
      for (let i = 0; i < 10; i++) await service.recordMetric('fn-1', 100, 0, 30, i === 0);

      await service.aggregate();

      expect(metricsRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ functionId: 'fn-1', requestCount: 10, errorCount: 1, activeInstances: 1 }),
      );
      expect(orchestrator.scale).toHaveBeenCalledWith(expect.objectContaining({ id: 'fn-1' }), 2);
    });

    it('skips functions deleted since the window opened', async () => {
      functionRepository.findOne.mockResolvedValue(null);
      await service.recordMetric('gone', 100, 0, 30, false);

      await service.aggregate();

      expect(metricsRepository.save).not.toHaveBeenCalled();
      expect(orchestrator.scale).not.toHaveBeenCalled();
    });

    it('starts a fresh window, so a second aggregate has nothing to report', async () => {
      functionRepository.findOne.mockResolvedValue(fn());
      await service.recordMetric('fn-1', 100, 0, 30, false);

      await service.aggregate();
      await service.aggregate();

      expect(metricsRepository.save).toHaveBeenCalledTimes(1);
    });
  });

  describe('sweepIdleFunctions', () => {
    it('only considers ACTIVE functions with scaleToZero and minInstances 0', async () => {
      await service.sweepIdleFunctions(now + 3_600_000);

      expect(functionRepository.find).toHaveBeenCalledWith({
        where: { status: FunctionStatus.ACTIVE, scaleToZero: true, minInstances: 0 },
      });
    });

    it('scales a function idle for longer than the idle period to zero', async () => {
      functionRepository.find.mockResolvedValue([fn()]);

      await service.sweepIdleFunctions(now + 901_000);

      expect(orchestrator.scale).toHaveBeenCalledWith(expect.objectContaining({ id: 'fn-1' }), 0);
    });

    it('leaves recently invoked functions alone, without calling the scheduler', async () => {
      functionRepository.find.mockResolvedValue([fn()]);
      await service.recordMetric('fn-1', 100, 0, 30, false);

      await service.sweepIdleFunctions(Date.now() + 60_000);

      expect(orchestrator.readyInstances).not.toHaveBeenCalled();
      expect(orchestrator.scale).not.toHaveBeenCalled();
    });

    it('counts from process start for functions it has never seen invoked', async () => {
      functionRepository.find.mockResolvedValue([fn()]);

      await service.sweepIdleFunctions(Date.now() + 1_000); // the backend just started

      expect(orchestrator.scale).not.toHaveBeenCalled();
    });

    it('does nothing when the driver cannot cold-start (Nomad)', async () => {
      create(false);
      functionRepository.find.mockResolvedValue([fn()]);

      await service.sweepIdleFunctions(now + 3_600_000);

      expect(functionRepository.find).not.toHaveBeenCalled();
      expect(orchestrator.scale).not.toHaveBeenCalled();
    });

    it('keeps sweeping other functions when one scale call fails', async () => {
      functionRepository.find.mockResolvedValue([fn({ id: 'a' }), fn({ id: 'b' })]);
      orchestrator.scale.mockRejectedValueOnce(new Error('api down'));

      await service.sweepIdleFunctions(now + 3_600_000);

      expect(orchestrator.scale).toHaveBeenCalledTimes(2);
    });
  });
});

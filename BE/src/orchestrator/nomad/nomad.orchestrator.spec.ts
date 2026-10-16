import { Runtime } from '../../functions/entities/function.entity';
import { NomadService } from '../../nomad/nomad.service';
import { FunctionWorkload } from '../orchestrator.types';
import { NomadOrchestrator } from './nomad.orchestrator';

describe('NomadOrchestrator (deprecated adapter)', () => {
  const fn: FunctionWorkload = {
    id: 'fn-1',
    name: 'hello',
    userId: '1',
    runtime: Runtime.NODEJS,
    code: 'x',
    memory: 128,
    timeout: 5,
    minInstances: 0,
    maxInstances: 1,
  };
  const nomad = {
    deployFunction: jest.fn(),
    updateFunction: jest.fn(),
    removeFunction: jest.fn(),
    invokeFunction: jest.fn(),
    scaleFunction: jest.fn(),
    getActiveInstanceCount: jest.fn(),
  };
  const adapter = new NomadOrchestrator(nomad as unknown as NomadService);

  beforeEach(() => jest.resetAllMocks());

  it('delegates lifecycle calls to NomadService', async () => {
    await adapter.deploy(fn);
    await adapter.update(fn);
    await adapter.remove(fn);
    await adapter.scale(fn, 3);
    nomad.getActiveInstanceCount.mockResolvedValue(2);

    expect(await adapter.readyInstances(fn)).toBe(2);
    expect(nomad.deployFunction).toHaveBeenCalledWith(fn);
    expect(nomad.updateFunction).toHaveBeenCalledWith(fn);
    expect(nomad.removeFunction).toHaveBeenCalledWith(fn);
    expect(nomad.scaleFunction).toHaveBeenCalledWith('fn-1', 3);
    expect(nomad.getActiveInstanceCount).toHaveBeenCalledWith('fn-1');
  });

  it('maps an explicit output field and the resource figures', async () => {
    nomad.invokeFunction.mockResolvedValue({ output: { x: 1 }, memoryUsed: 5, cpuUsed: 2 });

    await expect(adapter.invoke(fn, { a: 1 })).resolves.toEqual({
      output: { x: 1 },
      memoryUsedMb: 5,
      cpuUsed: 2,
    });
    expect(nomad.invokeFunction).toHaveBeenCalledWith(fn, { a: 1 });
  });

  it('keeps the legacy behaviour of storing the whole response when there is no output field', async () => {
    const raw = { message: 'hi', memoryUsed: 5 };
    nomad.invokeFunction.mockResolvedValue(raw);

    await expect(adapter.invoke(fn, {})).resolves.toMatchObject({ output: raw, memoryUsedMb: 5 });
  });
});

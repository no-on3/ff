import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { Orchestrator } from '../orchestrator/orchestrator.types';
import { onePlan } from '../plans/test-fixtures';
import { Function, FunctionStatus, UpdateStatus } from './entities/function.entity';
import { FunctionsService } from './functions.service';
import { StoppedChanges } from './stopped-changes.service';

/** Two functions a stopped backend left under way, which PostgreSQL finds. */
const stopped = (id: string) => ({ id, accountId: '400000000031', status: FunctionStatus.ACTIVE, revisionId: `rev-${id}`, updateStatus: UpdateStatus.IN_PROGRESS }) as Function;

describe('StoppedChanges', () => {
  let manager: { update: jest.Mock };
  let functions: { runningWorkload: jest.Mock; releaseInstances: jest.Mock };
  let orchestrator: { workloads: jest.Mock; update: jest.Mock; deploy: jest.Mock; waitUntilReady: jest.Mock };
  let audit: { record: jest.Mock };
  let sweeper: StoppedChanges;

  beforeEach(() => {
    manager = { update: jest.fn(async () => ({ affected: 1 })) };
    // The job's lock taken, its rows found.
    const dataSource = {
      manager,
      createQueryRunner: () => ({ connect: async () => undefined, query: async () => [{ locked: true }], release: async () => undefined }),
      getRepository: () => ({ find: async () => [stopped('fn-1'), stopped('fn-2')] }),
    };
    functions = { runningWorkload: jest.fn(async (id: string) => ({ id, codeImage: 'registry.test/code' })), releaseInstances: jest.fn() };
    orchestrator = { workloads: jest.fn(async () => [{ desired: 1 }]), update: jest.fn(), deploy: jest.fn(), waitUntilReady: jest.fn() };
    audit = { record: jest.fn() };
    sweeper = new StoppedChanges(
      dataSource as unknown as DataSource,
      functions as unknown as FunctionsService,
      orchestrator as unknown as Orchestrator,
      onePlan(),
      audit as unknown as AuditService,
      new ConfigService({}),
    );
  });

  afterEach(() => {
    sweeper.onModuleDestroy();
    jest.useRealTimers();
  });

  it('counts a change it could not end, which the next turn tries again, and ends the others', async () => {
    manager.update.mockRejectedValueOnce(new Error('the connection was reset'));

    expect(await sweeper.sweep()).toEqual({ ended: 1, rolledOut: 1, failures: 1 });

    expect(orchestrator.update).toHaveBeenCalledTimes(1);
    expect(orchestrator.update).toHaveBeenCalledWith({ id: 'fn-2', codeImage: 'registry.test/code' }, expect.anything());
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ resource: 'function:fn-2', action: 'function.update' }));
  });

  it('ends nothing, and logs nothing, when another change took the function first', async () => {
    manager.update.mockResolvedValue({ affected: 0 });

    expect(await sweeper.sweep()).toEqual({ ended: 0, rolledOut: 0, failures: 0 });

    expect(orchestrator.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('sweeps at the start, then each minute, a slow turn never run twice at once', async () => {
    jest.useFakeTimers();
    let endTurn!: () => void;
    const sweep = jest.spyOn(sweeper, 'sweep').mockImplementation(
      () => new Promise((resolve) => (endTurn = () => resolve({ ended: 0, rolledOut: 0, failures: 0 }))),
    );

    sweeper.onModuleInit();
    expect(sweep).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(60_000);
    expect(sweep).toHaveBeenCalledTimes(1);

    endTurn();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(sweep).toHaveBeenCalledTimes(2);

    endTurn();
    sweeper.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(sweep).toHaveBeenCalledTimes(2);
  });
});

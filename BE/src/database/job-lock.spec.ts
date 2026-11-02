import { DataSource } from 'typeorm';
import { withJobLock } from './job-lock';

describe("a job's turn under its advisory lock (L1)", () => {
  /** A connection of its own, whose lock is free unless a test says another turn holds it. */
  const connection = (free: boolean) => {
    const runner = {
      connect: jest.fn(),
      release: jest.fn(),
      query: jest.fn(async (sql: string) => (sql.includes('pg_try_advisory_lock') ? [{ locked: free }] : [])),
    };
    return { runner, dataSource: { createQueryRunner: () => runner } as unknown as DataSource };
  };

  it("runs the turn while it holds the job's lock, gives it back, and answers what the turn did", async () => {
    const { runner, dataSource } = connection(true);

    expect(await withJobLock(dataSource, 'ff_example', async () => 3)).toBe(3);
    expect(runner.query.mock.calls.map(([sql]) => sql)).toEqual([`SELECT pg_try_advisory_lock(hashtext('ff_example')) AS "locked"`, `SELECT pg_advisory_unlock(hashtext('ff_example'))`]);
    expect(runner.release).toHaveBeenCalled();
  });

  it('does nothing, and answers undefined, while another turn holds it', async () => {
    const { runner, dataSource } = connection(false);
    const work = jest.fn(async () => 3);

    expect(await withJobLock(dataSource, 'ff_example', work)).toBeUndefined();
    expect(work).not.toHaveBeenCalled();
    expect(runner.query).toHaveBeenCalledTimes(1);
    expect(runner.release).toHaveBeenCalled();
  });

  it('gives the lock and the connection back when the turn fails, and fails with it', async () => {
    const { runner, dataSource } = connection(true);

    await expect(withJobLock(dataSource, 'ff_example', () => Promise.reject(new Error('the store is down')))).rejects.toThrow('the store is down');
    expect(runner.query).toHaveBeenLastCalledWith(`SELECT pg_advisory_unlock(hashtext('ff_example'))`);
    expect(runner.release).toHaveBeenCalled();
  });
});

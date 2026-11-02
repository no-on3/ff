import { DataSource } from 'typeorm';

/**
 * One turn of a job that runs in one backend at a time: `work`, while this
 * backend holds PostgreSQL's advisory lock of the job's name, on a connection
 * of its own, given back after; undefined, and nothing done, while another
 * turn holds it, here or in another backend. The name is the job's own, a
 * constant of the code.
 */
export async function withJobLock<T>(dataSource: DataSource, name: string, work: () => Promise<T>): Promise<T | undefined> {
  const lock = `hashtext('${name}')`;
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    const [{ locked }] = (await runner.query(`SELECT pg_try_advisory_lock(${lock}) AS "locked"`)) as Array<{ locked: boolean }>;
    if (!locked) return undefined;
    try {
      return await work();
    } finally {
      await runner.query(`SELECT pg_advisory_unlock(${lock})`);
    }
  } finally {
    await runner.release();
  }
}

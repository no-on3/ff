/**
 * L2: the sweeper of changes a stopped backend left half done, on a real
 * PostgreSQL, the cluster a stand-in: a change still under way past its bound
 * is taken over and ended Failed, saying why, in the audit log; a working
 * function's version rolled out again, or deployed again when the cluster
 * holds none; a create's function ERROR, and one in ERROR kept so, both scaled
 * to zero; a rollout the cluster refuses leaves the function ERROR. A change
 * within its bound is left to it, and a turn while another backend's runs does
 * nothing. Each run works in a scratch database, dropped afterwards.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { EncryptionService } from '../encryption/encryption.service';
import { onePlan } from '../plans/test-fixtures';
import { FunctionEnvironment } from './entities/function-environment.entity';
import { FunctionInvocation } from './entities/function-invocation.entity';
import { Function, FunctionStatus, Runtime, UpdateStatus } from './entities/function.entity';
import { EnvironmentStore } from './environment.store';
import { FunctionsService } from './functions.service';
import { STOPPED_REASONS, StoppedChanges } from './stopped-changes.service';
import { StandInCluster, noFunctionKeys, noPackages } from './test-fixtures';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '400000000031';
/** The code image a stopped update was rolling out. */
const NEW_IMAGE = 'registry.test/stopped-update@sha256:0000';

run('the sweeper of changes a stopped backend left (L2)', () => {
  let db: ScratchDatabase;
  let cluster: StandInCluster;
  let functions: FunctionsService;
  let sweeper: StoppedChanges;

  const query = <T>(sql: string, parameters: unknown[] = []) => db.dataSource.query<T>(sql, parameters);
  const row = (id: string) => db.dataSource.getRepository(Function).findOneByOrFail({ id });
  const create = (name: string) =>
    functions.create(ACCOUNT, { name, runtime: Runtime.NODEJS, code: 'exports.handler = async () => 1;', memory: 128, timeout: 5, environment: { TABLE: 'orders' } });
  /** The function's change as a stopped backend left it: under way since `ago`, its record as it was, but for `fields`. */
  const stopped = (id: string, ago = '10 minutes', fields = '') =>
    query(`UPDATE functions SET update_status = 'InProgress', update_reason = NULL, update_started_at = now() - $2::interval${fields} WHERE id = $1`, [id, ago]);
  /** What the audit log, which keeps every entry, says of the function's changes. */
  const audited = (id: string) =>
    query<Array<{ action: string; actor: string; outcome: string }>>(
      `SELECT action, actor, details->>'outcome' AS outcome FROM audit_log WHERE resource = $1 AND action = 'function.update' ORDER BY id`,
      [`function:${id}`],
    );

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    await db.dataSource.getRepository(Account).save({ id: ACCOUNT, name: 'Stopped changes', planId: 'beta', status: AccountStatus.ACTIVE });
    const encryption = new EncryptionService({ getOrThrow: () => [{ id: 'test', key: randomBytes(32) }] } as unknown as ConfigService);
    const store = new EnvironmentStore(db.dataSource.getRepository(FunctionEnvironment), encryption);
    const audit = new AuditService(db.dataSource.getRepository(AuditEntry));
    cluster = new StandInCluster();
    const orchestrator = cluster.orchestrator();
    const [packages, images] = noPackages();
    // 90 s for an instance to be ready, as FF waits by default: a change's bound is 4 minutes.
    const config = new ConfigService({});
    functions = new FunctionsService(
      db.dataSource.getRepository(Function),
      db.dataSource.getRepository(FunctionInvocation),
      { uploadCode: async () => undefined, deleteCode: async () => undefined } as never,
      orchestrator,
      config,
      {} as never, // no invocations here: no metrics
      onePlan(),
      audit,
      {} as never, // no invocations: no usage records
      {} as never, // nor a balance check
      store,
      packages,
      images,
      noFunctionKeys(),
    );
    sweeper = new StoppedChanges(db.dataSource, functions, orchestrator, onePlan(), audit, config);
  });

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await query('DELETE FROM functions');
    cluster.deployments.clear();
    cluster.asked.length = 0;
    cluster.refusing = undefined;
  });

  it("rolls a working function's version out again over a stopped update's, and ends the change Failed, saying why, in the audit log", async () => {
    const fn = await create('orders');
    const recorded = (await functions.runningWorkload(fn.id))!;
    cluster.hold({ ...recorded, codeImage: NEW_IMAGE });
    await stopped(fn.id);
    cluster.asked.length = 0;

    expect(await sweeper.sweep()).toEqual({ ended: 1, rolledOut: 1, failures: 0 });

    expect(cluster.of(fn)).toMatchObject({ codeImage: recorded.codeImage, desired: 1 });
    expect(cluster.asked).toEqual([`wait ${fn.id}`]);
    expect(await row(fn.id)).toMatchObject({
      status: FunctionStatus.ACTIVE,
      error: null,
      updateStatus: UpdateStatus.FAILED,
      updateReason: STOPPED_REASONS.undone,
      updateStartedAt: null,
    });
    expect(await audited(fn.id)).toEqual([{ action: 'function.update', actor: 'system', outcome: `stopped by the backend, ended Failed: ${STOPPED_REASONS.undone}` }]);
    // Ended: the next turn has nothing to do.
    expect(await sweeper.sweep()).toEqual({ ended: 0, rolledOut: 0, failures: 0 });
  });

  it('deploys the version again when a stopped delete removed its Deployment', async () => {
    const fn = await create('half-deleted');
    cluster.deployments.clear();
    await stopped(fn.id);

    expect(await sweeper.sweep()).toEqual({ ended: 1, rolledOut: 1, failures: 0 });

    expect(cluster.of(fn)).toMatchObject({ codeImage: (await functions.runningWorkload(fn.id))!.codeImage });
    expect(await row(fn.id)).toMatchObject({ status: FunctionStatus.ACTIVE, updateStatus: UpdateStatus.FAILED, updateReason: STOPPED_REASONS.undone });
  });

  it("ends a stopped create's function ERROR, saying why, scaled to zero", async () => {
    const fn = await create('half-created');
    await stopped(fn.id, '10 minutes', `, status = 'CREATING'`);
    cluster.asked.length = 0;

    expect(await sweeper.sweep()).toEqual({ ended: 1, rolledOut: 0, failures: 0 });

    expect(cluster.asked).toEqual([`scale ${fn.id} 0`]);
    expect(await row(fn.id)).toMatchObject({
      status: FunctionStatus.ERROR,
      error: STOPPED_REASONS.create,
      updateStatus: UpdateStatus.FAILED,
      updateReason: STOPPED_REASONS.create,
      updateStartedAt: null,
    });
  });

  it('keeps a function in ERROR so, its error with it, scaled to zero', async () => {
    const fn = await create('broken');
    await stopped(fn.id, '10 minutes', `, status = 'ERROR', error = 'Its image would not start.'`);
    cluster.asked.length = 0;

    expect(await sweeper.sweep()).toEqual({ ended: 1, rolledOut: 0, failures: 0 });

    expect(cluster.asked).toEqual([`scale ${fn.id} 0`]);
    expect(await row(fn.id)).toMatchObject({
      status: FunctionStatus.ERROR,
      error: 'Its image would not start.',
      updateStatus: UpdateStatus.FAILED,
      updateReason: STOPPED_REASONS.notActive,
    });
  });

  it('leaves the function ERROR, saying both, scaled to zero, when the cluster refuses its version', async () => {
    const fn = await create('refused');
    cluster.hold({ ...(await functions.runningWorkload(fn.id))!, codeImage: NEW_IMAGE });
    await stopped(fn.id);
    cluster.refusing = fn.id;

    expect(await sweeper.sweep()).toEqual({ ended: 1, rolledOut: 0, failures: 0 });

    const ended = await row(fn.id);
    const why = /^The backend stopped during this change, and the version before it couldn't be rolled out again: Rolling the function out again failed because of an internal error \(request [0-9a-f-]{36}\)\.$/;
    expect(ended).toMatchObject({ status: FunctionStatus.ERROR, error: expect.stringMatching(why), updateStatus: UpdateStatus.FAILED, updateReason: ended.error });
    // The cluster's reason stays in the backend's log: the caller is told of an internal error.
    expect(ended.error).not.toMatch(/API server/);
    expect(cluster.of(fn)).toMatchObject({ desired: 0 });
  });

  it('leaves a change within its bound to it, and takes over one under way without a start', async () => {
    const running = await create('running');
    const ended = await create('ended');
    const unknown = await create('unknown');
    await stopped(running.id, '3 minutes');
    await query(`UPDATE functions SET update_status = 'InProgress', update_started_at = NULL WHERE id = $1`, [unknown.id]);

    expect(await sweeper.sweep()).toEqual({ ended: 1, rolledOut: 1, failures: 0 });

    expect(await row(running.id)).toMatchObject({ updateStatus: UpdateStatus.IN_PROGRESS, updateStartedAt: expect.any(Date) });
    expect(await row(ended.id)).toMatchObject({ updateStatus: UpdateStatus.SUCCESSFUL, updateReason: null });
    expect(await row(unknown.id)).toMatchObject({ updateStatus: UpdateStatus.FAILED, updateReason: STOPPED_REASONS.undone });
  });

  it("does nothing while another backend's turn runs", async () => {
    const fn = await create('swept-elsewhere');
    await stopped(fn.id);
    const other = db.dataSource.createQueryRunner();
    await other.connect();
    try {
      await other.query(`SELECT pg_advisory_lock(hashtext('ff_stopped_changes'))`);
      expect(await sweeper.sweep()).toEqual({ ended: 0, rolledOut: 0, failures: 0 });
      expect(await row(fn.id)).toMatchObject({ updateStatus: UpdateStatus.IN_PROGRESS });
      await other.query(`SELECT pg_advisory_unlock(hashtext('ff_stopped_changes'))`);
    } finally {
      await other.release();
    }

    expect(await sweeper.sweep()).toEqual({ ended: 1, rolledOut: 1, failures: 0 });
  });
});

/**
 * L2: the renewal of functions' keys (ADR 0014, 5), on a real PostgreSQL, the
 * cluster a stand-in that keeps what each Deployment's template holds: a
 * running function's key renewed at half its life, its Deployments rolled
 * onto the new one in turn, each waited for, and the old one revoked by the
 * turn after; an idle function left to its start from zero; a lasting key,
 * made before keys ended, renewed even at zero; a Deployment an update holds
 * left to it; a failure counted, the others renewed. Each run works in a
 * scratch database, dropped afterwards.
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
import { FunctionWorkload, Orchestrator, WorkloadInstances } from '../orchestrator/orchestrator.types';
import { onePlan } from '../plans/test-fixtures';
import { Bucket } from '../storage/bucket.entity';
import { FunctionKeys } from '../storage/function-keys.service';
import { StorageDirectory } from '../storage/storage-directory.service';
import { StorageKey } from '../storage/storage-key.entity';
import { FunctionEnvironment } from './entities/function-environment.entity';
import { FunctionInvocation } from './entities/function-invocation.entity';
import { FunctionVersion } from './entities/function-version.entity';
import { Function, Runtime } from './entities/function.entity';
import { EnvironmentStore } from './environment.store';
import { FunctionsService } from './functions.service';
import { FunctionKeyRenewal } from './key-renewal.service';
import { noPackages } from './test-fixtures';
import { FunctionVersionsService } from './versions.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '400000000031';

/** The cluster as the renewal reads and writes it: each Deployment's instances, and what its template holds. */
class StandInCluster {
  readonly deployments = new Map<string, WorkloadInstances>();
  /** What was asked, in order: `renew <name>`, `wait <name>`. */
  readonly asked: string[] = [];
  /** A function whose rollout the cluster refuses. */
  refusing?: string;

  static nameOf(fn: Pick<FunctionWorkload, 'id' | 'version'>): string {
    return fn.version === undefined ? fn.id : `${fn.id}-v${fn.version}`;
  }

  /** The Deployment of the workload, as the workload's template makes it. */
  hold(fn: FunctionWorkload, desired = 1): void {
    this.deployments.set(StandInCluster.nameOf(fn), {
      functionId: fn.id,
      version: fn.version,
      desired,
      ready: desired,
      revision: fn.environment?.revision,
      codeImage: fn.codeImage,
    });
  }

  of(fn: Pick<FunctionWorkload, 'id' | 'version'>): WorkloadInstances | undefined {
    return this.deployments.get(StandInCluster.nameOf(fn));
  }

  orchestrator(): Orchestrator {
    return {
      deploy: async (fn: FunctionWorkload) => this.hold(fn),
      update: async (fn: FunctionWorkload) => this.hold(fn, this.of(fn)?.desired ?? 1),
      deployVersion: async (fn: FunctionWorkload) => this.hold(fn),
      labelLatest: async () => undefined,
      waitUntilReady: async (fn: FunctionWorkload) => void this.asked.push(`wait ${StandInCluster.nameOf(fn)}`),
      workloads: async () => [...this.deployments.values()],
      renewEnvironment: async (fn: FunctionWorkload) => {
        if (fn.id === this.refusing) throw new Error('the API server is down');
        const held = this.of(fn);
        if (!held) return false;
        this.asked.push(`renew ${StandInCluster.nameOf(fn)}`);
        this.hold(fn, held.desired);
        return true;
      },
    } as unknown as Orchestrator;
  }
}

run("the renewal of functions' keys (L2)", () => {
  let db: ScratchDatabase;
  let cluster: StandInCluster;
  let keys: FunctionKeys;
  let functions: FunctionsService;
  let versions: FunctionVersionsService;
  let renewal: FunctionKeyRenewal;

  const body = (name: string) => ({ name, runtime: Runtime.NODEJS, code: 'exports.handler = async () => 1;', memory: 128, timeout: 5, environment: { TABLE: 'orders' } });
  const query = <T>(sql: string, parameters: unknown[] = []) => db.dataSource.query<T>(sql, parameters);
  /** The function's keys, oldest first: which are current, replaced, revoked. */
  const keysOf = (functionId: string) =>
    query<Array<{ id: string; replaced: boolean; revoked: boolean; life: number }>>(
      `SELECT id, replaced_at IS NOT NULL AS replaced, revoked_at IS NOT NULL AS revoked, extract(epoch FROM expires_at - created_at)::int AS life
         FROM storage_keys WHERE function_id = $1 ORDER BY created_at, replaced_at NULLS LAST`,
      [functionId],
    );
  /** Its current key past half its life, as six hours and a minute after it was made. */
  const age = (functionId: string) =>
    query(`UPDATE storage_keys SET created_at = now() - interval '6 hours 1 minute', expires_at = now() + interval '5 hours 59 minutes' WHERE function_id = $1 AND replaced_at IS NULL`, [
      functionId,
    ]);
  /** Its current key lasting, as one made before keys ended: no end. */
  const lasting = (functionId: string) => query(`UPDATE storage_keys SET expires_at = NULL WHERE function_id = $1 AND replaced_at IS NULL`, [functionId]);
  /** The key ID a Deployment's template holds, from its revision: the environment's, then the key's. */
  const heldKey = (fn: Pick<FunctionWorkload, 'id' | 'version'>) => cluster.of(fn)?.revision?.split('.').at(-1);

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    await db.dataSource.getRepository(Account).save({ id: ACCOUNT, name: 'Renewals', planId: 'beta', status: AccountStatus.ACTIVE });
    const encryption = new EncryptionService({ getOrThrow: () => [{ id: 'test', key: randomBytes(32) }] } as unknown as ConfigService);
    const store = new EnvironmentStore(db.dataSource.getRepository(FunctionEnvironment), encryption);
    const audit = new AuditService(db.dataSource.getRepository(AuditEntry));
    const directory = new StorageDirectory(db.dataSource.getRepository(Bucket), db.dataSource.getRepository(StorageKey), encryption);
    // The front door has an address for functions, so each gets a key.
    const endpoints = new ConfigService({ storage: { region: 'tn-tunis-1', functionEndpoint: 'http://10.43.0.251:3002' }, sqs: {}, ses: {} });
    keys = new FunctionKeys(db.dataSource.getRepository(StorageKey), directory, endpoints);
    cluster = new StandInCluster();
    const orchestrator = cluster.orchestrator();
    const [packages, images] = noPackages();
    functions = new FunctionsService(
      db.dataSource.getRepository(Function),
      db.dataSource.getRepository(FunctionInvocation),
      { uploadCode: async () => undefined, deleteCode: async () => undefined } as never,
      orchestrator,
      { get: (_key: string, fallback?: unknown) => fallback } as unknown as ConfigService,
      {} as never, // no invocations here: no metrics
      onePlan(),
      audit,
      {} as never, // no invocations: no usage records
      {} as never, // nor a balance check
      store,
      packages,
      images,
      keys,
    );
    versions = new FunctionVersionsService(db.dataSource.getRepository(FunctionVersion), functions, store, packages, audit, orchestrator, { getOrThrow: () => 'tn-tunis-1' } as unknown as ConfigService);
    renewal = new FunctionKeyRenewal(db.dataSource, keys, functions, orchestrator, new ConfigService({}));
  });

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await query('DELETE FROM functions');
    await query('DELETE FROM storage_keys');
    cluster.deployments.clear();
    cluster.asked.length = 0;
    cluster.refusing = undefined;
  });

  it("renews a running function's key at half its life: each Deployment rolled onto the new one in turn, each waited for; the turn after revokes the old one", async () => {
    const fn = await functions.create(ACCOUNT, body('busy'));
    await versions.publish(ACCOUNT, fn.id, {});
    cluster.hold((await functions.runningWorkload(fn.id, 1))!);
    const [old] = await keysOf(fn.id);
    expect([heldKey(fn), heldKey({ id: fn.id, version: 1 }), old.life]).toEqual([old.id, old.id, 12 * 3600]);
    await age(fn.id);
    cluster.asked.length = 0; // the create's wait

    expect(await renewal.renewDue()).toEqual({ rolled: 2, revoked: 0, waiting: 0, failures: 0 });

    const [replaced, current] = await keysOf(fn.id);
    expect([replaced, current]).toEqual([
      { id: old.id, replaced: true, revoked: false, life: expect.any(Number) },
      { id: expect.not.stringMatching(old.id), replaced: false, revoked: false, life: 12 * 3600 },
    ]);
    expect(cluster.asked).toEqual([`renew ${fn.id}`, `wait ${fn.id}`, `renew ${fn.id}-v1`, `wait ${fn.id}-v1`]);
    expect([heldKey(fn), heldKey({ id: fn.id, version: 1 })]).toEqual([current.id, current.id]);
    // Its environment and code as they were: only the key changed.
    expect(cluster.of(fn)?.revision?.split('.')[0]).toMatch(/^[0-9a-f]{16}$/);

    expect(await renewal.renewDue()).toEqual({ rolled: 0, revoked: 1, waiting: 0, failures: 0 });
    expect((await keysOf(fn.id)).map((key) => [key.id, key.revoked])).toEqual([
      [old.id, true],
      [current.id, false],
    ]);
    expect(await renewal.renewDue()).toEqual({ rolled: 0, revoked: 0, waiting: 0, failures: 0 });
  });

  it('leaves an idle function to its start from zero, whose workload has a fresh key; then gives its template the key, and revokes the old one', async () => {
    const fn = await functions.create(ACCOUNT, body('idle'));
    cluster.hold((await functions.runningWorkload(fn.id))!, 0);
    await age(fn.id);
    const [old] = await keysOf(fn.id);
    cluster.asked.length = 0;

    expect(await renewal.renewDue()).toEqual({ rolled: 0, revoked: 0, waiting: 0, failures: 0 });
    expect(await keys.isDue(fn.id)).toBe(true);

    // Its call starts it from zero with what this gives, the key renewed now.
    const started = await functions.runningWorkload(fn.id);
    expect(started?.environment?.values.AWS_ACCESS_KEY_ID).not.toBe(old.id);
    expect(await renewal.renewDue()).toEqual({ rolled: 1, revoked: 0, waiting: 0, failures: 0 });
    expect(heldKey(fn)).toBe(started?.environment?.values.AWS_ACCESS_KEY_ID);
    expect(await renewal.renewDue()).toEqual({ rolled: 0, revoked: 1, waiting: 0, failures: 0 });
  });

  it('renews a lasting key at the first turn, even for a function at zero, its template written with no pod started; and revokes it at the next', async () => {
    const fn = await functions.create(ACCOUNT, body('lasting'));
    cluster.hold((await functions.runningWorkload(fn.id))!, 0);
    await lasting(fn.id);
    const [old] = await keysOf(fn.id);
    expect(old.life).toBeNull();
    cluster.asked.length = 0;

    expect(await renewal.renewDue()).toEqual({ rolled: 1, revoked: 0, waiting: 0, failures: 0 });

    const [replaced, current] = await keysOf(fn.id);
    expect([replaced, current]).toEqual([
      { id: old.id, replaced: true, revoked: false, life: null },
      { id: expect.not.stringMatching(old.id), replaced: false, revoked: false, life: 12 * 3600 },
    ]);
    expect(cluster.asked).toEqual([`renew ${fn.id}`, `wait ${fn.id}`]);
    expect([heldKey(fn), cluster.of(fn)?.desired]).toEqual([current.id, 0]);

    expect(await renewal.renewDue()).toEqual({ rolled: 0, revoked: 1, waiting: 0, failures: 0 });
    expect((await keysOf(fn.id)).map((key) => key.revoked)).toEqual([true, false]);
    expect(await renewal.renewDue()).toEqual({ rolled: 0, revoked: 0, waiting: 0, failures: 0 });
  });

  it("revokes at once the lasting key of a function with no Deployment, which no pod holds: its next rollout makes it one that ends", async () => {
    const fn = await functions.create(ACCOUNT, body('gone'));
    cluster.deployments.clear();
    await lasting(fn.id);
    const [old] = await keysOf(fn.id);

    expect(await renewal.renewDue()).toEqual({ rolled: 0, revoked: 1, waiting: 0, failures: 0 });
    expect(await keysOf(fn.id)).toEqual([{ id: old.id, replaced: false, revoked: true, life: null }]);

    const next = await functions.runningWorkload(fn.id);
    expect(next?.environment?.values.AWS_ACCESS_KEY_ID).not.toBe(old.id);
    expect((await keysOf(fn.id)).map((key) => key.life)).toEqual([null, 12 * 3600]);
    expect(await renewal.renewDue()).toEqual({ rolled: 0, revoked: 0, waiting: 0, failures: 0 });
  });

  it("leaves a Deployment an update is rolling out to it, revoking nothing; and rolls it once it runs the function's code again", async () => {
    const fn = await functions.create(ACCOUNT, body('changing'));
    const running = (await functions.runningWorkload(fn.id))!;
    cluster.hold({ ...running, codeImage: 'registry.test/other@sha256:00' });
    await age(fn.id);
    cluster.asked.length = 0;

    expect(await renewal.renewDue()).toEqual({ rolled: 0, revoked: 0, waiting: 1, failures: 0 });
    expect(cluster.asked).toEqual([]);
    const [old] = await keysOf(fn.id);
    expect(old).toMatchObject({ replaced: true, revoked: false });

    // The update done, with the key it was given before the renewal.
    cluster.hold(running);
    expect(await renewal.renewDue()).toEqual({ rolled: 1, revoked: 0, waiting: 0, failures: 0 });
    expect(await renewal.renewDue()).toEqual({ rolled: 0, revoked: 1, waiting: 0, failures: 0 });
  });

  it("counts a function the cluster won't roll as a failure, revoking nothing of it, and renews the others", async () => {
    const refused = await functions.create(ACCOUNT, body('refused'));
    const renewed = await functions.create(ACCOUNT, body('renewed'));
    await age(refused.id);
    await age(renewed.id);
    cluster.refusing = refused.id;

    expect(await renewal.renewDue()).toEqual({ rolled: 1, revoked: 0, waiting: 0, failures: 1 });
    expect(await renewal.renewDue()).toEqual({ rolled: 0, revoked: 1, waiting: 0, failures: 1 });
    expect((await keysOf(refused.id)).map((key) => key.revoked)).toEqual([false, false]);
  });

  it("leaves a function that isn't ACTIVE: its change, or its failure, holds its pods", async () => {
    const fn = await functions.create(ACCOUNT, body('broken'));
    await query(`UPDATE functions SET status = 'ERROR' WHERE id = $1`, [fn.id]);
    await age(fn.id);

    expect(await renewal.renewDue()).toEqual({ rolled: 0, revoked: 0, waiting: 1, failures: 0 });
    expect(await keysOf(fn.id)).toEqual([expect.objectContaining({ replaced: false, revoked: false })]);
  });
});

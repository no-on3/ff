// Shared by the L3 suites that drive FunctionsService against the dev cluster
// (not part of the build: tsconfig.build.json excludes test-fixtures.ts).
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FindOperator } from 'typeorm';
import { awsEndpointsOf } from '../common/aws-endpoint';
import { EventFormat, Function, FunctionStatus, PackageType, Runtime } from './entities/function.entity';
import { FunctionEnvironmentValues, NO_ENVIRONMENT, isEmpty } from './environment';
import type { EnvironmentStore } from './environment.store';
import { InlinePackage, inlinePackage } from './inline-package';
import { codeRepository, pushCodeImage } from '../packages/code-images.service';
import type { CodeImagesService } from '../packages/code-images.service';
import { FunctionKeys } from '../storage/function-keys.service';
import type { PackagesService } from '../packages/packages.service';
import { Registry } from '../packages/registry';

/** The column defaults of a new function, as the database sets them (see the migrations). */
export const FUNCTION_DEFAULTS: Partial<Function> = {
  status: FunctionStatus.CREATING,
  minInstances: 0,
  maxInstances: 3,
  scaleToZero: true,
  eventFormat: EventFormat.LAMBDA,
  packageType: PackageType.INLINE,
  handler: 'function.handler',
  awsEndpoints: awsEndpointsOf(),
};


/**
 * A repository that keeps rows in memory and, like a database, hands out copies
 * and fills in column defaults (pass the entity's, e.g. FUNCTION_DEFAULTS).
 */
export class MemoryRepository<T extends { id?: string }> {
  readonly rows = new Map<string, T>();

  constructor(private readonly defaults: Partial<T> = {}) {}

  create(values: Partial<T>): T {
    return { ...this.defaults, ...values } as T;
  }

  async save(entity: T): Promise<T> {
    entity.id ??= randomUUID();
    Object.assign(entity, { updatedAt: new Date() });
    this.rows.set(entity.id, { ...entity });
    return entity;
  }

  /**
   * A new row, as Repository.insert writes it, without save()'s lookup first: the ID and the creation's time, which
   * the database makes, set on the entity as TypeORM sets them.
   */
  async insert(entity: T): Promise<void> {
    entity.id ??= randomUUID();
    const now = new Date();
    Object.assign(entity, { createdAt: (entity as { createdAt?: Date }).createdAt ?? now, updatedAt: now });
    this.rows.set(entity.id, { ...entity });
  }

  /** The first row whose fields equal every value of `where`, as the account-scoped queries need (P-10). */
  async findOne(options: { where: Partial<T> }): Promise<T | null> {
    const [row] = await this.find(options);
    return row ?? null;
  }

  /** Rows whose fields equal every value of `where`, or differ from it for a Not(), as the name checks ask. */
  async find(options: { where?: Partial<T> } = {}): Promise<T[]> {
    const where = Object.entries(options.where ?? {});
    const matches = (actual: unknown, wanted: unknown) =>
      wanted instanceof FindOperator ? wanted.type === 'not' && actual !== wanted.value : actual === wanted;
    return [...this.rows.values()]
      .filter((row) => where.every(([key, value]) => matches((row as Record<string, unknown>)[key], value)))
      .map((row) => ({ ...row }));
  }

  /** Whether a row matches, as the name checks ask: EntityManager.existsBy. */
  async existsBy(_target: unknown, where: Partial<T>): Promise<boolean> {
    return (await this.find({ where })).length > 0;
  }

  /**
   * Enough of TypeORM's EntityManager for FunctionsService's transactions, the
   * create and the end of an invocation (P-20): one process, so locks are ignored.
   */
  get manager() {
    return {
      existsBy: (target: unknown, where: Partial<T>) => this.existsBy(target, where),
      // Another table's rows, such as a function's versions: this repository holds none.
      find: async () => [],
      transaction: async <R>(work: (manager: unknown) => Promise<R>): Promise<R> =>
        work({
          query: async () => [],
          countBy: async (_target: unknown, where: Partial<T>) => (await this.find({ where })).length,
          existsBy: (target: unknown, where: Partial<T>) => this.existsBy(target, where),
          findOne: async (_target: unknown, options: { where: Partial<T> }) => this.findOne(options),
          save: async (_target: unknown, entity: T) => this.save(entity),
        }),
    };
  }

  async remove(entity: T): Promise<T> {
    this.rows.delete(entity.id as string);
    return entity;
  }

  byName(name: string): T {
    const row = [...this.rows.values()].find((r) => (r as { name?: string }).name === name);
    if (!row) throw new Error(`no record named ${name}`);
    return { ...row };
  }
}

export async function eventually(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/**
 * Functions' environments kept in memory, unsealed, for the suites that don't
 * test how they are stored: what each function was saved with, by its ID.
 */
export function memoryEnvironments(): EnvironmentStore & { saved: Map<string, FunctionEnvironmentValues> } {
  const saved = new Map<string, FunctionEnvironmentValues>();
  const store = {
    saved,
    load: async (functionId: string) => saved.get(functionId) ?? NO_ENVIRONMENT,
    save: async (fn: { id: string }, environment: FunctionEnvironmentValues) => {
      if (isEmpty(environment)) saved.delete(fn.id);
      else saved.set(fn.id, environment);
    },
  };
  return store as unknown as EnvironmentStore & { saved: Map<string, FunctionEnvironmentValues> };
}

const noUpload = () => {
  throw new Error('this test uploads no package');
};
/** What a test's packages service has of uploads: none to name, and none of the account's code counted against its plan. */
const NO_UPLOADS = { name: noUpload, namedBytes: async () => 0 };

/** FF without functions' keys to buckets, as where the front door has no address for functions: none made, none to revoke. */
export function noFunctionKeys(): FunctionKeys {
  return { credentialsFor: async () => undefined, revoke: async () => undefined } as unknown as FunctionKeys;
}

/**
 * The packages and code images of a FunctionsService whose orchestrator is a
 * fake, which never pulls an image: inline code's image is a name, made up of
 * its package's SHA-256, and no function names an uploaded package.
 */
export function noPackages(): [PackagesService, CodeImagesService] {
  const images = {
    assertAvailable: () => undefined,
    imageFor: async (accountId: string, codeSha256: string) =>
      `registry.test/${codeRepository(accountId)}@sha256:${Buffer.from(codeSha256, 'base64').toString('hex')}`,
  };
  return [{ ...NO_UPLOADS, storeInline: async () => undefined } as unknown as PackagesService, images as unknown as CodeImagesService];
}

/** The development registry, which hack/k8s/registry-up.sh runs, as the backend pushes to it and the cluster's node pulls from it. */
const DEV_REGISTRY = process.env.FF_CODE_REGISTRY ?? 'http://127.0.0.1:5056';
const DEV_REGISTRY_PULL = process.env.FF_CODE_REGISTRY_PULL ?? 'ff-dev-registry:5000';

/** Pushes a package's image to the development registry: its reference, by digest, as the node pulls it. */
async function pushToDevRegistry(accountId: string, built: Pick<InlinePackage, 'zip' | 'codeSha256'>): Promise<string> {
  const work = mkdtempSync(join(tmpdir(), 'ff-test-image-'));
  try {
    const zip = join(work, 'package.zip');
    writeFileSync(zip, built.zip);
    const { digest } = await pushCodeImage(new Registry(DEV_REGISTRY), accountId, built.codeSha256, zip, work);
    return `${DEV_REGISTRY_PULL}/${codeRepository(accountId)}@${digest}`;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Inline code's image, real, in the development registry: for the cluster's tests of the orchestrator. */
export function inlineCodeImage(code: string, runtime: Runtime, accountId: string): Promise<string> {
  return pushToDevRegistry(accountId, inlinePackage(code, runtime));
}

/**
 * The packages and code images of a FunctionsService that drives the dev
 * cluster: inline code's images made and pushed to the development registry,
 * as the backend makes them, its packages kept in memory; no uploaded package.
 */
export function clusterImages(): [PackagesService, CodeImagesService] {
  const zips = new Map<string, Buffer>();
  const packages = {
    ...NO_UPLOADS,
    storeInline: async (_accountId: string, built: InlinePackage) => void zips.set(built.codeSha256, built.zip),
  };
  const images = {
    assertAvailable: () => undefined,
    imageFor: async (accountId: string, codeSha256: string) => {
      const zip = zips.get(codeSha256);
      if (!zip) throw new Error(`no package ${codeSha256} was stored`);
      return pushToDevRegistry(accountId, { zip, codeSha256 });
    },
  };
  return [packages as unknown as PackagesService, images as unknown as CodeImagesService];
}

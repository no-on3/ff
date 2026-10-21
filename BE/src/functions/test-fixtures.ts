// Shared by the L3 suites that drive FunctionsService against the dev cluster
// (not part of the build: tsconfig.build.json excludes test-fixtures.ts).
import { randomUUID } from 'node:crypto';
import { FindOperator } from 'typeorm';
import { EventFormat, Function, FunctionStatus, PackageType } from './entities/function.entity';
import { FunctionEnvironmentValues, NO_ENVIRONMENT, isEmpty } from './environment';
import type { EnvironmentStore } from './environment.store';
import type { CodeImagesService } from '../packages/code-images.service';
import type { PackagesService } from '../packages/packages.service';

/** The column defaults of a new function, as the database sets them (see the migrations). */
export const FUNCTION_DEFAULTS: Partial<Function> = {
  status: FunctionStatus.CREATING,
  minInstances: 0,
  maxInstances: 3,
  scaleToZero: true,
  eventFormat: EventFormat.LAMBDA,
  packageType: PackageType.INLINE,
  handler: 'function.handler',
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

/**
 * The packages and code images of a FunctionsService that a test runs inline
 * code with: none of its functions names a package, and asking for one says so.
 */
export function noPackages(): [PackagesService, CodeImagesService] {
  const none = () => {
    throw new Error('this test runs no package');
  };
  return [{ name: none } as unknown as PackagesService, { assertAvailable: none, imageFor: none } as unknown as CodeImagesService];
}

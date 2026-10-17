// Shared by the L3 suites that drive FunctionsService against the dev cluster
// (not part of the build: tsconfig.build.json excludes test-fixtures.ts).
import { randomUUID } from 'node:crypto';
import { Function, FunctionStatus } from './entities/function.entity';

/** The column defaults of a new function, as the database sets them (see the migrations). */
export const FUNCTION_DEFAULTS: Partial<Function> = {
  status: FunctionStatus.CREATING,
  minInstances: 0,
  maxInstances: 3,
  scaleToZero: true,
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

  /** Rows whose fields equal every value of `where`. */
  async find(options: { where?: Partial<T> } = {}): Promise<T[]> {
    const where = Object.entries(options.where ?? {});
    return [...this.rows.values()]
      .filter((row) => where.every(([key, value]) => (row as Record<string, unknown>)[key] === value))
      .map((row) => ({ ...row }));
  }

  /** Enough of TypeORM's EntityManager for FunctionsService's create transaction: one process, so no locks. */
  get manager() {
    return {
      transaction: async <R>(work: (manager: unknown) => Promise<R>): Promise<R> =>
        work({
          query: async () => [],
          countBy: async (_target: unknown, where: Partial<T>) => (await this.find({ where })).length,
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

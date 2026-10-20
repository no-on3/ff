import { DataSource, MigrationExecutor } from 'typeorm';

/** The database lags behind the code: some migrations have not run. */
export class PendingMigrationsError extends Error {
  constructor(readonly pending: string[]) {
    super(
      `The database schema is out of date: ${pending.length} migration(s) pending (${pending.join(', ')}). ` +
        'Run "npm run migration:run" (or "npm run migration:run:prod" from a build) before starting the backend.',
    );
    this.name = 'PendingMigrationsError';
  }
}

/** Names of the registered migrations that have not run on this database, oldest first. */
export async function pendingMigrations(dataSource: DataSource): Promise<string[]> {
  const pending = await new MigrationExecutor(dataSource).getPendingMigrations();
  return pending.map((migration) => migration.name);
}

/** Rejects with PendingMigrationsError unless every registered migration has run. */
export async function assertSchemaUpToDate(dataSource: DataSource): Promise<void> {
  const pending = await pendingMigrations(dataSource);
  if (pending.length > 0) throw new PendingMigrationsError(pending);
}

/**
 * The SQL that would still bring the database in line with the entities: what
 * `migration:generate` would write. Empty when the migrations and the entities agree.
 */
export async function schemaDrift(dataSource: DataSource): Promise<string[]> {
  const sql = await dataSource.driver.createSchemaBuilder().log();
  return sql.upQueries.map((query) => query.query);
}

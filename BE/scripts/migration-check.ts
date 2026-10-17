/**
 * The migration drift check: fails when the migrations don't build the schema
 * that the entities describe, that is, when `migration:generate` would write
 * anything. It creates a scratch database on the configured server (DB_*
 * variables, BE/.env in development), runs every migration there, asks TypeORM
 * what it would still change, and drops the database. The configured database
 * itself is never touched.
 *   npm run migration:check      exit 0: no drift; 1: drift; 2: could not check
 */
import 'dotenv/config';
import { describeError } from '../src/common/describe-error';
import configuration from '../src/config/configuration';
import { withScratchDatabase } from '../src/database/scratch-database';
import { schemaDrift } from '../src/database/schema-check';

async function main(): Promise<number> {
  return withScratchDatabase(configuration().database, 'ff_check', async (dataSource) => {
    const ran = await dataSource.runMigrations({ transaction: 'each' });
    const drift = await schemaDrift(dataSource);
    if (drift.length === 0) {
      console.log(`migration:check OK: ${ran.length} migration(s) build exactly the schema of the entities`);
      return 0;
    }
    console.error(
      `migration:check FAILED: after ${ran.length} migration(s), the entities still need:\n` +
        drift.map((query) => `  ${query};`).join('\n') +
        '\nWrite a migration (npm run migration:generate -- src/migrations/<Name>) and add it to src/migrations/index.ts.',
    );
    return 1;
  });
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`migration:check could not run: ${describeError(error)}`);
    process.exit(2);
  },
);

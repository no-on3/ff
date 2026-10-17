import { DataSourceOptions } from 'typeorm';
import { MIGRATIONS } from '../migrations';
import { ENTITIES } from './entities';
import { SnakeNamingStrategy } from './naming.strategy';

/** The `database` block of the configuration (src/config/configuration.ts). */
export interface DatabaseSettings {
  host: string;
  port: number;
  username: string;
  password: string;
  name: string;
  logging: boolean;
}

/**
 * The one definition of the database connection, shared by the backend
 * (AppModule) and the TypeORM CLI (data-source.ts), so both see the same
 * entities, migrations and naming.
 */
export function dataSourceOptions(settings: DatabaseSettings): DataSourceOptions {
  return {
    type: 'postgres',
    host: settings.host,
    port: settings.port,
    username: settings.username,
    password: settings.password,
    database: settings.name,
    entities: ENTITIES,
    migrations: MIGRATIONS,
    namingStrategy: new SnakeNamingStrategy(),
    // The schema comes only from migrations, in every environment: they run as a
    // separate step (npm run migration:run), and the backend refuses to start
    // while one is pending (main.ts).
    synchronize: false,
    migrationsRun: false,
    // UUID defaults use gen_random_uuid(), built into PostgreSQL 13 and newer.
    // TypeORM must not try to install an extension: managed servers may forbid it.
    uuidExtension: 'pgcrypto',
    installExtensions: false,
    logging: settings.logging,
  };
}

/**
 * The TypeORM CLI's data source. It reads the same variables as the backend
 * (BE/.env in development, the environment in a deployment):
 *   npm run migration:run          apply pending migrations (from src/, with ts-node)
 *   npm run migration:run:prod     the same from the build (dist/), as a deploy step does
 *   npm run migration:revert       undo the last migration
 *   npm run migration:show         list migrations, [X] when applied
 *   npm run migration:generate -- src/migrations/<Name>
 */
import 'dotenv/config';
import { DataSource } from 'typeorm';
import configuration from '../config/configuration';
import { dataSourceOptions } from './database.options';

export default new DataSource(dataSourceOptions(configuration().database));

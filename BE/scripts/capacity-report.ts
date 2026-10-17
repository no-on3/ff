/**
 * The capacity report (client-readiness plan, P-21, D8): per account and UTC
 * day, the GB-s that FF's servers held for the account's ready instances,
 * against the GB-s its usage records bill. It is the input for D8's prices,
 * until the admin dashboard shows it (P-75). It only reads, from the
 * configured database (DB_* variables, BE/.env in development).
 *   npm run capacity:report [-- --days 7]      the last 7 days, today included
 */
import 'dotenv/config';
import { DataSource } from 'typeorm';
import { describeError } from '../src/common/describe-error';
import { databaseConfiguration } from '../src/config/configuration';
import { dataSourceOptions } from '../src/database/database.options';
import { capacityReport, formatCapacityReport, parseReportArgs, reportWindow } from '../src/usage/capacity-report';

async function main(): Promise<void> {
  const { days } = parseReportArgs(process.argv.slice(2));
  const { from, to } = reportWindow(new Date(), days);
  const dataSource = new DataSource({ ...dataSourceOptions(databaseConfiguration()), logging: false });
  await dataSource.initialize();
  try {
    console.log(`Capacity reserved against capacity billed, ${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)} (excluded), UTC:\n`);
    console.log(formatCapacityReport(await capacityReport(dataSource, from, to)));
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(`capacity:report could not run: ${describeError(error)}`);
  process.exit(1);
});

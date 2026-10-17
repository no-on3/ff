/**
 * The billing reconciliation (client-readiness plan, P-32, parent B-01): per
 * account, what the hourly rating charged in a month, shadow or debited,
 * against the same hours priced from the raw usage records and samples. Two
 * weeks of "All accounts agree" in shadow mode is D9's signal to start
 * debiting. It only reads, from the configured database (DB_* variables,
 * BE/.env in development), and exits 1 when an account differs.
 *   npm run billing:reconcile [-- --month 2026-10]      this month by default, UTC
 */
import 'dotenv/config';
import { DataSource } from 'typeorm';
import { Currency } from '../src/billing/currency.entity';
import { PriceBook } from '../src/billing/price-book.entity';
import { PricingService } from '../src/billing/pricing.service';
import { formatReconciliation, reconcile, reconciled } from '../src/billing/reconciliation';
import { describeError } from '../src/common/describe-error';
import { databaseConfiguration } from '../src/config/configuration';
import { dataSourceOptions } from '../src/database/database.options';

function monthArgument(args: string[]): string {
  const index = args.indexOf('--month');
  const month = index >= 0 ? args[index + 1] : new Date().toISOString().slice(0, 7);
  if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`--month takes a month as YYYY-MM, not ${month ?? 'nothing'}`);
  return month;
}

async function main(): Promise<void> {
  const month = monthArgument(process.argv.slice(2));
  const dataSource = new DataSource({ ...dataSourceOptions(databaseConfiguration()), logging: false });
  await dataSource.initialize();
  try {
    const pricing = new PricingService(dataSource.getRepository(PriceBook), dataSource.getRepository(Currency));
    const result = await reconcile(dataSource, pricing, month);
    console.log(formatReconciliation(result));
    if (result.accounts.some((account) => !reconciled(account))) process.exitCode = 1;
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(`billing:reconcile could not run: ${describeError(error)}`);
  process.exit(1);
});

import { EntityManager } from 'typeorm';
import { TaxKind } from './tax-rate.entity';

/** The VAT rate in force on a day in Tunisia, YYYY-MM-DD (P-36: tax rates are dated data, parent §8.6). */
export async function vatPercentOn(manager: EntityManager, day: string): Promise<number> {
  const [rate] = await manager.query<Array<{ percent: number }>>(
    `SELECT "percent" FROM "tax_rates" WHERE "kind" = $1 AND "valid_from" <= $2 ORDER BY "valid_from" DESC LIMIT 1`,
    [TaxKind.VAT, day],
  );
  if (!rate) throw new Error(`No VAT rate applies on ${day}: add one to tax_rates`);
  return rate.percent;
}

/** The stamp duty on an invoice issued on a day in Tunisia, in minor units of its currency. */
export async function stampDutyOn(manager: EntityManager, day: string, currency: string): Promise<bigint> {
  const [rate] = await manager.query<Array<{ amount: string; currency: string }>>(
    `SELECT "amount_minor"::text AS "amount", "currency" FROM "tax_rates" WHERE "kind" = $1 AND "valid_from" <= $2 ORDER BY "valid_from" DESC LIMIT 1`,
    [TaxKind.STAMP_DUTY, day],
  );
  if (!rate) throw new Error(`No stamp duty applies on ${day}: add one to tax_rates`);
  if (rate.currency !== currency) throw new Error(`The stamp duty on ${day} is in ${rate.currency}, not ${currency}`);
  return BigInt(rate.amount);
}

import { AccountEstimate } from '../billing/pricing.service';
import { DatabaseMonth, MonthlyUsageView, UsageMonth } from './usage.dto';

const NO_CALLS = { requests: 0, billedMs: 0, gbSeconds: '0', throttled: 0, platformErrors: 0, lost: 0 };

/** The functions that cost something in the month without a call, such as minInstances held: they need a line, with a name. */
export function unlisted(month: UsageMonth, estimate: AccountEstimate | null): string[] {
  if (!estimate) return [];
  const listed = new Set(month.functions.map((fn) => fn.functionId));
  return [...estimate.functions].filter(([id, cost]) => !listed.has(id) && !cost.total.isZero()).map(([id]) => id);
}

/**
 * The month's usage with its estimated cost (P-30): each function's and each
 * database's, before the free tier, and the account's estimate, each amount
 * rounded once to the currency's minor unit. `names` names the unlisted
 * functions that still exist; the others were deleted.
 */
export function withEstimate(month: UsageMonth, estimate: AccountEstimate | null, names: Map<string, string>, databases: DatabaseMonth[] = []): MonthlyUsageView {
  if (!estimate) {
    return { ...month, functions: month.functions.map((fn) => ({ ...fn, cost: null })), databases: databases.map((database) => ({ ...database, cost: null })), estimate: null };
  }
  const places = estimate.exponent;
  const cost = (functionId: string) => estimate.functions.get(functionId)?.total.toFixed(places) ?? (0).toFixed(places);
  const stored = (databaseId: string) => estimate.resources.get(databaseId)?.total.toFixed(places) ?? (0).toFixed(places);
  return {
    ...month,
    functions: [
      ...month.functions.map((fn) => ({ ...fn, cost: cost(fn.functionId) })),
      ...unlisted(month, estimate).map((functionId) => ({
        functionId,
        functionName: names.get(functionId) ?? '',
        deleted: !names.has(functionId),
        ...NO_CALLS,
        cost: cost(functionId),
      })),
    ],
    databases: databases.map((database) => ({ ...database, cost: stored(database.databaseId) })),
    estimate: {
      currency: estimate.currency,
      usage: estimate.usage.toFixed(places),
      freeTier: estimate.freeTier.toFixed(places),
      volumeTiers: estimate.volumeTiers.toFixed(places),
      monthlyFee: estimate.monthlyFee.toFixed(places),
      total: estimate.total.toFixed(places),
      pricedFrom: estimate.pricedFrom,
      priceBooks: estimate.books.map((book) => book.id),
    },
  };
}

import { LIMIT_FIELDS, quotaLabel } from './plans';
import { SETTINGS, describeSetting } from './settings';
import { whenUtc } from './time';
import { TableQuery, pageParams } from './table';

/**
 * What operators do, as the audit log names it (P-70, P-76), with what the
 * dashboard calls each. contract.test.ts checks each against the API's
 * actions; P-71 and the tasks after it add theirs.
 */
export const OPERATOR_ACTIONS: Array<{ value: string; label: string }> = [
  { value: 'account.approve', label: 'Account approved' },
  { value: 'account.reject', label: 'Account rejected' },
  { value: 'account.suspend', label: 'Account suspended' },
  { value: 'account.reactivate', label: 'Account reactivated' },
  { value: 'account.close', label: 'Account closed' },
  { value: 'account.plan', label: 'Account moved to a plan' },
  { value: 'account.egress', label: 'Internet egress changed' },
  { value: 'payment.record', label: 'Bank transfer recorded' },
  { value: 'payment.withholding', label: 'Withholding certificate added' },
  { value: 'invoice.issue', label: 'Invoice issued' },
  { value: 'invoice.credit_note', label: 'Credit note issued' },
  { value: 'credit.promo', label: 'Promotional credit granted' },
  { value: 'credit.adjustment', label: 'Credit corrected' },
  { value: 'plan.create', label: 'Plan created' },
  { value: 'plan.update', label: 'Plan changed' },
  { value: 'price_book.create', label: 'Price book created' },
  { value: 'price_book.delete', label: 'Price book removed' },
  { value: 'settings.update', label: 'Settings changed' },
];

/** One operator action, as GET /admin/audit-log gives it. */
export interface OperatorAction {
  id: string;
  at: string;
  operator: { id: string; email: string };
  action: string;
  accountId: string | null;
  resource: string | null;
  reason: string | null;
  details: Record<string, unknown> | null;
  ip: string | null;
  requestId: string | null;
}

/** The day after a YYYY-MM-DD date: a filter's "to" day is included. */
function nextDay(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

/**
 * The page's query parameters: the filters set, with the "from" and "to"
 * days (UTC) as instants, "to" included, then the page.
 */
export function auditParams(query: TableQuery, before: string | null): Record<string, string> {
  const { from, to, ...rest } = query.filters;
  const params = pageParams({ search: '', filters: rest }, before);
  if (from) params.from = `${from}T00:00:00Z`;
  if (to) params.to = `${nextDay(to)}T00:00:00Z`;
  return params;
}

/** The filters without the page, for the CSV: it holds the newest of everything that matches. */
export function exportParams(query: TableQuery): Record<string, string> {
  const params = auditParams(query, null);
  delete params.limit;
  return params;
}

/** A value of a change the page knows nothing about: none, as JSON when it has parts, else as it is. */
const shown = (value: unknown): string => {
  if (value === null || value === undefined) return 'none';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
};

/** What an account's changes are called (P-71), and how their values read. */
const ACCOUNT_FIELDS: Record<string, { label: string; value?: (value: unknown) => string }> = {
  status: { label: 'Status' },
  planId: { label: 'Plan' },
  internetEgress: { label: 'Internet egress', value: (value) => (value === true ? 'on' : value === false ? 'off' : shown(value)) },
};

/** A plan's limits by name (P-73); its quota in one line. A plan's name changes too. */
const PLAN_FIELDS: Record<string, { label: string; value?: (value: unknown) => string }> = {
  ...Object.fromEntries(LIMIT_FIELDS.filter(({ path }) => path.length === 1).map(({ path, label }) => [path[0], { label }])),
  quota: { label: 'Quota', value: (value) => (value && typeof value === 'object' ? quotaLabel(value as Parameters<typeof quotaLabel>[0]) : shown(value)) },
  name: { label: 'Name' },
};

/**
 * One change, from → to: a setting by its label, as the Settings page shows
 * it; an account's status, plan or egress by name; anything else as the API
 * names it.
 */
function describeChange(name: string, { from, to }: { from: unknown; to: unknown }): string {
  const field = ACCOUNT_FIELDS[name] ?? PLAN_FIELDS[name];
  if (field) return `${field.label}: ${(field.value ?? shown)(from)} → ${(field.value ?? shown)(to)}`;
  const setting = SETTINGS.find((known) => known.key === name);
  if (!setting) return `${name}: ${shown(from)} → ${shown(to)}`;
  // An old entry may hold a value of another shape: shown as it is, never a broken page.
  const value = (v: unknown) => (setting.kind === 'percents' && !Array.isArray(v) ? shown(v) : describeSetting(setting.kind, v));
  return `${setting.label}: ${value(from)} → ${value(to)}`;
}

/** A payment's step, by its reference: the pro-forma asked for, the transfer recorded, the certificate added. */
function describePayment(details: Record<string, unknown>): string {
  const money = (name: string) => `${shown(details[name])} ${shown(details.currency)}`;
  const zero = (name: string) => /^0(\.0+)?$/.test(String(details[name]));
  if (details.received !== undefined) {
    return `${shown(details.reference)}: ${money('received')} received on ${shown(details.receivedOn)}${zero('withheld') ? '' : `, ${money('withheld')} withheld at source`}`;
  }
  if (details.certificate !== undefined) return `${shown(details.reference)}: certificate added, ${money('withheld')} credited`;
  if (details.total !== undefined) return `${shown(details.reference)}: pro-forma for ${money('credit')} of credit, ${money('total')} with VAT`;
  return shown(details.reference);
}

/** An invoice by its number: its month, total and stamp duty; a credit note, the invoice it corrects. */
function describeInvoice(details: Record<string, unknown>): string {
  const money = (name: string) => `${shown(details[name])} ${shown(details.currency)}`;
  if (details.corrects !== undefined) return `${shown(details.number)} for ${shown(details.corrects)}: ${money('total')}`;
  return `${shown(details.number)} for ${shown(details.month)}: ${money('total')}, with ${money('stampDuty')} of stamp duty`;
}

/** A grant (P-74): what it moved the balance by, and the balance it left. */
function describeCredit(details: Record<string, unknown>): string {
  const money = (name: string) => `${shown(details[name])} ${shown(details.currency)}`;
  const sign = String(details.amount).startsWith('-') ? '' : '+';
  return `${sign}${money('amount')}, leaving ${money('balance')}${details.allowDebt === true ? ', a debt allowed' : ''}`;
}

/** What an action did, to read: each change's from → to, else what it was on. */
export function describeAction(entry: Pick<OperatorAction, 'details' | 'resource'>): string {
  const changes = entry.details?.changes as Record<string, { from: unknown; to: unknown }> | undefined;
  if (changes) {
    return Object.entries(changes)
      .map(([name, change]) => describeChange(name, change))
      .join('; ');
  }
  // A price book, by when it starts (P-73).
  if (typeof entry.details?.validFrom === 'string') return `Book from ${whenUtc(entry.details.validFrom)}`;
  // A pro-forma, a transfer or a certificate, by its reference (P-35).
  if (typeof entry.details?.reference === 'string') return describePayment(entry.details);
  // An invoice or credit note, by its number (P-36).
  if (typeof entry.details?.number === 'string') return describeInvoice(entry.details);
  // A grant, by what it moved (P-74).
  if (typeof entry.details?.kind === 'string' && typeof entry.details.amount === 'string' && typeof entry.details.balance === 'string') return describeCredit(entry.details);
  return entry.resource ?? '';
}

export const actionLabel = (action: string): string => OPERATOR_ACTIONS.find((known) => known.value === action)?.label ?? action;

/** The export's file name, as the API names the download. */
export const auditCsvName = (today: Date) => `ff-operator-audit-${today.toISOString().slice(0, 10)}.csv`;

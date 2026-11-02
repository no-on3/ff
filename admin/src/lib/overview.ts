import type { AccountStatus } from './accounts';

/**
 * The overview, as GET /admin/stats/overview gives it: the platform at a
 * glance, at most a minute old. contract.test.ts compares its fields with the
 * backend's OverviewView.
 */
export interface Overview {
  computedAt: string;
  accounts: { byStatus: Record<AccountStatus, number>; pendingApprovals: number };
  functions: { total: number; byStatus: Record<string, number> };
  /** Today, by the UTC calendar. */
  today: { day: string; invocations: number; errors: number; throttles: number };
  /** This month, by the UTC calendar. */
  month: string;
  money: OverviewMoney[];
  invoices: OverviewInvoices;
  capacity: CapacityDay[];
}

/** The invoices of this month in Tunisia, where they are dated, which begins an hour before UTC's; and last month's to issue. */
export interface OverviewInvoices {
  month: string;
  issued: number;
  creditNotes: number;
  toIssue: { month: string; drafts: number; issuable: boolean };
}

export interface OverviewMoney {
  currency: string;
  consumption: { charged: string; debited: string; shadow: string };
  topUps: { payments: number; credit: string };
  balances: { owedByFF: string; owedToFF: string; walletsInDebt: number };
}

export interface CapacityDay {
  day: string;
  reservedGbS: number;
  provisionedGbS: number;
  billedGbS: number;
  requests: number;
}

export const OVERVIEW_FIELDS = ['computedAt', 'accounts', 'functions', 'today', 'month', 'money', 'invoices', 'capacity'] as const;
export const OVERVIEW_INVOICE_FIELDS = ['month', 'issued', 'creditNotes', 'toIssue'] as const satisfies ReadonlyArray<keyof OverviewInvoices>;

/** GB-seconds, to the thousandth, thousands apart. */
export const gbS = (value: number): string => value.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

/** How many times what it billed FF held, its cost beyond what customers pay: "nothing billed" for a day with capacity held and no call, "" for an idle day. */
export function reservedOverBilled(day: Pick<CapacityDay, 'reservedGbS' | 'billedGbS'>): string {
  if (day.billedGbS > 0) return `${Math.round(day.reservedGbS / day.billedGbS).toLocaleString('en-US')}×`;
  return day.reservedGbS > 0 ? 'nothing billed' : '';
}

/** The operator's Grafana dashboards, from the cluster's monitoring, when the build says where Grafana is. */
export function operatorDashboards(grafanaUrl: string | undefined): Array<{ title: string; url: string; about: string }> {
  if (!grafanaUrl) return [];
  return [
    { title: 'FF platform', url: `${grafanaUrl}/d/ff-platform`, about: "The backend: calls and their outcomes, durations, the API's answers, notifications, alarms, the rating" },
    { title: 'FF cluster', url: `${grafanaUrl}/d/ff-cluster`, about: "What it runs on: the nodes, the functions' and the platform's pods, the log pipeline, the alerts" },
  ];
}

/** "3 functions: 2 active, 1 in error", in the order a reader wants them. */
export function functionsLine(functions: Overview['functions']): string {
  const names: Record<string, string> = { ACTIVE: 'active', CREATING: 'being created', ERROR: 'in error' };
  const parts = ['ACTIVE', 'CREATING', 'ERROR', ...Object.keys(functions.byStatus).filter((status) => !(status in names))]
    .filter((status) => functions.byStatus[status])
    .map((status) => `${functions.byStatus[status]} ${names[status] ?? status.toLowerCase()}`);
  return `${functions.total} function${functions.total === 1 ? '' : 's'}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

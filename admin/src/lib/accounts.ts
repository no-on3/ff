import type { AccountCredit } from './credits';

/**
 * Accounts, as the admin routes give them (P-71). The statuses and the status
 * changes mirror the backend's (AccountStatus, and STATUS_CHANGES in
 * BE/src/admin/account-status-changes.ts): contract.test.ts compares them.
 */
export type AccountStatus = 'pending' | 'active' | 'rejected' | 'suspended' | 'closed';

export const ACCOUNT_STATUSES: Array<{ value: AccountStatus; label: string }> = [
  { value: 'pending', label: 'Waiting for approval' },
  { value: 'active', label: 'Active' },
  { value: 'rejected', label: 'Not approved' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'closed', label: 'Closed' },
];

export const statusLabel = (status: string): string => ACCOUNT_STATUSES.find((known) => known.value === status)?.label ?? status;

export type StatusChange = 'approve' | 'reject' | 'suspend' | 'reactivate' | 'close';

export interface StatusChangeInfo {
  from: AccountStatus[];
  to: AccountStatus;
  /** The button. */
  label: string;
  /** Once it is done. */
  done: string;
  /** What it does, said in its dialog. */
  effect: string;
  /** Whether it stops the account: the dialog says why it matters, and the e-mail gives the reason. */
  stops: boolean;
}

export const STATUS_CHANGES: Record<StatusChange, StatusChangeInfo> = {
  approve: { from: ['pending'], to: 'active', label: 'Approve', done: 'Approved', effect: 'It can deploy and invoke functions.', stops: false },
  reject: { from: ['pending'], to: 'rejected', label: 'Reject', done: 'Rejected', effect: "It won't be able to deploy or invoke functions.", stops: true },
  suspend: {
    from: ['active'],
    to: 'suspended',
    label: 'Suspend',
    done: 'Suspended',
    effect: "Its functions scale to zero at once (a call under way finishes first), and it can't deploy or invoke until it is reactivated. Nothing is deleted.",
    stops: true,
  },
  reactivate: {
    from: ['suspended'],
    to: 'active',
    label: 'Reactivate',
    done: 'Reactivated',
    effect: 'It can deploy and invoke again. Functions with warm instances get them back; the others start at their next call.',
    stops: false,
  },
  close: {
    from: ['pending', 'active', 'rejected', 'suspended'],
    to: 'closed',
    label: 'Close',
    done: 'Closed',
    effect:
      "Its functions stop, and it can't deploy or invoke again: closing is final. Its functions, their history and logs are deleted once the notice period set in Settings has passed; its usage, payments and invoices are kept.",
    stops: true,
  },
};

/** The changes that apply to an account in this status, in the order of their buttons. */
export const changesFor = (status: AccountStatus): StatusChange[] =>
  (Object.keys(STATUS_CHANGES) as StatusChange[]).filter((change) => STATUS_CHANGES[change].from.includes(status));

/** What the account's owners learn of the operator's reason (P-71). */
export const ownersSee = (change: StatusChange): string =>
  STATUS_CHANGES[change].stops
    ? 'The owners get an e-mail that gives your reason, and see it in their audit log.'
    : 'The owners get an e-mail, and see your reason in their audit log.';

/** What the page says once a change is made. */
export const changedNotice = (change: StatusChange): string => `${STATUS_CHANGES[change].done}: the owners got an e-mail.`;

export interface AccountPerson {
  email: string;
  name: string | null;
}

/** An account in GET /admin/accounts. */
export interface AccountSummary {
  id: string;
  name: string;
  status: AccountStatus;
  planId: string;
  country: string;
  taxId: string | null;
  useCase: string | null;
  internetEgress: boolean;
  createdAt: string;
  /** When a closed account's functions, their history and logs are deleted; null unless closed. */
  dataDeletionDueAt: string | null;
  /** When they were deleted; null until then. */
  dataDeletedAt: string | null;
  owners: AccountPerson[];
}

/** What the account page says of a closed account's data: when it goes, or when it went. Nothing for an account not closed. */
export function dataDeletion(account: Pick<AccountSummary, 'dataDeletionDueAt' | 'dataDeletedAt'>, when: (at: string) => string): string | null {
  if (account.dataDeletedAt) return `Its functions, their history and logs were deleted on ${when(account.dataDeletedAt)}.`;
  if (account.dataDeletionDueAt) return `Its functions, their history and logs will be deleted on ${when(account.dataDeletionDueAt)}; until then its members can read them.`;
  return null;
}

export interface UsageTotals {
  requests: number;
  billedMs: number;
  gbSeconds: string;
  throttled: number;
  platformErrors: number;
  lost: number;
}

/** GET /admin/accounts/:id, and the answer to every change. */
export interface AccountView {
  account: AccountSummary;
  members: Array<AccountPerson & { userId: string; role: 'owner' | 'developer' | 'viewer'; joinedAt: string }>;
  functions: Array<{ id: string; name: string; runtime: string; memory: number; status: string; minInstances: number; lastInvokedAt: string | null }>;
  usage: { month: string; totals: UsageTotals };
  /** Each wallet's balance (P-31), with its currency's decimals; none before the account's first credit or debit. */
  balances: Array<{ currency: string; balance: string }>;
  /** The balance in the prices' currency, read as it is now, whether invokes go on, and this month's charges (P-74). */
  credit: AccountCredit;
  statusHistory: Array<{ at: string; action: string; status: AccountStatus; by: string; reason: string | null }>;
}

/** A plan an account can move to: GET /admin/plans. */
export interface PlanOption {
  id: string;
  name: string;
}

/** The owners, to read in a table: "amira@ff.test, sami@ff.test". */
export const ownersOf = (account: Pick<AccountSummary, 'owners'>): string => account.owners.map((owner) => owner.email).join(', ') || '–';

/** Whether the text is an account ID: 12 digits. A page's address may hold anything. */
export const isAccountId = (text: string | undefined): text is string => /^\d{12}$/.test(text ?? '');

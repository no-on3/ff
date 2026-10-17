import { AccountStatus } from '../accounts/entities/account.entity';

/**
 * What an operator does to an account's status (P-71, D2): each change, the
 * statuses it applies to, and the status it gives. A new account waits for
 * approval (pending); suspending stops an active account's functions until
 * it is reactivated; closing is final, and P-45 deletes what the account
 * holds after a notice period. The admin app mirrors this table, and its
 * contract test reads this file.
 */
export const STATUS_CHANGES = {
  approve: { from: [AccountStatus.PENDING], to: AccountStatus.ACTIVE },
  reject: { from: [AccountStatus.PENDING], to: AccountStatus.REJECTED },
  suspend: { from: [AccountStatus.ACTIVE], to: AccountStatus.SUSPENDED },
  reactivate: { from: [AccountStatus.SUSPENDED], to: AccountStatus.ACTIVE },
  close: { from: [AccountStatus.PENDING, AccountStatus.ACTIVE, AccountStatus.REJECTED, AccountStatus.SUSPENDED], to: AccountStatus.CLOSED },
} as const satisfies Record<string, { from: readonly AccountStatus[]; to: AccountStatus }>;

export type StatusChange = keyof typeof STATUS_CHANGES;
export const STATUS_CHANGE_NAMES = Object.keys(STATUS_CHANGES) as StatusChange[];

/** Why a change doesn't apply to an account in this status, or null when it does. */
export function statusChangeProblem(change: StatusChange, accountId: string, status: AccountStatus): string | null {
  const rule = STATUS_CHANGES[change];
  if ((rule.from as readonly AccountStatus[]).includes(status)) return null;
  if (change === 'close') return `Account ${accountId} is already closed`;
  const needed = rule.from[0];
  return `Account ${accountId} is ${status}: only ${needed === AccountStatus.ACTIVE ? 'an' : 'a'} ${needed} account can be ${PAST[change]}`;
}

const PAST: Record<StatusChange, string> = {
  approve: 'approved',
  reject: 'rejected',
  suspend: 'suspended',
  reactivate: 'reactivated',
  close: 'closed',
};

/** Whether the account's functions must stay at zero instances in this status: it can neither deploy nor invoke, and isn't waiting to. */
export const stopsFunctions = (status: AccountStatus): boolean => status === AccountStatus.SUSPENDED || status === AccountStatus.CLOSED;

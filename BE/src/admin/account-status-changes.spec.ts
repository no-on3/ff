/**
 * L1: which status change applies to which account (client-readiness plan,
 * P-71): pending to active or rejected, active to suspended and back, any to
 * closed, and nothing else.
 */
import { AccountStatus } from '../accounts/entities/account.entity';
import { STATUS_CHANGES, STATUS_CHANGE_NAMES, StatusChange, statusChangeProblem, stopsFunctions } from './account-status-changes';

const ID = '000000000042';
const STATUSES = Object.values(AccountStatus);

describe('account status changes (L1, P-71)', () => {
  it('apply from these statuses only, each to one status', () => {
    const table = Object.fromEntries(
      STATUS_CHANGE_NAMES.map((change) => [change, STATUSES.filter((status) => statusChangeProblem(change, ID, status) === null).map((from) => `${from} → ${STATUS_CHANGES[change].to}`)]),
    );

    expect(table).toEqual({
      approve: ['pending → active'],
      reject: ['pending → rejected'],
      suspend: ['active → suspended'],
      reactivate: ['suspended → active'],
      close: ['pending → closed', 'active → closed', 'rejected → closed', 'suspended → closed'],
    });
  });

  it.each<[StatusChange, AccountStatus, string]>([
    ['approve', AccountStatus.ACTIVE, `Account ${ID} is active: only a pending account can be approved`],
    ['reject', AccountStatus.SUSPENDED, `Account ${ID} is suspended: only a pending account can be rejected`],
    ['suspend', AccountStatus.PENDING, `Account ${ID} is pending: only an active account can be suspended`],
    ['reactivate', AccountStatus.REJECTED, `Account ${ID} is rejected: only a suspended account can be reactivated`],
    ['close', AccountStatus.CLOSED, `Account ${ID} is already closed`],
  ])('say why %s does not apply to a %s account', (change, status, message) => {
    expect(statusChangeProblem(change, ID, status)).toBe(message);
  });

  it("stop the functions of a suspended or closed account, and only those", () => {
    expect(STATUSES.filter(stopsFunctions)).toEqual([AccountStatus.SUSPENDED, AccountStatus.CLOSED]);
  });
});

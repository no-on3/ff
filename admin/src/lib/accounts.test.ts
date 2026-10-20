import { describe, expect, it } from 'vitest';
import { ACCOUNT_STATUSES, AccountStatus, STATUS_CHANGES, StatusChange, changedNotice, changesFor, dataDeletion, isAccountId, ownersOf, ownersSee, statusLabel } from './accounts';

describe('the status changes an account offers (P-71)', () => {
  it('follow its status: a pending account is approved or rejected, an active one suspended, a suspended one reactivated; any but a closed one closed', () => {
    const offered = Object.fromEntries(ACCOUNT_STATUSES.map(({ value }) => [value, changesFor(value)]));

    expect(offered).toEqual({
      pending: ['approve', 'reject', 'close'],
      active: ['suspend', 'close'],
      rejected: ['close'],
      suspended: ['reactivate', 'close'],
      closed: [],
    });
  });

  it('say what was done once it is', () => {
    expect((Object.keys(STATUS_CHANGES) as StatusChange[]).map(changedNotice)).toEqual([
      'Approved: the owners got an e-mail.',
      'Rejected: the owners got an e-mail.',
      'Suspended: the owners got an e-mail.',
      'Reactivated: the owners got an e-mail.',
      'Closed: the owners got an e-mail.',
    ]);
  });

  it("tell the operator what the owners learn: the reason is in the e-mail of a change that stops the account", () => {
    expect([ownersSee('reject'), ownersSee('approve')]).toEqual([
      'The owners get an e-mail that gives your reason, and see it in their audit log.',
      'The owners get an e-mail, and see your reason in their audit log.',
    ]);
  });
});

describe('accounts, to read', () => {
  it('name each status, and show an unknown one as the API does', () => {
    expect([statusLabel('pending'), statusLabel('frozen' as AccountStatus)]).toEqual(['Waiting for approval', 'frozen']);
  });

  it('list the owners, or a dash for none', () => {
    expect([ownersOf({ owners: [{ email: 'a@ff.test', name: null }, { email: 'b@ff.test', name: 'B' }] }), ownersOf({ owners: [] })]).toEqual([
      'a@ff.test, b@ff.test',
      '–',
    ]);
  });

  it("say when a closed account's data goes, or went, and nothing for an account not closed", () => {
    const when = (at: string) => `[${at}]`;

    expect(dataDeletion({ dataDeletionDueAt: null, dataDeletedAt: null }, when)).toBeNull();
    expect(dataDeletion({ dataDeletionDueAt: '2026-11-17T10:32:00Z', dataDeletedAt: null }, when)).toBe(
      'Its functions, their history and logs will be deleted on [2026-11-17T10:32:00Z]; until then its members can read them.',
    );
    expect(dataDeletion({ dataDeletionDueAt: '2026-11-17T10:32:00Z', dataDeletedAt: '2026-11-17T11:00:04Z' }, when)).toBe(
      'Its functions, their history and logs were deleted on [2026-11-17T11:00:04Z].',
    );
  });

  it("warn, before closing, that the account's data goes after the notice period, and what stays", () => {
    expect(STATUS_CHANGES.close.effect).toContain('Its functions, their history and logs are deleted once the notice period set in Settings has passed');
    expect(STATUS_CHANGES.close.effect).toContain('its usage, payments and invoices are kept');
  });

  it('take an account ID from the address only when it is one: 12 digits', () => {
    expect(['000000000042', '42', '000000000042/../x', undefined].map(isAccountId)).toEqual([true, false, false, false]);
  });
});

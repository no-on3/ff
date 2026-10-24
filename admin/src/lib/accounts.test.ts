import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_STATUSES,
  AccountStatus,
  STATUS_CHANGES,
  StatusChange,
  bucketStorageLabel,
  changedNotice,
  changesFor,
  dataDeletion,
  formatBytes,
  formatMegabytes,
  isAccountId,
  ownersOf,
  ownersSee,
  queueMessagesLabel,
  queueStorageLabel,
  statusLabel,
  storageLabel,
} from './accounts';

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

describe("an account's databases, buckets and queues, to read", () => {
  it('says they are on, or off since when and why', () => {
    const when = (at: string) => at.slice(0, 10);
    expect(storageLabel({ storageDisabledAt: null, storageDisabledReason: null }, when)).toBe('On');
    expect(storageLabel({ storageDisabledAt: '2026-10-23T08:00:00Z', storageDisabledReason: 'Files shared against our terms' }, when)).toBe(
      'Off since 2026-10-23: Files shared against our terms',
    );
  });

  it("gives a database's size in MB to a tenth, and a dash when the server couldn't say", () => {
    expect([formatMegabytes(7_634_423), formatMegabytes(1_073_741_824), formatMegabytes(0), formatMegabytes(null)]).toEqual(['7.3 MB', '1,024 MB', '0 MB', '–']);
  });

  it("gives what a queue holds in bytes, KB under a megabyte, then MB", () => {
    expect([formatBytes(0), formatBytes(1), formatBytes(46), formatBytes(1536), formatBytes(1_048_576), formatBytes(7_634_423)]).toEqual(['0 bytes', '1 byte', '46 bytes', '1.5 KB', '1 MB', '7.3 MB']);
  });

  it("says a queue's messages, those in flight and delayed when there are some, and what the queues hold against the plan's room", () => {
    expect([queueMessagesLabel({ available: 1200, inFlight: 1, delayed: 0 }), queueMessagesLabel({ available: 0, inFlight: 0, delayed: 2 })]).toEqual([
      '1,200 waiting, 1 in flight',
      '0 waiting, 2 delayed',
    ]);
    expect(queueStorageLabel({ bytes: 2048, limitMb: 100 })).toBe("2 KB of the plan's 100 MB, its functions' calls that don't wait among them; past it, sends and those calls are refused");
  });

  it("says how full the buckets are together against the plan's storage, full being when uploads wait", () => {
    expect([null, 80, 100].map((notice) => bucketStorageLabel({ bucketStorageNotice: notice as 80 | 100 | null }))).toEqual([
      "Under 80% of the plan's storage",
      "80% or more of the plan's storage",
      "Full: they hold all of the plan's storage, and uploads wait for room",
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

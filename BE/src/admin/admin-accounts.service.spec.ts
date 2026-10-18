/**
 * L1: the e-mail an account's owners get when an operator changes its status
 * (client-readiness plan, P-71). Sending it, to each owner, is checked
 * against PostgreSQL in admin-accounts.db.spec.ts.
 */
import { STATUS_CHANGE_NAMES } from './account-status-changes';
import { ownerMail } from './admin-accounts.service';

const ACCOUNT = { id: '000000000042', name: 'Tunis Labs', dataDeletionDueAt: null };
const CONSOLE = 'https://console.ff.tn';
const REASON = 'Mining cryptocurrency, against the terms';

describe("the owners' e-mail (L1, P-71)", () => {
  it('names the account and what happened to it', () => {
    expect(STATUS_CHANGE_NAMES.map((change) => ownerMail(ACCOUNT, change, REASON, CONSOLE).subject)).toEqual([
      'Your FF account is approved: Tunis Labs',
      'Your FF account was not approved: Tunis Labs',
      'Your FF account is suspended: Tunis Labs',
      'Your FF account is active again: Tunis Labs',
      'Your FF account is closed: Tunis Labs',
    ]);
  });

  it('says why when the account can no longer work, and links to the console when it can', () => {
    const texts = Object.fromEntries(STATUS_CHANGE_NAMES.map((change) => [change, ownerMail(ACCOUNT, change, REASON, CONSOLE).text]));

    expect(Object.keys(texts).filter((change) => texts[change].includes(`Why: ${REASON}`))).toEqual(['reject', 'suspend', 'close']);
    expect(Object.keys(texts).filter((change) => texts[change].includes(`The console: ${CONSOLE}`))).toEqual(['approve', 'reactivate']);
    expect(texts.suspend).toBe(
      `Your account "Tunis Labs" (000000000042) is suspended: its functions are stopped, and can't be deployed or invoked until it is reactivated. Nothing is deleted.\nWhy: ${REASON}`,
    );
  });

  it("gives a closed account the day its data is deleted, to the minute in UTC, what is deleted and what is kept", () => {
    const closed = { ...ACCOUNT, dataDeletionDueAt: new Date('2026-11-17T10:32:45.123Z') };

    expect(ownerMail(closed, 'close', REASON, CONSOLE).text).toBe(
      [
        `Your account "Tunis Labs" (000000000042) is closed: its functions are stopped, and can't be deployed or invoked.`,
        `Why: ${REASON}`,
        '',
        `Its functions, their invocation history and their logs will be deleted on 2026-11-17 at 10:32 UTC. Until then, its members can read them in the console: ${CONSOLE}`,
        'Its usage, payments and invoices are kept, as the law requires.',
      ].join('\n'),
    );
  });
});

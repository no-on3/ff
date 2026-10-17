/**
 * L1: the e-mail an account's owners get when an operator changes its status
 * (client-readiness plan, P-71). Sending it, to each owner, is checked
 * against PostgreSQL in admin-accounts.db.spec.ts.
 */
import { STATUS_CHANGE_NAMES } from './account-status-changes';
import { ownerMail } from './admin-accounts.service';

const ACCOUNT = { id: '000000000042', name: 'Tunis Labs' };
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
});

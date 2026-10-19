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
    expect(STATUS_CHANGE_NAMES.map((change) => ownerMail(ACCOUNT, change, REASON, CONSOLE, 'en').subject)).toEqual([
      'Your FF account is approved: Tunis Labs',
      'Your FF account was not approved: Tunis Labs',
      'Your FF account is suspended: Tunis Labs',
      'Your FF account is active again: Tunis Labs',
      'Your FF account is closed: Tunis Labs',
    ]);
  });

  it('says why when the account can no longer work, and links to the console when it can', () => {
    const texts = Object.fromEntries(STATUS_CHANGE_NAMES.map((change) => [change, ownerMail(ACCOUNT, change, REASON, CONSOLE, 'en').text]));

    expect(Object.keys(texts).filter((change) => texts[change].includes(`Why: ${REASON}`))).toEqual(['reject', 'suspend', 'close']);
    expect(Object.keys(texts).filter((change) => texts[change].includes(`The console: ${CONSOLE}`))).toEqual(['approve', 'reactivate']);
    expect(texts.suspend).toBe(
      `Your account "Tunis Labs" (000000000042) is suspended: its functions are stopped, and can't be deployed or invoked until it is reactivated. Nothing is deleted.\nWhy: ${REASON}`,
    );
  });

  it("gives a closed account the day its data is deleted, to the minute in UTC, what is deleted and what is kept", () => {
    const closed = { ...ACCOUNT, dataDeletionDueAt: new Date('2026-11-17T10:32:45.123Z') };

    expect(ownerMail(closed, 'close', REASON, CONSOLE, 'en').text).toBe(
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

describe("the owners' e-mail, in French", () => {
  it('names the account and what happened to it', () => {
    expect(STATUS_CHANGE_NAMES.map((change) => ownerMail(ACCOUNT, change, REASON, CONSOLE, 'fr').subject)).toEqual([
      'Votre compte FF est approuvé : Tunis Labs',
      "Votre compte FF n'a pas été approuvé : Tunis Labs",
      'Votre compte FF est suspendu : Tunis Labs',
      'Votre compte FF est de nouveau actif : Tunis Labs',
      'Votre compte FF est fermé : Tunis Labs',
    ]);
  });

  it('says why when the account can no longer work, and links to the console when it can', () => {
    const texts = Object.fromEntries(STATUS_CHANGE_NAMES.map((change) => [change, ownerMail(ACCOUNT, change, REASON, CONSOLE, 'fr').text]));

    expect(Object.keys(texts).filter((change) => texts[change].includes(`Motif : ${REASON}`))).toEqual(['reject', 'suspend', 'close']);
    expect(Object.keys(texts).filter((change) => texts[change].includes(`La console : ${CONSOLE}`))).toEqual(['approve', 'reactivate']);
    expect(texts.approve).toBe(`Votre compte « Tunis Labs » (000000000042) est approuvé : vous pouvez déployer et invoquer des fonctions dès maintenant.\n\nLa console : ${CONSOLE}`);
    expect(texts.suspend).toBe(
      `Votre compte « Tunis Labs » (000000000042) est suspendu : ses fonctions sont arrêtées, et ne peuvent être ni déployées ni invoquées jusqu'à sa réactivation. Rien n'est supprimé.\nMotif : ${REASON}`,
    );
  });

  it('gives a closed account the day its data is deleted, to the minute in UTC, what is deleted and what is kept', () => {
    const closed = { ...ACCOUNT, dataDeletionDueAt: new Date('2026-11-17T10:32:45.123Z') };

    expect(ownerMail(closed, 'close', REASON, CONSOLE, 'fr').text).toBe(
      [
        'Votre compte « Tunis Labs » (000000000042) est fermé : ses fonctions sont arrêtées, et ne peuvent être ni déployées ni invoquées.',
        `Motif : ${REASON}`,
        '',
        `Ses fonctions, l'historique de leurs invocations et leurs journaux seront supprimés le 17 novembre 2026 à 10:32 UTC. D'ici là, ses membres peuvent les consulter dans la console : ${CONSOLE}`,
        "Sa consommation, ses paiements et ses factures sont conservés, comme la loi l'exige.",
      ].join('\n'),
    );
  });
});

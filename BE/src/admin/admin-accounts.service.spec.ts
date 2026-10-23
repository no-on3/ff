/**
 * L1: the e-mail an account's owners get when an operator changes its status
 * (client-readiness plan, P-71), or turns its databases and buckets off or on.
 * Sending it, to each owner, is checked against PostgreSQL in
 * admin-accounts.db.spec.ts.
 */
import { STATUS_CHANGE_NAMES } from './account-status-changes';
import { ownerMail, storageMail } from './admin-accounts.service';

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

describe("the owners' e-mail when their databases and buckets are turned off, or on", () => {
  it('says what stops and what goes on, and why, in English', () => {
    expect(storageMail(ACCOUNT, false, REASON, CONSOLE, 'en')).toEqual({
      subject: 'The databases and buckets of your FF account are off: Tunis Labs',
      text: [
        'FF turned off the databases and buckets of your account "Tunis Labs" (000000000042): their users can\'t log in, and their sessions were ended; no database can be made meanwhile. Their data are kept, and billed; your functions go on.',
        `Why: ${REASON}`,
        '',
        'The console: https://console.ff.tn',
      ].join('\n'),
    });
    expect(storageMail(ACCOUNT, true, REASON, CONSOLE, 'en').subject).toBe('The databases and buckets of your FF account are on again: Tunis Labs');
  });

  it('and in French, buckets as AWS calls them there: compartiments', () => {
    expect(storageMail(ACCOUNT, false, REASON, CONSOLE, 'fr').subject).toBe('Les bases de données et compartiments de votre compte FF sont désactivés : Tunis Labs');
    expect(storageMail(ACCOUNT, false, REASON, CONSOLE, 'fr').text.split('\n')[1]).toBe(`Motif : ${REASON}`);
    expect(storageMail(ACCOUNT, true, REASON, CONSOLE, 'fr').text.split('\n')[0]).toBe(
      'Les bases de données et les compartiments de votre compte « Tunis Labs » (000000000042) sont réactivés : leurs utilisateurs peuvent de nouveau se connecter.',
    );
  });
});

/**
 * L1: what an hourly sample does with a database against its plan's storage
 * (ADR 0008): its owners told at 80% and 100%, once each time it reaches the
 * share; past 100%, its new sessions read-only, set again each hour while it
 * stays past, and read-write once it is back under. The samples themselves,
 * on real servers: database-samples.db.spec.ts.
 */
import { DatabaseStatus } from './database.entity';
import { BYTES_PER_MB, StorageFacts, storageMail, storageStep } from './storage-notice';

const MB = BYTES_PER_MB;
const active = { status: DatabaseStatus.ACTIVE, storageNotice: null };
const step = (database: Parameters<typeof storageStep>[0], sizeMb: bigint | number, storageMb = 1024) => storageStep(database, BigInt(sizeMb) * MB, storageMb);

describe("a database's hourly step against its plan's storage (L1, ADR 0008)", () => {
  it('does nothing under 80%, nor tells anyone', () => {
    expect(step(active, 819)).toEqual({ notify: null, notice: null, signal: null, status: DatabaseStatus.ACTIVE });
  });

  it('tells its owners once at 80%, and keeps the share for the next sample', () => {
    // 80% of 1,024 MB is 819.2 MB, 858,993,459.2 bytes: the first byte at 80% is the next whole one.
    const eighty = (4n * 1024n * MB + 4n) / 5n;
    expect(storageStep(active, eighty, 1024)).toEqual({ notify: 80, notice: 80, signal: null, status: DatabaseStatus.ACTIVE });
    expect(storageStep(active, eighty - 1n, 1024).notify).toBeNull();
    expect(step({ status: DatabaseStatus.ACTIVE, storageNotice: 80 }, 900)).toEqual({ notify: null, notice: 80, signal: null, status: DatabaseStatus.ACTIVE });
  });

  it('tells them at 100%, and turns its new sessions read-only only past it', () => {
    expect(step({ status: DatabaseStatus.ACTIVE, storageNotice: 80 }, 1024)).toEqual({ notify: 100, notice: 100, signal: null, status: DatabaseStatus.ACTIVE });
    expect(storageStep({ status: DatabaseStatus.ACTIVE, storageNotice: 100 }, 1024n * MB + 1n, 1024)).toEqual({
      notify: null,
      notice: 100,
      signal: 'start',
      status: DatabaseStatus.READ_ONLY,
    });
  });

  it('names only the highest share when a database reaches both between two samples', () => {
    expect(step(active, 2000)).toEqual({ notify: 100, notice: 100, signal: 'start', status: DatabaseStatus.READ_ONLY });
  });

  it('sets the signal again while it stays past, telling no one again', () => {
    expect(step({ status: DatabaseStatus.READ_ONLY, storageNotice: 100 }, 1100)).toEqual({ notify: null, notice: 100, signal: 'again', status: DatabaseStatus.READ_ONLY });
  });

  it('ends the signal once it is back under, and tells them again when it next reaches a share', () => {
    const under = step({ status: DatabaseStatus.READ_ONLY, storageNotice: 100 }, 900);
    expect(under).toEqual({ notify: null, notice: 80, signal: 'end', status: DatabaseStatus.ACTIVE });
    expect(step({ status: under.status, storageNotice: under.notice }, 1100).notify).toBe(100);
    expect(step({ status: DatabaseStatus.ACTIVE, storageNotice: 80 }, 100)).toEqual({ notify: null, notice: null, signal: null, status: DatabaseStatus.ACTIVE });
  });

  it("follows the plan's storage: a smaller plan's share is reached sooner", () => {
    expect(step(active, 9, 10)).toMatchObject({ notify: 80 });
    expect(step(active, 11, 10)).toMatchObject({ notify: 100, signal: 'start' });
  });

  it("leaves a suspended account's databases as they are: only measured", () => {
    const suspended = { status: DatabaseStatus.SUSPENDED, storageNotice: null };
    expect(step(suspended, 5000)).toEqual({ notify: null, notice: null, signal: null, status: DatabaseStatus.SUSPENDED });
  });
});

describe("the owners' e-mail on a database's storage (L1, ADR 0008)", () => {
  const facts: StorageFacts = {
    account: { id: '000000000001', name: 'Acme' },
    database: { id: 'db', name: 'orders' },
    share: 80,
    sizeBytes: 8192n * MB / 10n + MB / 10n,
    storageMb: 1024,
    planName: 'Beta',
    readOnly: false,
    consoleUrl: 'https://console.example.tn',
  };
  const past = { ...facts, share: 100 as const, sizeBytes: 10_245n * MB / 10n, readOnly: true };

  it('says how full it is, what happens past the plan, and where to look', () => {
    const mail = storageMail(facts, 'en');

    expect(mail.subject).toBe('Your FF database "orders" is at 80% of its storage');
    expect(mail.text.split('\n')).toEqual([
      'Your database "orders" in the account "Acme" (000000000001) holds 819.3 MB: 80% or more of the 1,024 MB the Beta plan gives each database.',
      '',
      "Past 1,024 MB, its new sessions start read-only: an app reads, and its writes are refused (SQLSTATE 25006) until the database is back under. Its storage is billed by the GB-month, past the plan's too.",
      '',
      'Delete what you no longer need, or move to a plan with more storage. Your databases: https://console.example.tn/databases',
    ]);
  });

  it('says, past the plan, that it is read-only now, how to make room, and when it is read-write again', () => {
    const mail = storageMail(past, 'en');

    expect(mail.subject).toBe('Your FF database "orders" is past its storage: read-only');
    expect(mail.text).toContain('holds 1,024.5 MB, past the 1,024 MB the Beta plan gives each database. Its new sessions start read-only, and the sessions under way were ended');
    expect(mail.text).toContain('SET default_transaction_read_only = off');
    expect(mail.text).toContain('at the next hourly measure, its sessions start read-write again');
  });

  it('says all of it at exactly 100%, not yet read-only', () => {
    expect(storageMail({ ...facts, share: 100, sizeBytes: 1024n * MB }, 'en').text.split('\n')[0]).toBe(
      'Your database "orders" in the account "Acme" (000000000001) holds 1,024 MB: all of the 1,024 MB the Beta plan gives each database.',
    );
  });

  it("writes French with French typesetting: « », a no-break space before the %, Mo, and grouped digits", () => {
    const mail = storageMail(facts, 'fr');
    const readOnly = storageMail(past, 'fr');

    expect(mail.subject).toBe('Votre base de données FF « orders » atteint 80\u00a0% de son stockage');
    expect(mail.text.split('\n')[0]).toBe(
      "Votre base de données « orders » du compte « Acme » (000000000001) occupe 819,3\u00a0Mo : 80\u00a0% ou plus des 1\u00a0024\u00a0Mo que l'offre Beta donne à chaque base.",
    );
    expect(readOnly.subject).toBe('Votre base de données FF « orders » dépasse son stockage : lecture seule');
    expect(readOnly.text).toContain('occupe 1\u00a0024,5\u00a0Mo, au-delà des 1\u00a0024\u00a0Mo');
    expect(readOnly.text).toContain('https://console.example.tn/databases');
  });
});

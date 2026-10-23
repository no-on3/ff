/**
 * L1: what a measure of an account's buckets does against its plan's storage
 * (ADR 0009): all of them together, its owners told at 80% and 100%, once each
 * time they reach the share; from 100%, uploads waiting for room until they
 * hold less. The measures themselves, against the store: bucket-samples.db.spec.ts.
 */
import { BYTES_PER_MB } from '../databases/storage-notice';
import { BucketStorageFacts, bucketStorageMail, bucketStorageStep, fullBuckets } from './bucket-storage';

const MB = BYTES_PER_MB;
const step = (notice: 80 | 100 | null, sizeMb: number, storageMb = 5120) => bucketStorageStep(notice, BigInt(sizeMb) * MB, storageMb);

describe("an account's buckets against its plan's storage (L1, ADR 0009)", () => {
  it('does nothing under 80%, nor tells anyone', () => {
    expect(step(null, 4095)).toEqual({ notify: null, notice: null });
  });

  it('tells its owners once at 80%, and keeps the share for the next measure', () => {
    // 80% of 5,120 MB is 4,096 MB exactly.
    expect(bucketStorageStep(null, 4096n * MB, 5120)).toEqual({ notify: 80, notice: 80 });
    expect(bucketStorageStep(null, 4096n * MB - 1n, 5120).notify).toBeNull();
    expect(step(80, 5000)).toEqual({ notify: null, notice: 80 });
  });

  it('tells them at 100%, when the buckets hold all of the plan: uploads then wait for room', () => {
    expect(step(80, 5120)).toEqual({ notify: 100, notice: 100 });
    expect(bucketStorageStep(80, 5120n * MB - 1n, 5120)).toEqual({ notify: null, notice: 80 });
    expect(step(100, 6000)).toEqual({ notify: null, notice: 100 });
  });

  it('names only the highest share when the buckets reach both between two measures', () => {
    expect(step(null, 9000)).toEqual({ notify: 100, notice: 100 });
  });

  it('lets uploads in once they hold less, and tells them again when they next reach a share', () => {
    const under = step(100, 4500);
    expect(under).toEqual({ notify: null, notice: 80 });
    expect(step(under.notice, 5200).notify).toBe(100);
    expect(step(80, 10)).toEqual({ notify: null, notice: null });
  });

  it("follows the plan's storage: a smaller plan's share is reached sooner", () => {
    expect(step(null, 8, 10)).toEqual({ notify: 80, notice: 80 });
    expect(step(null, 10, 10)).toEqual({ notify: 100, notice: 100 });
  });

  it("says why the front door refuses an upload, in AccountProblem's words: the plan, its storage, what still works", () => {
    expect(fullBuckets(5120, 'Beta')).toBe('its buckets hold the 5,120 MB its Beta plan gives them: its files are read and deleted, and uploads wait for room');
  });
});

describe("the owners' e-mail (L1, ADR 0009)", () => {
  const facts = (share: 80 | 100, sizeMb: number): BucketStorageFacts => ({
    account: { id: '123456789012', name: 'Sfax Shop' },
    share,
    sizeBytes: BigInt(sizeMb) * MB + MB / 2n,
    storageMb: 5120,
    planName: 'Beta',
    consoleUrl: 'https://console.example.tn',
  });

  it('at 80%, says what they hold, what happens at 100%, and how to make room', () => {
    const mail = bucketStorageMail(facts(80, 4200), 'en');

    expect(mail.subject).toBe('Your FF buckets are at 80% of their storage');
    expect(mail.text.split('\n')).toEqual([
      'The buckets of your account "Sfax Shop" (123456789012) hold 4,200.5 MB together: 80% or more of the 5,120 MB the Beta plan gives them.',
      '',
      'At 5,120 MB, uploads to them are refused (AccountProblem) until they hold less; reading and deleting files go on. Their storage is billed by the GB-month, as S3 bills it.',
      '',
      'Delete what you no longer need, or move to a plan with more storage. Your buckets: https://console.example.tn/buckets',
    ]);
  });

  it('at 100%, says uploads are refused, what goes on, and that deleting lets them in again within a minute', () => {
    const mail = bucketStorageMail(facts(100, 5120), 'en');

    expect(mail.subject).toBe('Your FF buckets are full: uploads wait for room');
    expect(mail.text).toContain('hold 5,120.5 MB together: all of the 5,120 MB the Beta plan gives them. Uploads to them are refused (AccountProblem) until they hold less');
    expect(mail.text).toContain('once they hold less, uploads go in again within a minute');
  });

  it('in French, for owners who read it', () => {
    const nbsp = ' ';
    expect(bucketStorageMail(facts(80, 4200), 'fr').subject).toBe(`Vos buckets FF atteignent 80${nbsp}% de leur stockage`);
    const full = bucketStorageMail(facts(100, 5120), 'fr');
    expect(full.subject).toBe('Vos buckets FF sont pleins : les envois attendent de la place');
    expect(full.text).toContain(`occupent 5${nbsp}120,5${nbsp}Mo à eux tous : la totalité des 5${nbsp}120${nbsp}Mo que l'offre Beta leur donne.`);
  });
});

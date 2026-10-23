import { frenchDecimal, frenchPercent } from '../common/french';
import { BYTES_PER_MB, StorageShare, megabytes } from '../databases/storage-notice';
import type { Language } from '../mail/language';
import type { Mail } from '../mail/mail.service';

/** What a measure of an account's buckets does, all of them together against its plan's storage (ADR 0009). */
export interface BucketStorageStep {
  /** The share to tell its owners of: one they reached at this measure and not at the last; null for none. */
  notify: StorageShare | null;
  /** The share they have reached, kept on the account for the next measure: null under 80%; at 100%, uploads wait for room. */
  notice: StorageShare | null;
}

/**
 * An account's buckets at their measure: at 80% and 100% of its plan's
 * storage its owners are told, once each time they reach the share, the
 * highest one when they reach both at once; from 100%, uploads wait for room,
 * while files are read and deleted, until the buckets hold less again.
 */
export function bucketStorageStep(notice: StorageShare | null, sizeBytes: bigint, storageMb: number): BucketStorageStep {
  const limit = BigInt(storageMb) * BYTES_PER_MB;
  const reached: StorageShare | null = sizeBytes >= limit ? 100 : sizeBytes * 5n >= limit * 4n ? 80 : null;
  return { notify: reached !== null && (notice === null || reached > notice) ? reached : null, notice: reached };
}

/** Why the front door refuses an upload to a full account's buckets, in S3's AccountProblem. */
export function fullBuckets(storageMb: number, planName: string): string {
  return `its buckets hold the ${storageMb.toLocaleString('en-US')} MB its ${planName} plan gives them: its files are read and deleted, and uploads wait for room`;
}

export interface BucketStorageFacts {
  account: { id: string; name: string };
  share: StorageShare;
  /** What its buckets hold together. */
  sizeBytes: bigint;
  storageMb: number;
  planName: string;
  consoleUrl: string;
}

/** The e-mail each owner gets when an account's buckets reach 80% or 100% of its plan's storage, in their language. */
export function bucketStorageMail(facts: BucketStorageFacts, language: Language): Omit<Mail, 'to'> {
  if (language === 'fr') return frenchBucketStorageMail(facts);
  const mb = (text: string) => `${Number(text).toLocaleString('en-US', { maximumFractionDigits: 1 })} MB`;
  const size = mb(megabytes(facts.sizeBytes));
  const limit = mb(String(facts.storageMb));
  const which = `The buckets of your account "${facts.account.name}" (${facts.account.id})`;
  const plan = `the ${limit} the ${facts.planName} plan gives them`;
  const billed = "Their storage is billed by the GB-month, as S3 bills it.";
  const link = `Your buckets: ${facts.consoleUrl}/buckets`;
  if (facts.share === 100) {
    return {
      subject: 'Your FF buckets are full: uploads wait for room',
      text: [
        `${which} hold ${size} together: all of ${plan}. Uploads to them are refused (AccountProblem) until they hold less; reading and deleting files go on.`,
        '',
        `Delete what you no longer need, or move to a plan with more storage: once they hold less, uploads go in again within a minute. ${billed}`,
        '',
        link,
      ].join('\n'),
    };
  }
  return {
    subject: `Your FF buckets are at ${facts.share}% of their storage`,
    text: [
      `${which} hold ${size} together: ${facts.share}% or more of ${plan}.`,
      '',
      `At ${limit}, uploads to them are refused (AccountProblem) until they hold less; reading and deleting files go on. ${billed}`,
      '',
      `Delete what you no longer need, or move to a plan with more storage. ${link}`,
    ].join('\n'),
  };
}

function frenchBucketStorageMail(facts: BucketStorageFacts): Omit<Mail, 'to'> {
  const mb = (text: string) => `${frenchDecimal(text)}\u00a0Mo`;
  const size = mb(megabytes(facts.sizeBytes));
  const limit = mb(String(facts.storageMb));
  const which = `Les buckets de votre compte « ${facts.account.name} » (${facts.account.id})`;
  const plan = `${limit} que l'offre ${facts.planName} leur donne`;
  const billed = 'Leur stockage est facturé au Go-mois, comme S3 le facture.';
  const link = `Vos buckets : ${facts.consoleUrl}/buckets`;
  if (facts.share === 100) {
    return {
      subject: "Vos buckets FF sont pleins : les envois attendent de la place",
      text: [
        `${which} occupent ${size} à eux tous : la totalité des ${plan}. Les envois de fichiers y sont refusés (AccountProblem) jusqu'à ce qu'ils occupent moins ; lire et supprimer des fichiers restent possibles.`,
        '',
        `Supprimez ce dont vous n'avez plus besoin, ou passez à une offre avec plus de stockage : une fois qu'ils occupent moins, les envois reprennent dans la minute. ${billed}`,
        '',
        link,
      ].join('\n'),
    };
  }
  return {
    subject: `Vos buckets FF atteignent ${frenchPercent(facts.share)} de leur stockage`,
    text: [
      `${which} occupent ${size} à eux tous : ${frenchPercent(facts.share)} ou plus des ${plan}.`,
      '',
      `À ${limit}, les envois de fichiers y sont refusés (AccountProblem) jusqu'à ce qu'ils occupent moins ; lire et supprimer des fichiers restent possibles. ${billed}`,
      '',
      `Supprimez ce dont vous n'avez plus besoin, ou passez à une offre avec plus de stockage. ${link}`,
    ].join('\n'),
  };
}

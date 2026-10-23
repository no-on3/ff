import { frenchDecimal, frenchPercent } from '../common/french';
import type { Language } from '../mail/language';
import type { Mail } from '../mail/mail.service';
import { DatabaseStatus } from './database.entity';

/** A plan's MB, as it counts storage: 2^20 bytes. */
export const BYTES_PER_MB = 1_048_576n;

/** The shares of its plan's storage that a database's owners are told of. */
export type StorageShare = 80 | 100;

/** What an hourly sample does with a database, from its size against its plan's storage (ADR 0008). */
export interface StorageStep {
  /** The share to tell its owners of: one it reached at this sample and not at the last; null for none. */
  notify: StorageShare | null;
  /** The share it has reached, kept on its row for the next sample: null under 80%. */
  notice: StorageShare | null;
  /**
   * The read-only signal: started past the plan (its sessions under way ended), set again while it stays past it (the
   * customer may have taken it away; its sessions left alone), ended once it is back under.
   */
  signal: 'start' | 'again' | 'end' | null;
  status: DatabaseStatus;
}

/**
 * A database's step at its hourly sample: at 80% and 100% of its plan's storage its owners are told, once each time
 * it reaches the share, the highest one when it reaches both at once; past 100% its new sessions start read-only, a
 * signal rather than a wall, until it is back under. A suspended account's databases are only measured: their users
 * can't log in.
 */
export function storageStep(database: { status: DatabaseStatus; storageNotice: StorageShare | null }, sizeBytes: bigint, storageMb: number): StorageStep {
  const { status, storageNotice } = database;
  if (status !== DatabaseStatus.ACTIVE && status !== DatabaseStatus.READ_ONLY) return { notify: null, notice: storageNotice, signal: null, status };
  const limit = BigInt(storageMb) * BYTES_PER_MB;
  const notice: StorageShare | null = sizeBytes >= limit ? 100 : sizeBytes * 5n >= limit * 4n ? 80 : null;
  const notify = notice !== null && (storageNotice === null || notice > storageNotice) ? notice : null;
  const past = sizeBytes > limit;
  if (past) return { notify, notice, signal: status === DatabaseStatus.ACTIVE ? 'start' : 'again', status: DatabaseStatus.READ_ONLY };
  return { notify, notice, signal: status === DatabaseStatus.READ_ONLY ? 'end' : null, status: DatabaseStatus.ACTIVE };
}

export interface StorageFacts {
  account: { id: string; name: string };
  database: { id: string; name: string };
  share: StorageShare;
  sizeBytes: bigint;
  storageMb: number;
  planName: string;
  /** Whether its new sessions start read-only now: past the plan's storage. */
  readOnly: boolean;
  consoleUrl: string;
}

/** Megabytes to a tenth, as the plan counts them: "1024.5", "819.2", "7". */
function megabytes(bytes: bigint): string {
  const tenths = (bytes * 10n + BYTES_PER_MB / 2n) / BYTES_PER_MB;
  return tenths % 10n === 0n ? (tenths / 10n).toString() : `${tenths / 10n}.${tenths % 10n}`;
}

/** The e-mail each owner gets when a database reaches 80% or 100% of its plan's storage, in their language. */
export function storageMail(facts: StorageFacts, language: Language): Omit<Mail, 'to'> {
  if (language === 'fr') return frenchStorageMail(facts);
  const mb = (text: string) => `${Number(text).toLocaleString('en-US', { maximumFractionDigits: 1 })} MB`;
  const size = mb(megabytes(facts.sizeBytes));
  const limit = mb(String(facts.storageMb));
  const which = `Your database "${facts.database.name}" in the account "${facts.account.name}" (${facts.account.id})`;
  const plan = `the ${limit} the ${facts.planName} plan gives each database`;
  const billed = "Its storage is billed by the GB-month, past the plan's too.";
  const link = `Your databases: ${facts.consoleUrl}/databases`;
  if (facts.readOnly) {
    return {
      subject: `Your FF database "${facts.database.name}" is past its storage: read-only`,
      text: [
        `${which} holds ${size}, past ${plan}. Its new sessions start read-only, and the sessions under way were ended so that they start so again: an app reads, and its writes are refused (SQLSTATE 25006).`,
        '',
        `To make room, a session may turn it off for itself (SET default_transaction_read_only = off) and delete what you no longer need. Once the database is back under, at the next hourly measure, its sessions start read-write again. ${billed}`,
        '',
        link,
      ].join('\n'),
    };
  }
  const reached = facts.share === 100 ? `all of ${plan}` : `${facts.share}% or more of ${plan}`;
  return {
    subject: `Your FF database "${facts.database.name}" is at ${facts.share}% of its storage`,
    text: [
      `${which} holds ${size}: ${reached}.`,
      '',
      `Past ${limit}, its new sessions start read-only: an app reads, and its writes are refused (SQLSTATE 25006) until the database is back under. ${billed}`,
      '',
      `Delete what you no longer need, or move to a plan with more storage. ${link}`,
    ].join('\n'),
  };
}

function frenchStorageMail(facts: StorageFacts): Omit<Mail, 'to'> {
  const mb = (text: string) => `${frenchDecimal(text)}\u00a0Mo`;
  const size = mb(megabytes(facts.sizeBytes));
  const limit = mb(String(facts.storageMb));
  const which = `Votre base de données « ${facts.database.name} » du compte « ${facts.account.name} » (${facts.account.id})`;
  const plan = `${limit} que l'offre ${facts.planName} donne à chaque base`;
  const billed = "Son stockage est facturé au Go-mois, au-delà de celui de l'offre aussi.";
  const link = `Vos bases de données : ${facts.consoleUrl}/databases`;
  if (facts.readOnly) {
    return {
      subject: `Votre base de données FF « ${facts.database.name} » dépasse son stockage : lecture seule`,
      text: [
        `${which} occupe ${size}, au-delà des ${plan}. Ses nouvelles sessions démarrent en lecture seule, et les sessions en cours ont été fermées pour qu'elles redémarrent ainsi : une application lit, et ses écritures sont refusées (SQLSTATE 25006).`,
        '',
        `Pour faire de la place, une session peut l'enlever pour elle-même (SET default_transaction_read_only = off) et supprimer ce dont vous n'avez plus besoin. Une fois la base repassée en dessous, à la mesure horaire suivante, ses sessions redémarrent en lecture-écriture. ${billed}`,
        '',
        link,
      ].join('\n'),
    };
  }
  const reached = facts.share === 100 ? `la totalité des ${plan}` : `${frenchPercent(facts.share)} ou plus des ${plan}`;
  return {
    subject: `Votre base de données FF « ${facts.database.name} » atteint ${frenchPercent(facts.share)} de son stockage`,
    text: [
      `${which} occupe ${size} : ${reached}.`,
      '',
      `Au-delà de ${limit}, ses nouvelles sessions démarrent en lecture seule : une application lit, et ses écritures sont refusées (SQLSTATE 25006) jusqu'à ce que la base repasse en dessous. ${billed}`,
      '',
      `Supprimez ce dont vous n'avez plus besoin, ou passez à une offre avec plus de stockage. ${link}`,
    ].join('\n'),
  };
}

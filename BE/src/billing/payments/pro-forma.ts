import { randomInt } from 'node:crypto';
import type { Mail } from '../../mail/mail.service';
import { Decimal } from '../decimal';
import { formatMinor } from '../money';

/** D9: VAT on top of prepaid credit (parent §8.6). P-36 makes tax rates dated data. */
export const VAT_PERCENT = 19;

/** The credit a pro-forma may ask for, in whole units of the currency: from a small top-up to a large B2B one. */
export const CREDIT_LIMITS = { min: 10n, max: 1_000_000n };

/** VAT on a credit, in minor units, rounded once, half away from zero: 19% of 50.000 TND is 9.500. */
export const vatOf = (creditMinor: bigint, percent: number): bigint => Decimal.ratio(creditMinor * BigInt(percent), 100n).unitsAt(0);

/** Letters and digits that read and type without doubt: no I, L, O, U, 0 or 1. */
const REFERENCE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
/** FF-XXXX-XXXX, as newReference() writes it and normalizedReference() reads it. */
export const REFERENCE = /^FF-[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}$/;

/** A payment reference for the transfer's label (P-35): FF and eight characters, 30^8 of them, in two groups. */
export function newReference(random: (max: number) => number = randomInt): string {
  const characters = Array.from({ length: 8 }, () => REFERENCE_ALPHABET[random(REFERENCE_ALPHABET.length)]);
  return `FF-${characters.slice(0, 4).join('')}-${characters.slice(4).join('')}`;
}

/** A reference as an operator types it from a bank statement, in any case, with or without dashes and spaces; null if it can't be one. */
export function normalizedReference(text: string): string | null {
  const compact = text.toUpperCase().replace(/[\s-]/g, '');
  if (!/^FF[A-Z0-9]{8}$/.test(compact)) return null;
  const reference = `FF-${compact.slice(2, 6)}-${compact.slice(6)}`;
  return REFERENCE.test(reference) ? reference : null;
}

/** What a pro-forma asks for, in minor units. */
export interface ProFormaAmounts {
  creditMinor: bigint;
  vatMinor: bigint;
  totalMinor: bigint;
}

/**
 * Why a transfer can't be recorded against a pro-forma, or null (P-35): what
 * reached FF's account and what the buyer withheld at source make the total,
 * and the share withheld is less than the credit. Partial and over-payments
 * aren't handled: the operator sorts them out with the buyer.
 */
export function transferProblem(proForma: ProFormaAmounts, receivedMinor: bigint, withheldMinor: bigint, exponent: number, currency: string): string | null {
  const money = (minor: bigint) => `${formatMinor(minor, exponent)} ${currency}`;
  if (receivedMinor <= 0n) return 'received must be more than 0';
  if (withheldMinor < 0n) return 'withheld must be 0 or more';
  if (receivedMinor + withheldMinor !== proForma.totalMinor) {
    return `received ${money(receivedMinor)} and withheld ${money(withheldMinor)} make ${money(receivedMinor + withheldMinor)}, not the pro-forma's ${money(proForma.totalMinor)}`;
  }
  if (withheldMinor >= proForma.creditMinor) return `withheld ${money(withheldMinor)} must be less than the credit, ${money(proForma.creditMinor)}`;
  return null;
}

export interface TransferFacts {
  account: { id: string; name: string };
  reference: string;
  creditMinor: bigint;
  receivedMinor: bigint;
  withheldMinor: bigint;
  exponent: number;
  currency: string;
  consoleUrl: string;
}

/** The owners' e-mail when a transfer is recorded: the credit added, and the withheld share's, when the certificate comes. */
export function transferMail(facts: TransferFacts): Omit<Mail, 'to'> {
  const money = (minor: bigint) => `${formatMinor(minor, facts.exponent)} ${facts.currency}`;
  const lines = [
    `We received your transfer of ${money(facts.receivedMinor)} for the pro-forma ${facts.reference}: ${money(facts.creditMinor - facts.withheldMinor)} of credit was added to your account "${facts.account.name}" (${facts.account.id}).`,
  ];
  if (facts.withheldMinor > 0n) {
    lines.push('', `${money(facts.withheldMinor)} was withheld at source: it is added to your credit when we receive the withholding certificate.`);
  }
  lines.push('', `Your balance: ${facts.consoleUrl}/billing`);
  return { subject: `Your transfer was received: ${facts.account.name}`, text: lines.join('\n') };
}

/** The owners' e-mail when the withholding certificate is added: the withheld share is credited. */
export function withholdingMail(facts: TransferFacts): Omit<Mail, 'to'> {
  const money = (minor: bigint) => `${formatMinor(minor, facts.exponent)} ${facts.currency}`;
  return {
    subject: `The share withheld at source was added: ${facts.account.name}`,
    text: [
      `We received the withholding certificate for your transfer for the pro-forma ${facts.reference}: the ${money(facts.withheldMinor)} withheld at source was added to the credit of your account "${facts.account.name}" (${facts.account.id}).`,
      '',
      `Your balance: ${facts.consoleUrl}/billing`,
    ].join('\n'),
  };
}

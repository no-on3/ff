import { frenchMoney, frenchMonth } from '../../common/french';
import type { Language } from '../../mail/language';
import type { Mail } from '../../mail/mail.service';
import { formatMinor } from '../money';
import type { Invoice } from './invoice.entity';

const monthName = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
/** "d'octobre 2026", "de mars 2026": French elides "de" before a vowel. */
const ofFrenchMonth = (month: string) => (/^[aeiou]/.test(frenchMonth(month)) ? `d'${frenchMonth(month)}` : `de ${frenchMonth(month)}`);

interface Facts {
  account: { id: string; name: string };
  exponent: number;
  consoleUrl: string;
}

/** The owners' e-mail when the month's invoice is issued (P-36): its number, total and stamp duty, and where to download it. */
export function invoiceMail({ account, invoice, exponent, consoleUrl }: Facts & { invoice: Invoice }, language: Language): Omit<Mail, 'to'> {
  if (language === 'fr') {
    const money = (minor: bigint) => frenchMoney(minor, exponent, invoice.currency);
    const stamp = invoice.stampDutyMinor > 0n ? `, dont le droit de timbre de ${money(invoice.stampDutyMinor)}, pris sur votre crédit` : '';
    return {
      subject: `Votre facture ${invoice.number} : ${account.name}`,
      text: [
        `Votre facture ${ofFrenchMonth(invoice.month as string)} est émise : ${invoice.number}, ${money(invoice.totalMinor)} TTC${stamp}. Elle reprend le crédit que vous avez acheté ; le relevé de consommation du mois y est joint.`,
        '',
        `Téléchargez-la depuis la page Billing de la console : ${consoleUrl}/billing`,
      ].join('\n'),
    };
  }
  const money = (minor: bigint) => `${formatMinor(minor, exponent)} ${invoice.currency}`;
  const stamp = invoice.stampDutyMinor > 0n ? `, with the ${money(invoice.stampDutyMinor)} stamp duty, which was taken from your credit` : '';
  return {
    subject: `Your invoice ${invoice.number}: ${account.name}`,
    text: [
      `Your invoice for ${monthName(invoice.month as string)} is issued: ${invoice.number}, ${money(invoice.totalMinor)} including VAT${stamp}. It lists the credit you bought; the month's usage statement is attached to it.`,
      '',
      `Download it from your Billing page: ${consoleUrl}/billing`,
    ].join('\n'),
  };
}

/** The owners' e-mail when a credit note corrects one of their invoices. */
export function creditNoteMail({ account, note, corrects, exponent, consoleUrl }: Facts & { note: Invoice; corrects: string }, language: Language): Omit<Mail, 'to'> {
  if (language === 'fr') {
    return {
      subject: `Un avoir pour votre facture ${corrects} : ${account.name}`,
      text: [
        `Nous avons émis l'avoir ${note.number} pour votre facture ${corrects} : ${frenchMoney(note.totalMinor, exponent, note.currency)} TTC.`,
        '',
        `Motif : ${note.reason as string}`,
        '',
        `Téléchargez-le depuis la page Billing de la console : ${consoleUrl}/billing`,
      ].join('\n'),
    };
  }
  return {
    subject: `A credit note for your invoice ${corrects}: ${account.name}`,
    text: [
      `We issued the credit note ${note.number} for your invoice ${corrects}: ${formatMinor(note.totalMinor, exponent)} ${note.currency} including VAT.`,
      '',
      `Why: ${note.reason as string}`,
      '',
      `Download it from your Billing page: ${consoleUrl}/billing`,
    ].join('\n'),
  };
}

/** The operator's e-mail about a month's invoices still to issue (P-36, D9): ready on the 1st, and a reminder after the reminder day. */
export function operatorInvoicesMail(kind: 'ready' | 'reminder', month: string, waiting: number, reminderDay: number, adminUrl: string): Omit<Mail, 'to'> {
  const invoices = waiting === 1 ? '1 invoice' : `${waiting} invoices`;
  const link = `${adminUrl}/invoices?month=${month}`;
  return kind === 'ready'
    ? {
        subject: `Invoices to issue: ${monthName(month)}`,
        text: [`${invoices} for ${monthName(month)} ${waiting === 1 ? 'is' : 'are'} ready to issue, by the ${ordinal(reminderDay)}:`, '', link].join('\n'),
      }
    : {
        subject: `Invoices still to issue: ${monthName(month)}`,
        text: [`${invoices} for ${monthName(month)} ${waiting === 1 ? 'is' : 'are'} still not issued, past the ${ordinal(reminderDay)}:`, '', link].join('\n'),
      };
}

/** 1st, 2nd, 3rd, 4th … 28th. */
function ordinal(day: number): string {
  const suffix = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
  return `${day}${suffix}`;
}

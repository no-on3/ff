import { formatMoney } from './money';
import { whenUtc } from './time';

/**
 * Payments, as the admin routes give them (P-35, P-74): the pro-formas owners
 * asked for, and the transfers operators recorded against them. Money is a
 * string with every decimal of its currency. contract.test.ts checks the
 * fields, the statuses and the certificate's rules against the API's.
 */
export type PaymentStatus = 'pending' | 'paid' | 'cancelled';

export const PAYMENT_STATUSES: Array<{ value: PaymentStatus; label: string }> = [
  { value: 'pending', label: 'Waiting for the transfer' },
  { value: 'paid', label: 'Paid' },
  { value: 'cancelled', label: 'Cancelled' },
];

export interface AdminPayment {
  id: string;
  /** FF-XXXX-XXXX: what the buyer writes in the transfer's label. */
  reference: string;
  status: PaymentStatus;
  currency: string;
  credit: string;
  vatPercent: number;
  vat: string;
  total: string;
  createdAt: string;
  buyer: { name: string; taxId: string | null };
  seller: { name: string; taxId: string | null; address: string };
  bank: { name: string; iban: string; bic: string | null };
  transfer: {
    received: string;
    withheld: string;
    receivedOn: string;
    recordedAt: string;
    credited: string;
    withheldCreditedAt: string | null;
  } | null;
  /** When an owner or an operator cancelled it (P-74); a transfer that came anyway still paid it. */
  cancelledAt: string | null;
  accountId: string;
  requestedBy: string;
  bankReference: string | null;
  recordedBy: string | null;
  certificateType: string | null;
  /** user:<id> for an owner, operator:<id> for FF. */
  cancelledBy: string | null;
}

/** AdminPaymentView's fields after the pro-forma's, in the API's order. */
export const ADMIN_PAYMENT_FIELDS = ['accountId', 'requestedBy', 'bankReference', 'recordedBy', 'certificateType', 'cancelledBy'] as const;

/** What a withholding certificate may be, as the API takes it: the tax platform's PDF, or a scan. */
export const CERTIFICATE_TYPES = ['application/pdf', 'image/png', 'image/jpeg'];
/** The largest certificate the API takes, in MB of 1,048,576 bytes. */
export const CERTIFICATE_MAX_MB = 5;

/** Why this file can't be sent as a certificate, or null. The API checks it again. */
export function certificateProblem(file: { type: string; size: number }): string | null {
  if (!CERTIFICATE_TYPES.includes(file.type)) return `A certificate is a PDF, a PNG or a JPEG, not ${file.type || 'a file of unknown type'}`;
  if (file.size === 0) return 'The file is empty';
  if (file.size > CERTIFICATE_MAX_MB * 1024 * 1024) return `A certificate is ${CERTIFICATE_MAX_MB} MB at most`;
  return null;
}

/** The certificate's file name when downloaded, as the API names it. */
export function certificateName(payment: Pick<AdminPayment, 'reference' | 'certificateType'>): string {
  const extension = payment.certificateType === 'application/pdf' ? 'pdf' : payment.certificateType === 'image/png' ? 'png' : 'jpg';
  return `withholding-${payment.reference}.${extension}`;
}

const AMOUNT = /^\d{1,9}(\.\d{1,6})?$/;
const decimalsOf = (amount: string): number => amount.split('.')[1]?.length ?? 0;

/** An amount as the API takes it, in minor units, or null when it has more decimals than the currency. */
function toMinor(text: string, decimals: number): bigint | null {
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > decimals) return null;
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

function fromMinor(minor: bigint, decimals: number): string {
  if (decimals === 0) return minor.toString();
  const digits = minor.toString().padStart(decimals + 1, '0');
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

/**
 * What recording a transfer against this pro-forma does (P-35), before it is
 * sent: the credit the wallet gets now, and the share withheld at source that
 * the certificate credits later. Or why the API would refuse it: what arrived
 * and what was withheld make the total, and the withheld share is less than
 * the credit. The API checks it again.
 */
export function transferOutcome(payment: Pick<AdminPayment, 'credit' | 'total' | 'currency'>, received: string, withheld: string): { now: string; later: string | null } | { problem: string } {
  const decimals = decimalsOf(payment.total);
  const money = (minor: bigint) => formatMoney(fromMinor(minor, decimals), payment.currency);
  const receivedText = received.trim();
  const withheldText = withheld.trim() || '0';
  if (!AMOUNT.test(receivedText)) return { problem: `received must be an amount, such as ${payment.total}` };
  if (!AMOUNT.test(withheldText)) return { problem: 'withheld must be an amount, such as 0.892, or 0' };
  const receivedMinor = toMinor(receivedText, decimals);
  const withheldMinor = toMinor(withheldText, decimals);
  if (receivedMinor === null || withheldMinor === null) return { problem: `${payment.currency} has ${decimals} decimals at most` };
  const credit = toMinor(payment.credit, decimals) as bigint;
  const total = toMinor(payment.total, decimals) as bigint;
  if (receivedMinor <= 0n) return { problem: 'received must be more than 0' };
  if (receivedMinor + withheldMinor !== total) {
    return { problem: `received ${money(receivedMinor)} and withheld ${money(withheldMinor)} make ${money(receivedMinor + withheldMinor)}, not the pro-forma's ${money(total)}` };
  }
  if (withheldMinor >= credit) return { problem: `withheld ${money(withheldMinor)} must be less than the credit, ${money(credit)}` };
  return { now: money(credit - withheldMinor), later: withheldMinor > 0n ? money(withheldMinor) : null };
}

/** Whether the share withheld at source still waits for its certificate. */
export const certificateDue = (payment: AdminPayment): boolean =>
  payment.transfer !== null && !/^0(\.0+)?$/.test(payment.transfer.withheld) && payment.certificateType === null;

/** Who cancelled a pro-forma: its owner, or FF. */
const cancelledBy = (payment: Pick<AdminPayment, 'cancelledBy'>): string => (payment.cancelledBy?.startsWith('operator:') ? 'by FF' : 'by its owner');

/** Where a payment stands, for the tables: the transfer, then the share withheld at source, if any; or that it was cancelled (P-74). */
export function paymentState(payment: AdminPayment): { label: string; note: string | null } {
  const { transfer, currency } = payment;
  if (!transfer && payment.cancelledAt) return { label: `Cancelled ${whenUtc(payment.cancelledAt)}`, note: `${cancelledBy(payment)}; a transfer that comes anyway can still be recorded` };
  if (!transfer) return { label: 'Waiting for the transfer', note: null };
  const label = `Received ${transfer.receivedOn}: ${formatMoney(transfer.credited, currency)} credited`;
  const notes: string[] = [];
  if (!/^0(\.0+)?$/.test(transfer.withheld)) {
    const withheld = formatMoney(transfer.withheld, currency);
    notes.push(transfer.withheldCreditedAt ? `${withheld} withheld: certificate added ${whenUtc(transfer.withheldCreditedAt)}` : `${withheld} withheld: certificate to add`);
  }
  if (payment.cancelledAt) notes.push(`it had been cancelled ${cancelledBy(payment)} ${whenUtc(payment.cancelledAt)}`);
  return { label, note: notes.length ? notes.join('; ') : null };
}

/** Whether a transfer can be recorded against it: pending, or cancelled, as a transfer may come anyway. */
export const canRecord = (payment: Pick<AdminPayment, 'status'>): boolean => payment.status === 'pending' || payment.status === 'cancelled';

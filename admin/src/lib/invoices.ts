import { formatMoney } from './money';

/**
 * Invoices, as the admin routes give them (P-36, D9): a month's drafts, worked
 * out from the payments not invoiced yet, and the issued invoices and credit
 * notes. Money is a string with every decimal of its currency.
 * contract.test.ts checks the fields and kinds against the API's.
 */
export type InvoiceKind = 'invoice' | 'credit_note';

export const INVOICE_KINDS: Array<{ value: InvoiceKind; label: string }> = [
  { value: 'invoice', label: 'Invoice' },
  { value: 'credit_note', label: 'Credit note' },
];

export interface AdminInvoice {
  id: string;
  kind: InvoiceKind;
  number: string;
  month: string | null;
  issuedOn: string;
  currency: string;
  subtotal: string;
  vat: string;
  stampDuty: string;
  total: string;
  corrects: string | null;
  reason: string | null;
  accountId: string;
  buyerName: string;
  buyerTaxId: string | null;
  issuedBy: string;
  withheld: string;
}

/** AdminInvoiceView's fields after the customer's view's, in the API's order. */
export const ADMIN_INVOICE_FIELDS = ['accountId', 'buyerName', 'buyerTaxId', 'issuedBy', 'withheld'] as const;

export interface DraftLine {
  paymentId: string;
  reference: string;
  receivedOn: string;
  description: string;
  amount: string;
  vatPercent: number;
  vat: string;
}

export interface Draft {
  accountId: string;
  buyerName: string;
  buyerTaxId: string | null;
  currency: string;
  lines: DraftLine[];
  subtotal: string;
  vat: string;
  stampDuty: string;
  total: string;
  withheld: string;
}

export interface DraftsPage {
  month: string;
  /** Whether the month is over in Tunisia, so its invoices can be issued. */
  issuable: boolean;
  drafts: Draft[];
}

export interface IssueResult {
  issued: AdminInvoice[];
  failed: Array<{ accountId: string; problem: string }>;
}

/** "October 2026", from a month, YYYY-MM. */
export const monthName = (month: string): string => new Date(`${month}-01T00:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Last month, in Tunisia, where it is an hour ahead of UTC: the month whose invoices are issued now. */
export function lastMonthInTunisia(now: Date): string {
  const tunis = new Date(now.getTime() + 3_600_000);
  return new Date(Date.UTC(tunis.getUTCFullYear(), tunis.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}

/** What a document is, for the tables: an invoice by its month, a credit note by the invoice it corrects. */
export const invoiceLabel = (invoice: Pick<AdminInvoice, 'kind' | 'month' | 'corrects'>): string =>
  invoice.kind === 'invoice' ? `Invoice, ${monthName(invoice.month as string)}` : `Credit note for ${invoice.corrects ?? 'an invoice'}`;

/** The drafts added up, for the "Issue all" dialog: how many, and their totals, in their currency (one, TND). */
export function draftsTotal(drafts: Draft[]): string {
  if (drafts.length === 0) return 'nothing';
  const currency = drafts[0].currency;
  const digits = drafts[0].total.split('.')[1]?.length ?? 0;
  const minor = drafts.reduce((sum, draft) => sum + BigInt(draft.total.replace('.', '')), 0n);
  const text = minor.toString().padStart(digits + 1, '0');
  return formatMoney(digits ? `${text.slice(0, -digits)}.${text.slice(-digits)}` : text, currency);
}

/** What issuing did, for the notice: the numbers issued, then each failure with its reason. */
export function issueNotice(result: IssueResult): { ok: boolean; text: string } {
  const numbers = result.issued.map((invoice) => invoice.number);
  const issued =
    numbers.length === 0 ? 'Nothing issued.' : numbers.length === 1 ? `Issued ${numbers[0]}.` : `Issued ${numbers.length} invoices, ${numbers[0]} to ${numbers[numbers.length - 1]}.`;
  const failed = result.failed.map((failure) => ` ${failure.accountId}: ${failure.problem}`).join(';');
  return { ok: result.failed.length === 0, text: result.failed.length === 0 ? issued : `${issued} Not issued:${failed}.` };
}

/** A document's file name: its number, as the API names the download. */
export const invoiceFileName = (invoice: Pick<AdminInvoice, 'number'>): string => `${invoice.number}.pdf`;

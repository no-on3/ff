import PDFDocument from 'pdfkit';
import { frenchDay, frenchDecimal, frenchMoney, frenchMonth, frenchPercent, groupDigits } from '../../common/french';
import { Statement } from './statement';

/** Who sells, as the configuration names FF (P-35's FF_SELLER_*). */
export interface Seller {
  name: string;
  taxId: string | null;
  address: string;
}

/** Who buys: the account, as it was on the issue date. */
export interface Buyer {
  name: string;
  taxId: string | null;
  accountId: string;
}

export interface DocumentLine {
  description: string;
  amountMinor: bigint;
  vatPercent: number;
  vatMinor: bigint;
}

/** An invoice or a credit note, as its PDF shows it (P-36). */
export interface InvoiceDocument {
  kind: 'invoice' | 'credit_note';
  number: string;
  /** YYYY-MM-DD, in Tunisia. */
  issuedOn: string;
  /** An invoice's month, YYYY-MM. */
  month: string | null;
  /** A credit note's invoice, by its number. */
  corrects: string | null;
  /** Why a credit note was issued. */
  reason: string | null;
  seller: Seller;
  buyer: Buyer;
  currency: string;
  exponent: number;
  lines: DocumentLine[];
  subtotalMinor: bigint;
  vatMinor: bigint;
  stampDutyMinor: bigint;
  totalMinor: bigint;
  /** An invoice's payments: what reached FF's account, and what the buyer withheld at source. */
  paid: { receivedMinor: bigint; withheldMinor: bigint } | null;
  /** The month's usage statement, attached to an invoice. */
  statement: Statement | null;
}

const PAGE = { width: 595.28, height: 841.89, margin: 50 };
const RIGHT = PAGE.width - PAGE.margin;
const BOTTOM = PAGE.height - 70;
const FONT = 'Helvetica';
const BOLD = 'Helvetica-Bold';

/** The characters the PDF's standard fonts can write (Windows-1252), so nothing is dropped unseen. */
const WIN_ANSI = /^[\x20-\x7e\xa0-\xff\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2013\u2014\u2018-\u201a\u201c-\u201e\u2020-\u2022\u2026\u2030\u2039\u203a\u20ac\u2122\n]*$/;

/** A text fit for the standard fonts: the narrow no-break space becomes a no-break space; anything else they lack is refused. */
export function pdfText(text: string): string {
  const fitted = text.replace(/\u202f/g, '\u00a0');
  if (!WIN_ANSI.test(fitted)) throw new Error(`"${text}" has a character the PDF's fonts can't write`);
  return fitted;
}

/** A PDF document of A4 pages, written top to bottom, a new page when the next lines don't fit. */
class Pages {
  readonly doc: PDFKit.PDFDocument;
  y = PAGE.margin;

  constructor(title: string, author: string, at: Date) {
    this.doc = new PDFDocument({
      size: 'A4',
      margin: PAGE.margin,
      autoFirstPage: true,
      bufferPages: true, // the footer's page count, written once every page exists
      info: { Title: pdfText(title), Author: pdfText(author), Creator: 'FF', Producer: 'FF', CreationDate: at },
    });
  }

  /** A line of text at x, from the current y, in a width, aligned. */
  text(x: number, text: string, options: { font?: string; size?: number; width?: number; align?: 'left' | 'right'; y?: number } = {}): number {
    const size = options.size ?? 10;
    this.doc.font(options.font ?? FONT).fontSize(size);
    const width = options.width ?? RIGHT - x;
    const y = options.y ?? this.y;
    this.doc.text(pdfText(text), x, y, { width, align: options.align ?? 'left', lineGap: 1 });
    return this.doc.heightOfString(pdfText(text), { width, lineGap: 1 });
  }

  /** A label on the left of the right column, and its amount at the right edge. */
  pair(label: string, amount: string, options: { bold?: boolean; x?: number } = {}): void {
    const font = options.bold ? BOLD : FONT;
    const x = options.x ?? 330;
    this.text(x, label, { font, width: 140 });
    this.text(x + 140, amount, { font, width: RIGHT - x - 140, align: 'right' });
    this.y += 16;
  }

  rule(weight = 0.5): void {
    this.doc.moveTo(PAGE.margin, this.y).lineTo(RIGHT, this.y).lineWidth(weight).strokeColor('#555555').stroke();
    this.y += 6;
  }

  /** Room for `height` more points, or a new page. */
  room(height: number): void {
    if (this.y + height > BOTTOM) {
      this.doc.addPage();
      this.y = PAGE.margin;
    }
  }

  footer(text: string): void {
    const range = this.doc.bufferedPageRange();
    for (let page = range.start; page < range.start + range.count; page++) {
      this.doc.switchToPage(page);
      // Below the bottom margin, where pdfkit would otherwise start a page for it.
      const { bottom } = this.doc.page.margins;
      this.doc.page.margins.bottom = 0;
      this.text(PAGE.margin, `${text} · Page ${page - range.start + 1}/${range.count}`, { size: 7.5, y: PAGE.height - 40, align: 'left' });
      this.doc.page.margins.bottom = bottom;
    }
  }

  finish(): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      this.doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      this.doc.on('end', () => resolve(Buffer.concat(chunks)));
      this.doc.on('error', reject);
      this.doc.end();
    });
  }
}

/** The seller's line at the foot of every page. */
const sellerLine = (seller: Seller) => [seller.name, seller.address, seller.taxId ? `Matricule fiscal : ${seller.taxId}` : null].filter(Boolean).join(' · ');

function parties(pages: Pages, seller: Seller, buyer: Buyer): void {
  const top = pages.y;
  pages.y += pages.text(PAGE.margin, seller.name, { font: BOLD, size: 12, width: 260 }) + 2;
  pages.y += pages.text(PAGE.margin, seller.address, { width: 260 });
  if (seller.taxId) pages.y += pages.text(PAGE.margin, `Matricule fiscal : ${seller.taxId}`, { width: 260 });
  const left = pages.y;

  pages.y = top;
  pages.y += pages.text(330, 'Client', { font: BOLD, size: 9 });
  pages.y += pages.text(330, buyer.name, { font: BOLD, size: 11 }) + 2;
  if (buyer.taxId) pages.y += pages.text(330, `Matricule fiscal : ${buyer.taxId}`);
  pages.y += pages.text(330, `Compte FF : ${buyer.accountId}`);
  pages.y = Math.max(left, pages.y) + 18;
}

interface Column {
  title: string;
  x: number;
  width: number;
  right?: boolean;
}

/** One of the statement's tables: its header again at the top of each new page, a line per row, as tall as its first cell. */
function table(pages: Pages, columns: Column[], rows: string[][], empty?: string): void {
  const header = () => {
    for (const column of columns) pages.text(column.x, column.title, { font: BOLD, width: column.width, align: column.right ? 'right' : 'left' });
    pages.y += 14;
    pages.rule();
  };
  header();
  if (rows.length === 0 && empty) pages.y += pages.text(PAGE.margin, empty) + 6;
  for (const row of rows) {
    pages.room(18);
    if (pages.y === PAGE.margin) header();
    const heights = row.map((cell, index) => pages.text(columns[index].x, cell, { width: columns[index].width, align: columns[index].right ? 'right' : 'left' }));
    pages.y += Math.max(heights[0], 12) + 4;
  }
  pages.rule();
}

/** The statement's pages: each function's month, each database's, each bucket's, each queue's, then the month's lines and what it was charged. */
function statementPages(pages: Pages, statement: Statement, buyer: Buyer, seller: Seller, attached: boolean): void {
  const money = (minor: bigint) => frenchMoney(minor, statement.exponent, statement.currency);
  if (attached) {
    pages.doc.addPage();
    pages.y = PAGE.margin;
  }
  pages.y += pages.text(PAGE.margin, 'Relevé de consommation', { font: BOLD, size: 16 }) + 2;
  pages.y += pages.text(PAGE.margin, `${frenchMonth(statement.month)} (mois en temps universel)`, { size: 11 }) + 12;
  if (!attached) parties(pages, seller, buyer);
  else pages.y += pages.text(PAGE.margin, `${buyer.name} · Compte FF : ${buyer.accountId}`) + 12;

  const amount = { title: 'Montant HT', x: 460, width: RIGHT - 460, right: true };
  const databases = statement.resources.filter((resource) => resource.kind === 'database');
  const buckets = statement.resources.filter((resource) => resource.kind === 'bucket');
  const queues = statement.resources.filter((resource) => resource.kind === 'queue');
  const caches = statement.resources.filter((resource) => resource.kind === 'cache');
  if (statement.functions.length > 0 || statement.resources.length === 0) {
    table(
      pages,
      [{ title: 'Fonction', x: PAGE.margin, width: 220 }, { title: 'Requêtes', x: 275, width: 80, right: true }, { title: 'GB-secondes', x: 360, width: 95, right: true }, amount],
      statement.functions.map((fn) => [fn.name, groupDigits(fn.requests.toString()), frenchDecimal(fn.gbSeconds), money(fn.amountMinor)]),
      'Aucune consommation ce mois-ci.',
    );
  }
  if (databases.length > 0) {
    if (statement.functions.length > 0) pages.y += 10;
    pages.room(50);
    // Storage by the GB-month, as RDS bills it: the size measured each hour, over the month's hours.
    table(
      pages,
      [{ title: 'Base de données', x: PAGE.margin, width: 300 }, { title: 'Go-mois', x: 360, width: 95, right: true }, amount],
      databases.map((database) => [database.name, frenchDecimal(database.gbMonths), money(database.amountMinor)]),
    );
  }
  if (buckets.length > 0) {
    if (statement.functions.length > 0 || databases.length > 0) pages.y += 10;
    pages.room(50);
    // As S3 bills them: storage by the GB-month, from each hour's measure; requests by its two classes, PUT, COPY,
    // POST and LIST, then GET and the others, deletes free.
    table(
      pages,
      [
        { title: 'Bucket', x: PAGE.margin, width: 170 },
        { title: 'Go-mois', x: 225, width: 70, right: true },
        { title: 'PUT, LIST…', x: 300, width: 75, right: true },
        { title: 'GET…', x: 380, width: 75, right: true },
        amount,
      ],
      buckets.map((bucket) => [
        bucket.name,
        frenchDecimal(bucket.gbMonths),
        groupDigits(bucket.tier1Requests.toString()),
        groupDigits(bucket.tier2Requests.toString()),
        money(bucket.amountMinor),
      ]),
    );
  }
  if (queues.length > 0) {
    if (statement.functions.length > 0 || databases.length > 0 || buckets.length > 0) pages.y += 10;
    pages.room(50);
    // As SQS bills them: each 64 KB of a request's messages a request.
    table(
      pages,
      [{ title: "File d'attente", x: PAGE.margin, width: 300 }, { title: 'Requêtes', x: 360, width: 95, right: true }, amount],
      queues.map((queue) => [queue.name, groupDigits(queue.requests.toString()), money(queue.amountMinor)]),
    );
  }
  if (caches.length > 0) {
    if (statement.functions.length > 0 || databases.length > 0 || buckets.length > 0 || queues.length > 0) pages.y += 10;
    pages.room(50);
    // As ElastiCache bills a node: its memory by the hour, whatever its keys use.
    table(
      pages,
      [{ title: 'Cache', x: PAGE.margin, width: 220 }, { title: 'Heures', x: 275, width: 80, right: true }, { title: 'Go-heures', x: 360, width: 95, right: true }, amount],
      caches.map((cache) => [cache.name, groupDigits(cache.hours.toString()), frenchDecimal(cache.gbHours), money(cache.amountMinor)]),
    );
  }
  pages.room(110);
  pages.pair('Consommation', money(statement.usageMinor));
  if (statement.freeTierMinor !== 0n) pages.pair('Franchise gratuite', money(statement.freeTierMinor));
  if (statement.volumeTiersMinor !== 0n) pages.pair('Paliers de volume', money(statement.volumeTiersMinor));
  if (statement.monthlyFeeMinor !== 0n) pages.pair('Abonnement mensuel', money(statement.monthlyFeeMinor));
  pages.pair('Total HT', money(statement.totalMinor), { bold: true });
  pages.y += 8;
  pages.y += pages.text(PAGE.margin, `Débité du crédit prépayé : ${money(statement.debitedMinor)}.`) + 4;
  if (statement.shadowMinor !== 0n) {
    pages.y += pages.text(PAGE.margin, `Évalué pendant la période d'essai de la facturation, sans être débité : ${money(statement.shadowMinor)}.`) + 4;
  }
  if (!statement.complete) {
    const rated = statement.ratedUntil
      ? `Le mois n'est évalué que jusqu'au ${frenchDay(statement.ratedUntil.toISOString().slice(0, 10))} à ${statement.ratedUntil.toISOString().slice(11, 16)} UTC`
      : "Le mois n'est pas encore évalué";
    pages.y += pages.text(PAGE.margin, `${rated} : ce relevé n'est pas définitif.`) + 4;
  }
  pages.text(PAGE.margin, 'Montants hors taxe : la TVA a été facturée à l\'achat du crédit prépayé, qui règle cette consommation.', { size: 8.5 });
}

/** An invoice or credit note, in French, with an invoice's usage statement on the pages after it (P-36, D9). */
export function renderInvoicePdf(document: InvoiceDocument, at = new Date()): Promise<Buffer> {
  const money = (minor: bigint) => frenchMoney(minor, document.exponent, document.currency);
  const invoice = document.kind === 'invoice';
  const pages = new Pages(`${invoice ? 'Facture' : 'Facture d\'avoir'} ${document.number}`, document.seller.name, at);

  pages.text(330, invoice ? 'FACTURE' : "FACTURE D'AVOIR", { font: BOLD, size: 18, align: 'right' });
  pages.y += 26;
  pages.text(330, `N° ${document.number}`, { font: BOLD, size: 11, align: 'right' });
  pages.y += 16;
  pages.text(330, `Date : ${frenchDay(document.issuedOn)}`, { align: 'right' });
  pages.y += 14;
  pages.text(330, invoice ? `Période : ${frenchMonth(document.month as string)}` : `Facture corrigée : ${document.corrects}`, { align: 'right' });
  pages.y += 30;
  parties(pages, document.seller, document.buyer);

  pages.text(PAGE.margin, 'Désignation', { font: BOLD, width: 250 });
  pages.text(305, 'Montant HT', { font: BOLD, width: 90, align: 'right' });
  pages.text(400, 'TVA', { font: BOLD, width: 45, align: 'right' });
  pages.text(450, 'Montant TVA', { font: BOLD, width: RIGHT - 450, align: 'right' });
  pages.y += 14;
  pages.rule();
  for (const line of document.lines) {
    pages.room(30);
    const height = pages.text(PAGE.margin, line.description, { width: 250 });
    pages.text(305, money(line.amountMinor), { width: 90, align: 'right' });
    pages.text(400, frenchPercent(line.vatPercent), { width: 45, align: 'right' });
    pages.text(450, money(line.vatMinor), { width: RIGHT - 450, align: 'right' });
    pages.y += Math.max(height, 12) + 6;
  }
  pages.rule();
  pages.room(120);

  pages.pair('Total HT', money(document.subtotalMinor));
  const rates = new Map<number, bigint>();
  for (const line of document.lines) rates.set(line.vatPercent, (rates.get(line.vatPercent) ?? 0n) + line.vatMinor);
  for (const [percent, vat] of [...rates.entries()].sort(([a], [b]) => a - b)) pages.pair(`TVA ${frenchPercent(percent)}`, money(vat));
  if (invoice) pages.pair('Droit de timbre', money(document.stampDutyMinor));
  pages.pair(invoice ? 'Total TTC' : 'Total TTC de l\'avoir', money(document.totalMinor), { bold: true });
  pages.y += 12;

  if (invoice && document.paid) {
    const withheld = document.paid.withheldMinor > 0n ? `, dont ${money(document.paid.withheldMinor)} retenus à la source par le client` : '';
    pages.y += pages.text(PAGE.margin, `Crédit prépayé réglé par virement bancaire : ${money(document.paid.receivedMinor + document.paid.withheldMinor)}${withheld}.`) + 4;
    if (document.stampDutyMinor > 0n) pages.y += pages.text(PAGE.margin, 'Le droit de timbre est prélevé sur le crédit prépayé.') + 4;
  }
  if (!invoice) pages.y += pages.text(PAGE.margin, `Motif : ${document.reason}`) + 4;
  if (invoice && document.statement) {
    pages.y += 6;
    pages.text(PAGE.margin, 'La consommation est débitée du crédit prépayé, facturé à l\'achat : elle n\'est pas facturée à nouveau. Son relevé du mois est joint.', { size: 8.5 });
  }

  if (document.statement) statementPages(pages, document.statement, document.buyer, document.seller, true);
  pages.footer(`${sellerLine(document.seller)} · ${document.number}`);
  return pages.finish();
}

/** A month's usage statement alone, for a month without an invoice, or to read before the invoice (P-36, D9). */
export function renderStatementPdf(statement: Statement, seller: Seller, buyer: Buyer, at = new Date()): Promise<Buffer> {
  const pages = new Pages(`Relevé de consommation ${statement.month}`, seller.name, at);
  statementPages(pages, statement, buyer, seller, false);
  pages.footer(`${sellerLine(seller)} · Relevé ${statement.month} · Compte FF ${buyer.accountId}`);
  return pages.finish();
}

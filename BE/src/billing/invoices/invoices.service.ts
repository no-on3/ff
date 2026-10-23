import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { Account } from '../../accounts/entities/account.entity';
import { Membership } from '../../accounts/entities/membership.entity';
import { AuditService } from '../../audit/audit.service';
import { describeError } from '../../common/describe-error';
import { currentRequest } from '../../common/request-context';
import { Language, recipientsOf } from '../../mail/language';
import { Mail, MailService } from '../../mail/mail.service';
import { ObjectStoreService } from '../../object-store/object-store.service';
import { billingCurrency } from '../billing-currency';
import { LedgerAccountType } from '../ledger/ledger-account.entity';
import { LedgerTransactionKind } from '../ledger/ledger-transaction.entity';
import { LedgerService } from '../ledger/ledger.service';
import { formatMinor, parseMinor } from '../money';
import { Payment, PaymentStatus } from '../payments/payment.entity';
import { vatOf } from '../payments/pro-forma';
import { bookPrices } from '../price-book';
import { monthBounds, PricingService } from '../pricing.service';
import { stampDutyOn } from '../tax-rates';
import { RESOURCE_SUMS, ResourceRow, resourceUsage } from '../usage-sql';
import { lastDay, MONTH, previousMonth, tunisDay } from '../tunisia';
import { frenchDay } from '../../common/french';
import { InvoiceLine } from './invoice-line.entity';
import { invoiceNumber, pdfKey } from './invoice-number';
import { Buyer, DocumentLine, InvoiceDocument, renderInvoicePdf, renderStatementPdf, Seller } from './invoice-pdf';
import { Invoice, INVOICE_SERIES, InvoiceKind } from './invoice.entity';
import { creditNoteMail, invoiceMail } from './invoice-mail';
import { AdminInvoicesPage, AdminInvoiceView, DraftView, IssueResult, INVOICES_CURSOR, InvoiceView } from './invoices.dto';
import { buildStatement, Statement } from './statement';

const HOUR_MS = 3_600_000;

/** An invoice's own columns, as it is written: no relation. */
type InvoiceRow = Omit<Invoice, 'account' | 'corrects' | 'currencyRow' | 'stampTransaction'>;

/** A line asked for on a credit note: its text, the amount before tax, and the invoice's VAT rate it takes. */
export interface CreditNoteLineEntry {
  description: string;
  amount: string;
  vatPercent?: number;
}

/** A month's invoice for an account, before it is issued: its payments not invoiced yet. */
interface Draft {
  account: Account;
  month: string;
  currency: string;
  exponent: number;
  payments: Payment[];
  lines: Array<DocumentLine & { payment: Payment }>;
  subtotalMinor: bigint;
  vatMinor: bigint;
  withheldMinor: bigint;
}

/**
 * Monthly invoices (P-36, D9; parent §8.6, B-05). A month's invoice lists the
 * credit an account bought: each payment received up to the month's end and
 * not invoiced yet is a line, its credit before tax and its VAT. Until it is
 * issued it is a draft, worked out from those payments, so a transfer
 * recorded late joins it. Issuing it, an operator's act, numbers it without
 * gap in its fiscal year, takes the stamp duty from the credit, writes its
 * PDF with the month's usage statement, and writes it, never to change: a
 * correction is a credit note, with numbers of its own. Each act goes in the
 * audit log, and the owners get an e-mail.
 */
@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
    private readonly pricing: PricingService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly storage: ObjectStoreService,
    private readonly config: ConfigService,
  ) {}

  /** The month operators issue now: last month, in Tunisia. */
  static lastMonth(now = new Date()): string {
    return previousMonth(tunisDay(now).slice(0, 7));
  }

  /** GET /admin/invoices/drafts: a month's invoices still to issue, each with its lines and totals. */
  async drafts(month: string, now = new Date()): Promise<{ month: string; issuable: boolean; drafts: DraftView[] }> {
    const drafts = await this.draftsIn(this.dataSource.manager, month);
    const today = tunisDay(now);
    const views = await Promise.all(
      drafts.map(async (draft) => {
        const stampMinor = await stampDutyOn(this.dataSource.manager, today, draft.currency);
        const money = (minor: bigint) => formatMinor(minor, draft.exponent);
        return {
          accountId: draft.account.id,
          buyerName: draft.account.name,
          buyerTaxId: draft.account.taxId,
          currency: draft.currency,
          lines: draft.lines.map((line) => ({
            paymentId: line.payment.id,
            reference: line.payment.reference,
            receivedOn: line.payment.receivedOn as string,
            description: line.description,
            amount: money(line.amountMinor),
            vatPercent: line.vatPercent,
            vat: money(line.vatMinor),
          })),
          subtotal: money(draft.subtotalMinor),
          vat: money(draft.vatMinor),
          stampDuty: money(stampMinor),
          total: money(draft.subtotalMinor + draft.vatMinor + stampMinor),
          withheld: money(draft.withheldMinor),
        };
      }),
    );
    return { month, issuable: lastDay(month) < today, drafts: views };
  }

  /** POST /admin/invoices/issue: each draft of the month, or the accounts' named, one after the other; a failure doesn't stop the rest. */
  async issueAll(month: string, accountIds: string[] | undefined, reason: string, now = new Date()): Promise<IssueResult> {
    const accounts = accountIds ?? [...new Set((await this.draftsIn(this.dataSource.manager, month)).map((draft) => draft.account.id))];
    const result: IssueResult = { issued: [], failed: [] };
    for (const accountId of accounts) {
      try {
        result.issued.push(await this.issue(accountId, month, reason, now));
      } catch (error) {
        result.failed.push({ accountId, problem: describeError(error) });
      }
    }
    return result;
  }

  /**
   * Issues an account's invoice for a month that is over: its number, the
   * stamp duty taken from the credit, its PDF with the month's statement, and
   * the invoice itself, in one transaction. The account is locked, so the same
   * invoice is never issued twice; the counter is locked while it is
   * numbered, so numbers follow each other without gap.
   */
  async issue(accountId: string, month: string, reason: string, now = new Date()): Promise<AdminInvoiceView> {
    if (!MONTH.test(month)) throw new BadRequestException(`"${month}" is not a month, such as 2026-10`);
    const today = tunisDay(now);
    if (lastDay(month) >= today) throw new ConflictException(`${month} isn't over in Tunisia: its invoices are issued from the 1st of the next month`);

    const issued = await this.dataSource.transaction(async (manager) => {
      const account = await manager.findOne(Account, { where: { id: accountId }, lock: { mode: 'pessimistic_write' } });
      if (!account) throw new NotFoundException(`Account ${accountId} not found`);
      const existing = await manager.findOneBy(Invoice, { accountId, month, kind: InvoiceKind.INVOICE });
      if (existing) throw new ConflictException(`${account.name}'s invoice for ${month} was issued: ${existing.number}`);
      const [draft] = await this.draftsIn(manager, month, accountId);
      if (!draft) throw new ConflictException(`Nothing to invoice for ${account.name} in ${month}: no payment received by its end waits for an invoice`);

      const stampMinor = await stampDutyOn(manager, today, draft.currency);
      const statement = await this.statementIn(manager, accountId, month, now);
      const fiscalYear = Number(today.slice(0, 4));
      const id = randomUUID();
      const stamp =
        stampMinor > 0n
          ? await this.ledger.postIn(manager, {
              kind: LedgerTransactionKind.INVOICE,
              idempotencyKey: `stamp:${id}`,
              currency: draft.currency,
              occurredAt: now,
              metadata: { invoice: id, month },
              entries: [
                { account: { wallet: accountId }, amountMinor: -stampMinor },
                { account: { ff: LedgerAccountType.STAMP_DUTY }, amountMinor: stampMinor },
              ],
            })
          : null;
      const sequence = await this.nextNumber(manager, INVOICE_SERIES[InvoiceKind.INVOICE], fiscalYear);
      const number = invoiceNumber(INVOICE_SERIES[InvoiceKind.INVOICE], fiscalYear, sequence);
      const invoice: InvoiceRow = {
        id,
        accountId,
        kind: InvoiceKind.INVOICE,
        number,
        fiscalYear,
        sequence,
        month,
        issuedOn: today,
        issuedAt: now,
        issuedBy: currentRequest()?.actor?.id ?? 'system',
        currency: draft.currency,
        subtotalMinor: draft.subtotalMinor,
        vatMinor: draft.vatMinor,
        stampDutyMinor: stampMinor,
        totalMinor: draft.subtotalMinor + draft.vatMinor + stampMinor,
        withheldMinor: draft.withheldMinor,
        buyerName: account.name,
        buyerTaxId: account.taxId,
        correctsId: null,
        reason: null,
        pdfKey: pdfKey(number),
        stampTransactionId: stamp?.transaction.id ?? null,
      };
      const received = draft.payments.reduce((sum, payment) => sum + (payment.receivedMinor as bigint), 0n);
      const pdf = await renderInvoicePdf(
        this.document(invoice, draft.exponent, draft.lines, { receivedMinor: received, withheldMinor: draft.withheldMinor }, statement, null),
        now,
      );
      // Kept before the invoice is written: if the database refuses it, the number is given again, and its PDF written over.
      await this.storage.putDocument(invoice.pdfKey, pdf, 'application/pdf');
      // A copy: insert() writes the columns' defaults back into what it is given, unconverted.
      await manager.insert(Invoice, { ...invoice });
      await manager.insert(
        InvoiceLine,
        draft.lines.map((line, index) => ({
          invoiceId: id,
          lineNo: index + 1,
          paymentId: line.payment.id,
          description: line.description,
          amountMinor: line.amountMinor,
          vatPercent: line.vatPercent,
          vatMinor: line.vatMinor,
        })),
      );
      await this.audit.record(
        {
          accountId,
          action: 'invoice.issue',
          resource: `invoice:${id}`,
          details: { reason, number, month, currency: draft.currency, total: formatMinor(invoice.totalMinor, draft.exponent), stampDuty: formatMinor(stampMinor, draft.exponent) },
        },
        manager,
      );
      return { invoice, exponent: draft.exponent, account };
    });
    await this.tellOwners(issued.account, (consoleUrl, language) => invoiceMail({ account: issued.account, invoice: issued.invoice, exponent: issued.exponent, consoleUrl }, language));
    return this.adminView(issued.invoice, issued.exponent);
  }

  /**
   * Issues a credit note against an issued invoice (D9: a correction is a
   * credit note, never an edit): its lines, before tax, each at one of the
   * invoice's VAT rates. All the credit notes of an invoice give back no more
   * than it charged, before tax and in VAT. It carries no stamp duty, and moves
   * no money: a refund is P-74's.
   */
  async creditNote(invoiceId: string, entries: CreditNoteLineEntry[], reason: string, now = new Date()): Promise<AdminInvoiceView> {
    const today = tunisDay(now);
    const issued = await this.dataSource.transaction(async (manager) => {
      const invoice = await manager.findOne(Invoice, { where: { id: invoiceId }, lock: { mode: 'pessimistic_write' } });
      if (!invoice) throw new NotFoundException(`Invoice ${invoiceId} not found`);
      if (invoice.kind !== InvoiceKind.INVOICE) throw new ConflictException(`${invoice.number} is a credit note: a credit note corrects an invoice`);
      const exponent = await this.exponentOf(manager, invoice.currency);
      const rates = [...new Set((await manager.findBy(InvoiceLine, { invoiceId })).map((line) => line.vatPercent))];
      const lines = entries.map((entry, index) => {
        let amountMinor: bigint;
        try {
          amountMinor = parseMinor(entry.amount, exponent);
        } catch (error) {
          throw new BadRequestException(`lines.${index}.amount: ${describeError(error)}`);
        }
        if (amountMinor <= 0n) throw new BadRequestException(`lines.${index}.amount must be more than 0`);
        const vatPercent = entry.vatPercent ?? (rates.length === 1 ? rates[0] : undefined);
        if (vatPercent === undefined) throw new BadRequestException(`lines.${index}.vatPercent: ${invoice.number} has the VAT rates ${rates.join(', ')}; name one`);
        if (!rates.includes(vatPercent)) throw new BadRequestException(`lines.${index}.vatPercent must be a VAT rate of ${invoice.number}: ${rates.join(', ')}`);
        return { description: entry.description.trim(), amountMinor, vatPercent, vatMinor: vatOf(amountMinor, vatPercent) };
      });
      const subtotalMinor = lines.reduce((sum, line) => sum + line.amountMinor, 0n);
      const vatMinor = lines.reduce((sum, line) => sum + line.vatMinor, 0n);
      const [before] = await manager.query<Array<{ subtotal: string; vat: string }>>(
        `SELECT coalesce(sum("subtotal_minor"), 0)::text AS "subtotal", coalesce(sum("vat_minor"), 0)::text AS "vat" FROM "invoices" WHERE "corrects_id" = $1`,
        [invoiceId],
      );
      const money = (minor: bigint) => `${formatMinor(minor, exponent)} ${invoice.currency}`;
      if (BigInt(before.subtotal) + subtotalMinor > invoice.subtotalMinor || BigInt(before.vat) + vatMinor > invoice.vatMinor) {
        throw new BadRequestException(
          `${invoice.number}'s credit notes would give back ${money(BigInt(before.subtotal) + subtotalMinor)} before tax and ${money(BigInt(before.vat) + vatMinor)} of VAT: it charged ${money(invoice.subtotalMinor)} and ${money(invoice.vatMinor)}`,
        );
      }
      const fiscalYear = Number(today.slice(0, 4));
      const sequence = await this.nextNumber(manager, INVOICE_SERIES[InvoiceKind.CREDIT_NOTE], fiscalYear);
      const number = invoiceNumber(INVOICE_SERIES[InvoiceKind.CREDIT_NOTE], fiscalYear, sequence);
      const id = randomUUID();
      const account = await manager.findOneByOrFail(Account, { id: invoice.accountId });
      const note: InvoiceRow = {
        id,
        accountId: invoice.accountId,
        kind: InvoiceKind.CREDIT_NOTE,
        number,
        fiscalYear,
        sequence,
        month: null,
        issuedOn: today,
        issuedAt: now,
        issuedBy: currentRequest()?.actor?.id ?? 'system',
        currency: invoice.currency,
        subtotalMinor,
        vatMinor,
        stampDutyMinor: 0n,
        totalMinor: subtotalMinor + vatMinor,
        withheldMinor: 0n,
        buyerName: account.name,
        buyerTaxId: account.taxId,
        correctsId: invoice.id,
        reason,
        pdfKey: pdfKey(number),
        stampTransactionId: null,
      };
      const pdf = await renderInvoicePdf(this.document(note, exponent, lines, null, null, invoice.number), now);
      await this.storage.putDocument(note.pdfKey, pdf, 'application/pdf');
      await manager.insert(Invoice, { ...note });
      await manager.insert(
        InvoiceLine,
        lines.map((line, index) => ({ invoiceId: id, lineNo: index + 1, paymentId: null, ...line })),
      );
      await this.audit.record(
        {
          accountId: invoice.accountId,
          action: 'invoice.credit_note',
          resource: `invoice:${id}`,
          details: { reason, number, corrects: invoice.number, currency: invoice.currency, total: formatMinor(note.totalMinor, exponent) },
        },
        manager,
      );
      return { note, invoice, exponent, account };
    });
    await this.tellOwners(issued.account, (consoleUrl, language) =>
      creditNoteMail({ account: issued.account, note: issued.note, corrects: issued.invoice.number, exponent: issued.exponent, consoleUrl }, language),
    );
    return this.adminView({ ...issued.note, corrects: issued.invoice }, issued.exponent);
  }

  /** GET /billing/invoices: the account's issued invoices and credit notes, newest first. */
  async forAccount(accountId: string): Promise<InvoiceView[]> {
    const invoices = await this.dataSource.getRepository(Invoice).find({
      where: { accountId },
      relations: { corrects: true },
      order: { issuedAt: 'DESC', id: 'DESC' },
      take: 100,
    });
    return Promise.all(invoices.map(async (invoice) => this.view(invoice, await this.exponentOf(this.dataSource.manager, invoice.currency))));
  }

  /** GET /admin/invoices: every account's issued documents, newest first, a page at a time. */
  async forOperators(
    filter: { accountId?: string; kind?: InvoiceKind; month?: string },
    { limit, before }: { limit: number; before?: string },
  ): Promise<AdminInvoicesPage> {
    const cursor = before ? INVOICES_CURSOR.exec(before) : null;
    const query = this.dataSource
      .getRepository(Invoice)
      .createQueryBuilder('invoice')
      .leftJoinAndSelect('invoice.corrects', 'corrects')
      .addSelect(`to_char(invoice.issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`, 'cursor_at')
      .orderBy('invoice.issuedAt', 'DESC')
      .addOrderBy('invoice.id', 'DESC')
      .limit(limit + 1);
    if (filter.accountId) query.andWhere('invoice.account_id = :accountId', { accountId: filter.accountId });
    if (filter.kind) query.andWhere('invoice.kind = :kind', { kind: filter.kind });
    if (filter.month) query.andWhere('invoice.month = :month', { month: filter.month });
    if (cursor) {
      query.andWhere(`(invoice.issued_at, invoice.id) < (CAST(:beforeAt AS timestamp) AT TIME ZONE 'UTC', CAST(:beforeId AS uuid))`, { beforeAt: cursor[1], beforeId: cursor[2] });
    }
    const { entities, raw } = await query.getRawAndEntities<{ cursor_at: string }>();
    const page = entities.slice(0, limit);
    const last = entities.length > limit ? limit - 1 : -1;
    return {
      invoices: await Promise.all(page.map(async (invoice) => this.adminView(invoice, await this.exponentOf(this.dataSource.manager, invoice.currency)))),
      next: last >= 0 ? `${raw[last].cursor_at}_${page[last].id}` : null,
    };
  }

  /** An issued document's PDF, as it was issued: the account's own for a customer, any for an operator. */
  async pdf(id: string, accountId: string | null): Promise<{ body: Buffer; number: string }> {
    const invoice = await this.dataSource.getRepository(Invoice).findOneBy(accountId === null ? { id } : { id, accountId });
    if (!invoice) throw new NotFoundException(`Invoice ${id} not found`);
    return { body: (await this.storage.getDocument(invoice.pdfKey)).body, number: invoice.number };
  }

  /** GET /billing/statements/:month/pdf: the account's usage statement for a month that has begun. */
  async statementPdf(accountId: string, month: string, now = new Date()): Promise<Buffer> {
    if (!MONTH.test(month)) throw new BadRequestException(`"${month}" is not a month, such as 2026-10`);
    if (month > now.toISOString().slice(0, 7)) throw new BadRequestException(`${month} hasn't begun`);
    const account = await this.dataSource.getRepository(Account).findOneBy({ id: accountId });
    if (!account) throw new NotFoundException(`Account ${accountId} not found`);
    const statement = await this.statementIn(this.dataSource.manager, accountId, month, now);
    return renderStatementPdf(statement, this.seller(), { name: account.name, taxId: account.taxId, accountId }, now);
  }

  /** A month's usage statement (D9), from the hourly sums the rating charged and its charges. */
  async statementIn(manager: EntityManager, accountId: string, month: string, now = new Date()): Promise<Statement> {
    const { from, to } = monthBounds(month);
    const books = (await this.pricing.booksFor(from, to)).map(bookPrices);
    const { currency, exponent } = await billingCurrency(manager, from < now ? from : now);
    const rows = await manager.query<Array<Record<string, string>>>(
      `SELECT "function_id" AS "functionId", "price_book_id" AS "priceBookId",
              sum("on_demand_requests")::text AS "onDemandRequests", sum("on_demand_mb_ms")::text AS "onDemandMbMs",
              sum("provisioned_requests")::text AS "provisionedRequests", sum("provisioned_mb_ms")::text AS "provisionedMbMs",
              sum("provisioned_time_mb_ms")::text AS "provisionedTimeMbMs", sum("reserved_mb_ms")::text AS "reservedMbMs"
         FROM "usage_hourly" WHERE "account_id" = $1 AND "hour" >= $2 AND "hour" < $3
        GROUP BY "function_id", "price_book_id"`,
      [accountId, from, to],
    );
    const names = new Map<string, string>(
      (
        await manager.query<Array<{ id: string; name: string }>>(
          `SELECT "function_id" AS "id", (array_agg("function_name" ORDER BY "started_at" DESC))[1] AS "name"
             FROM "usage_records" WHERE "account_id" = $1 AND "started_at" >= $2 AND "started_at" < $3 GROUP BY "function_id"`,
          [accountId, from, to],
        )
      ).map((row) => [row.id, row.name]),
    );
    const unnamed = [...new Set(rows.map((row) => row.functionId))].filter((id) => !names.has(id));
    if (unnamed.length > 0) {
      for (const row of await manager.query<Array<{ id: string; name: string }>>(`SELECT "id", "name" FROM "functions" WHERE "id" = ANY($1)`, [unnamed])) {
        names.set(row.id, row.name);
      }
    }
    const resources = await manager.query<Array<ResourceRow & { name: string }>>(
      `SELECT ${RESOURCE_SUMS}, (array_agg("name" ORDER BY "hour" DESC))[1] AS "name"
         FROM "resource_usage_hourly" WHERE "account_id" = $1 AND "hour" >= $2 AND "hour" < $3
        GROUP BY "resource_id", "kind", "price_book_id"`,
      [accountId, from, to],
    );
    const [charges] = await manager.query<Array<{ debited: string; shadow: string; latest: Date | null }>>(
      `SELECT coalesce(sum("amount_minor") FILTER (WHERE NOT "shadow"), 0)::text AS "debited",
              coalesce(sum("amount_minor") FILTER (WHERE "shadow"), 0)::text AS "shadow",
              (SELECT max("hour") FROM "rating_runs" WHERE "hour" >= $2 AND "hour" < $3) AS "latest"
         FROM "usage_charges" WHERE "account_id" = $1 AND "hour" >= $2 AND "hour" < $3`,
      [accountId, from, to],
    );
    return buildStatement({
      month,
      currency,
      exponent,
      books,
      rows: rows.map((row) => ({
        functionId: row.functionId,
        priceBookId: row.priceBookId,
        onDemand: { requests: BigInt(row.onDemandRequests), mbMs: BigInt(row.onDemandMbMs) },
        provisioned: { requests: BigInt(row.provisionedRequests), mbMs: BigInt(row.provisionedMbMs) },
        provisionedMbMs: BigInt(row.provisionedTimeMbMs),
        reservedMbMs: BigInt(row.reservedMbMs),
      })),
      names,
      resources: resources.map((row) => ({ ...resourceUsage(row), priceBookId: row.priceBookId, name: row.name })),
      charges: {
        debitedMinor: BigInt(charges.debited),
        shadowMinor: BigInt(charges.shadow),
        ratedUntil: charges.latest ? new Date(new Date(charges.latest).getTime() + HOUR_MS) : null,
      },
      monthEnd: to,
    });
  }

  /** The accounts' payments received up to the month's end and not invoiced yet, for those without the month's invoice, as drafts. */
  private async draftsIn(manager: EntityManager, month: string, accountId?: string): Promise<Draft[]> {
    if (!MONTH.test(month)) throw new BadRequestException(`"${month}" is not a month, such as 2026-10`);
    const query = manager
      .getRepository(Payment)
      .createQueryBuilder('payment')
      .where('payment.status = :paid', { paid: PaymentStatus.PAID })
      .andWhere('payment.received_on <= :end', { end: lastDay(month) })
      .andWhere(`NOT EXISTS (SELECT 1 FROM "invoice_lines" l WHERE l."payment_id" = payment.id)`)
      .andWhere(`NOT EXISTS (SELECT 1 FROM "invoices" i WHERE i."account_id" = payment.account_id AND i."kind" = 'invoice' AND i."month" = :month)`, { month })
      .orderBy('payment.account_id')
      .addOrderBy('payment.received_on')
      .addOrderBy('payment.recorded_at');
    if (accountId) query.andWhere('payment.account_id = :accountId', { accountId }).setLock('pessimistic_write');
    const payments = await query.getMany();
    const byAccount = new Map<string, Payment[]>();
    for (const payment of payments) byAccount.set(payment.accountId, [...(byAccount.get(payment.accountId) ?? []), payment]);
    const drafts: Draft[] = [];
    for (const [id, own] of byAccount) {
      const currencies = new Set(own.map((payment) => payment.currency));
      if (currencies.size > 1) throw new Error(`Account ${id}'s payments to invoice are in ${[...currencies].join(' and ')}: one invoice takes one currency`);
      const account = await manager.findOneByOrFail(Account, { id });
      const lines = own.map((payment) => ({
        payment,
        description: `Crédit prépayé FF : virement reçu le ${frenchDay(payment.receivedOn as string)}, pro forma ${payment.reference}`,
        amountMinor: payment.creditMinor,
        vatPercent: payment.vatPercent,
        vatMinor: payment.vatMinor,
      }));
      drafts.push({
        account,
        month,
        currency: own[0].currency,
        exponent: await this.exponentOf(manager, own[0].currency),
        payments: own,
        lines,
        subtotalMinor: lines.reduce((sum, line) => sum + line.amountMinor, 0n),
        vatMinor: lines.reduce((sum, line) => sum + line.vatMinor, 0n),
        withheldMinor: own.reduce((sum, payment) => sum + (payment.withheldMinor as bigint), 0n),
      });
    }
    return drafts;
  }

  /** The next number of a series in a fiscal year, its counter row locked until the transaction ends. */
  private async nextNumber(manager: EntityManager, series: string, fiscalYear: number): Promise<number> {
    await manager.query(`INSERT INTO "invoice_counters" ("series", "fiscal_year", "last_number") VALUES ($1, $2, 0) ON CONFLICT DO NOTHING`, [series, fiscalYear]);
    // TypeORM answers an UPDATE with [rows, count].
    const [[{ next }]] = await manager.query<[Array<{ next: number }>, number]>(
      `UPDATE "invoice_counters" SET "last_number" = "last_number" + 1 WHERE "series" = $1 AND "fiscal_year" = $2 RETURNING "last_number" AS "next"`,
      [series, fiscalYear],
    );
    return next;
  }

  private document(
    invoice: InvoiceRow,
    exponent: number,
    lines: DocumentLine[],
    paid: { receivedMinor: bigint; withheldMinor: bigint } | null,
    statement: Statement | null,
    corrects: string | null,
  ): InvoiceDocument {
    return {
      kind: invoice.kind,
      number: invoice.number,
      issuedOn: invoice.issuedOn,
      month: invoice.month,
      corrects,
      reason: invoice.reason,
      seller: this.seller(),
      buyer: this.buyer(invoice),
      currency: invoice.currency,
      exponent,
      lines: lines.map(({ description, amountMinor, vatPercent, vatMinor }) => ({ description, amountMinor, vatPercent, vatMinor })),
      subtotalMinor: invoice.subtotalMinor,
      vatMinor: invoice.vatMinor,
      stampDutyMinor: invoice.stampDutyMinor,
      totalMinor: invoice.totalMinor,
      paid,
      statement,
    };
  }

  private seller(): Seller {
    return this.config.getOrThrow<{ seller: Seller }>('billing').seller;
  }

  private buyer(invoice: InvoiceRow): Buyer {
    return { name: invoice.buyerName, taxId: invoice.buyerTaxId, accountId: invoice.accountId };
  }

  private async exponentOf(manager: EntityManager, currency: string): Promise<number> {
    const [{ exponent }] = await manager.query<Array<{ exponent: number }>>(`SELECT "exponent" FROM "currencies" WHERE "code" = $1`, [currency]);
    return exponent;
  }

  /** E-mails each owner, after the change has committed; a failure is logged, never the request's. */
  private async tellOwners(account: Account, mail: (consoleUrl: string, language: Language) => Omit<Mail, 'to'>): Promise<void> {
    try {
      const { consoleUrl } = this.config.getOrThrow<{ consoleUrl: string }>('mail');
      const owners = await this.dataSource.getRepository(Membership).find({ where: { accountId: account.id, role: 'owner' }, relations: { user: true } });
      await this.mail.sendEach(recipientsOf(owners), (language) => mail(consoleUrl, language));
    } catch (error) {
      this.logger.error(`Could not tell the owners of ${account.id} about an invoice: ${describeError(error)}`);
    }
  }

  private view(invoice: InvoiceRow & { corrects?: { number: string } | null }, exponent: number): InvoiceView {
    const money = (minor: bigint) => formatMinor(minor, exponent);
    return {
      id: invoice.id,
      kind: invoice.kind,
      number: invoice.number,
      month: invoice.month,
      issuedOn: invoice.issuedOn,
      currency: invoice.currency,
      subtotal: money(invoice.subtotalMinor),
      vat: money(invoice.vatMinor),
      stampDuty: money(invoice.stampDutyMinor),
      total: money(invoice.totalMinor),
      corrects: invoice.corrects?.number ?? null,
      reason: invoice.reason,
    };
  }

  private adminView(invoice: InvoiceRow & { corrects?: { number: string } | null }, exponent: number): AdminInvoiceView {
    return {
      ...this.view(invoice, exponent),
      accountId: invoice.accountId,
      buyerName: invoice.buyerName,
      buyerTaxId: invoice.buyerTaxId,
      issuedBy: invoice.issuedBy,
      withheld: formatMinor(invoice.withheldMinor, exponent),
    };
  }
}

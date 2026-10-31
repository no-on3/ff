import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, QueryFailedError, Repository } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { AuditService } from '../audit/audit.service';
import { Currency } from '../billing/currency.entity';
import { Decimal } from '../billing/decimal';
import { formatMinor } from '../billing/money';
import { PriceBook } from '../billing/price-book.entity';
import { PriceDocument, priceDocumentProblems, keysLeftOut } from '../billing/price-book';
import { PricingService, monthBounds } from '../billing/pricing.service';
import { BookStatus, PriceBookPreviewView, PriceBookView } from './admin-prices.dto';
import { Operator } from './operator';

const HOUR_MS = 3_600_000;

/** The first instant a new book may start at: the next whole hour, UTC (P-73), so no hour is priced by two books. */
export const earliestStart = (now: Date): Date => new Date((Math.floor(now.getTime() / HOUR_MS) + 1) * HOUR_MS);

/** The month before the one `now` is in, as YYYY-MM by the UTC calendar. */
export const lastMonth = (now: Date): string => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);

function view(book: PriceBook, status: BookStatus): PriceBookView {
  const { id, currency, validFrom, createdBy, createdAt, prices } = book;
  return { id, currency, validFrom, status, createdBy, createdAt, document: prices };
}

/**
 * Price books, for FF's operators (P-73, D8): the list, a new version that
 * starts later, removing one that hasn't started, and a preview of a draft
 * on last month's usage. A book that has started never changes: the
 * database refuses it too.
 */
@Injectable()
export class AdminPricesService {
  constructor(
    @InjectRepository(PriceBook) private readonly books: Repository<PriceBook>,
    @InjectRepository(Currency) private readonly currencies: Repository<Currency>,
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
    private readonly pricing: PricingService,
    private readonly audit: AuditService,
  ) {}

  /** Every book, oldest first: those before the active one are past, those after it scheduled. */
  async list(now = new Date()): Promise<PriceBookView[]> {
    const books = await this.books.find({ order: { validFrom: 'ASC' } });
    let active = -1;
    books.forEach((book, index) => {
      if (book.validFrom <= now) active = index;
    });
    return books.map((book, index) => view(book, index < active ? 'past' : index === active ? 'active' : 'scheduled'));
  }

  /** A new book from `validFrom`, a whole hour from the next one on, with its audit entry, in one transaction. */
  async create(validFrom: Date, document: unknown, operator: Operator, reason: string, now = new Date()): Promise<PriceBookView> {
    const checked = await this.checked(document);
    const earliest = earliestStart(now);
    if (validFrom.getTime() % HOUR_MS !== 0 || validFrom < earliest) {
      throw new BadRequestException(`validFrom must be a whole hour, UTC, from ${earliest.toISOString()} on`);
    }
    const before = await this.books.findOne({ where: { validFrom: LessThan(validFrom) }, order: { validFrom: 'DESC' } });
    const missing = before ? keysLeftOut(before.prices, checked) : [];
    if (missing.length) throw new BadRequestException(missing.map((path) => `${path}: the book before this one has it, so this one must too`));
    const taken = `A price book already starts at ${validFrom.toISOString()}`;
    try {
      const book = await this.books.manager.transaction(async (manager) => {
        const saved = await manager.save(
          PriceBook,
          manager.create(PriceBook, { currency: checked.currency, validFrom, prices: checked, createdBy: `operator:${operator.id}` }),
        );
        await this.audit.record(
          {
            accountId: null,
            action: 'price_book.create',
            resource: `price_book:${saved.id}`,
            details: { reason, validFrom: validFrom.toISOString(), currency: checked.currency, source: checked.source },
          },
          manager,
        );
        return saved;
      });
      return view(book, 'scheduled');
    } catch (error) {
      // The unique index on valid_from: one book an hour.
      if (error instanceof QueryFailedError && (error as QueryFailedError & { code?: string }).code === '23505') throw new ConflictException(taken);
      throw error;
    }
  }

  /** Removes a book that hasn't started, with its audit entry. */
  async remove(id: string, reason: string, now = new Date()): Promise<void> {
    await this.books.manager.transaction(async (manager) => {
      const book = await manager.findOne(PriceBook, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!book) throw new NotFoundException(`Price book ${id} not found`);
      if (book.validFrom <= now) throw new ConflictException(`Price book ${id} started on ${book.validFrom.toISOString()}: it is never changed or deleted`);
      await manager.delete(PriceBook, { id });
      await this.audit.record(
        { accountId: null, action: 'price_book.delete', resource: `price_book:${id}`, details: { reason, validFrom: book.validFrom.toISOString() } },
        manager,
      );
    });
  }

  /** Last month's usage priced with the draft, as if it had been valid all month, next to what the books valid then give. */
  async preview(document: unknown, now = new Date()): Promise<PriceBookPreviewView> {
    const draft = await this.checked(document);
    const month = lastMonth(now);
    const draftBook = { id: 'draft', currency: draft.currency, validFrom: monthBounds(month).from, prices: draft };
    const accountIds = await this.pricing.accountsWithUsage(month);
    const accounts = accountIds.length ? await this.accounts.find({ where: { id: In(accountIds) }, select: { id: true, name: true } }) : [];
    const names = new Map(accounts.map((account) => [account.id, account.name]));
    const { exponent } = await this.currencies.findOneByOrFail({ code: draft.currency });
    // What the hourly rating charged each account (P-32), debited or in shadow mode; none before it rated the month.
    const { from, to } = monthBounds(month);
    const chargedRows = await this.books.manager.query<Array<{ account_id: string; charged: string }>>(
      `SELECT "account_id", sum("amount_minor")::text AS "charged" FROM "usage_charges"
        WHERE "hour" >= $1 AND "hour" < $2 AND "currency" = $3 GROUP BY "account_id"`,
      [from, to, draft.currency],
    );
    const charged = new Map(chargedRows.map((row) => [row.account_id, BigInt(row.charged)]));
    let current = Decimal.ZERO;
    let drafted = Decimal.ZERO;
    const rows = [];
    for (const accountId of accountIds) {
      const atCurrent = await this.pricing.estimate(accountId, month);
      const atDraft = (await this.pricing.estimate(accountId, month, [draftBook])) as NonNullable<Awaited<ReturnType<PricingService['estimate']>>>;
      current = current.plus(atCurrent?.total ?? Decimal.ZERO);
      drafted = drafted.plus(atDraft.total);
      rows.push({
        accountId,
        name: names.get(accountId) ?? '',
        current: atCurrent ? atCurrent.total.toFixed(exponent) : null,
        charged: charged.has(accountId) ? formatMinor(charged.get(accountId) as bigint, exponent) : null,
        draft: atDraft.total.toFixed(exponent),
      });
    }
    const chargedTotal = [...charged.values()].reduce((sum, minor) => sum + minor, 0n);
    return {
      month,
      currency: draft.currency,
      accounts: rows,
      totals: { current: current.toFixed(exponent), charged: charged.size ? formatMinor(chargedTotal, exponent) : null, draft: drafted.toFixed(exponent) },
    };
  }

  /** The document as a book, or 400 with each problem; its currency must be one FF has. */
  private async checked(document: unknown): Promise<PriceDocument> {
    const problems = priceDocumentProblems(document);
    if (problems.length) throw new BadRequestException(problems);
    const checked = document as PriceDocument;
    if (!(await this.currencies.exists({ where: { code: checked.currency } }))) throw new BadRequestException([`currency: FF has no currency ${checked.currency}`]);
    return checked;
  }
}

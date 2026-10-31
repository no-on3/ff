import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { Account } from '../../accounts/entities/account.entity';
import { Membership } from '../../accounts/entities/membership.entity';
import { AuditService } from '../../audit/audit.service';
import { currentRequest } from '../../common/request-context';
import { describeError } from '../../common/describe-error';
import { Language, recipientsOf } from '../../mail/language';
import { Mail, MailService } from '../../mail/mail.service';
import { ObjectStoreService } from '../../object-store/object-store.service';
import { billingCurrency } from '../billing-currency';
import { LedgerAccountType } from '../ledger/ledger-account.entity';
import { LedgerTransactionKind } from '../ledger/ledger-transaction.entity';
import { LedgerService } from '../ledger/ledger.service';
import { formatMinor, parseMinor } from '../money';
import { Payment, PaymentMethod, PaymentStatus } from './payment.entity';
import { AdminPaymentView, AdminPaymentsPage, BankView, PAYMENTS_CURSOR, ProFormaView, SellerView } from './payments.dto';
import { vatPercentOn } from '../tax-rates';
import { tunisDay } from '../tunisia';
import { CREDIT_LIMITS, TransferFacts, cancelMail, newReference, normalizedReference, transferMail, transferProblem, vatOf, withholdingMail } from './pro-forma';

/** The types a withholding certificate may have: the tax platform's PDF, or a scan. */
export const CERTIFICATE_TYPES = ['application/pdf', 'image/png', 'image/jpeg'];
/** The largest certificate taken. */
export const CERTIFICATE_LIMIT = '5mb';
const REFERENCE_TAKEN = 'IDX_866ddee0e17d9385b4e3b86851';

/** A transfer as the operator records it from the bank statement. */
export interface TransferEntry {
  reference: string;
  received: string;
  withheld: string;
  receivedOn: string;
  bankReference?: string;
}

/**
 * Bank transfers (P-35, D9; parent §8.5). An owner asks for a pro-forma: the
 * credit, the VAT on top, and a payment reference for the transfer's label.
 * An operator records the transfer against that reference, with any share the
 * buyer withheld at source: the wallet gets the credit less that share, VAT is
 * owed in full, and the bank holds what arrived. With the withholding
 * certificate, the withheld share is credited too, against the tax FF claims.
 * Each credit is a ledger posting in the transaction that records it, keyed
 * by the payment, and goes in the audit log; the owners get an e-mail.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly storage: ObjectStoreService,
    private readonly config: ConfigService,
  ) {}

  /** POST /billing/pro-formas: a pro-forma for this much credit, before tax, with a reference no other payment has. */
  async requestProForma(accountId: string, creditText: string, now = new Date()): Promise<ProFormaView> {
    const { currency, exponent } = await billingCurrency(this.dataSource.manager, now);
    let creditMinor: bigint;
    try {
      creditMinor = parseMinor(creditText, exponent);
    } catch (error) {
      throw new BadRequestException(`credit: ${describeError(error)}`);
    }
    const unit = 10n ** BigInt(exponent);
    if (creditMinor < CREDIT_LIMITS.min * unit || creditMinor > CREDIT_LIMITS.max * unit) {
      throw new BadRequestException(`credit must be from ${formatMinor(CREDIT_LIMITS.min * unit, exponent)} to ${formatMinor(CREDIT_LIMITS.max * unit, exponent)} ${currency}`);
    }
    const account = await this.dataSource.getRepository(Account).findOneBy({ id: accountId });
    if (!account) throw new NotFoundException(`Account ${accountId} not found`);
    // The VAT rate in force today, in Tunisia (P-36: tax rates are dated data).
    const vatPercent = await vatPercentOn(this.dataSource.manager, tunisDay(now));
    const vatMinor = vatOf(creditMinor, vatPercent);

    for (let attempt = 1; ; attempt++) {
      try {
        const payment = await this.dataSource.transaction(async (manager) => {
          const saved = await manager.save(Payment, {
            accountId,
            method: PaymentMethod.BANK_TRANSFER,
            reference: newReference(),
            status: PaymentStatus.PENDING,
            currency,
            creditMinor,
            vatPercent,
            vatMinor,
            totalMinor: creditMinor + vatMinor,
            buyerName: account.name,
            buyerTaxId: account.taxId,
            requestedBy: currentRequest()?.actor?.id ?? 'system',
          });
          await this.audit.record(
            {
              accountId,
              action: 'billing.pro_forma',
              resource: `payment:${saved.id}`,
              details: { reference: saved.reference, credit: formatMinor(creditMinor, exponent), total: formatMinor(creditMinor + vatMinor, exponent), currency },
            },
            manager,
          );
          return saved;
        });
        return this.view(payment, exponent);
      } catch (error) {
        // Another payment has the reference: one chance in 30^8 a try. Draw another.
        if (attempt < 5 && error instanceof QueryFailedError && (error.driverError as { constraint?: string }).constraint === REFERENCE_TAKEN) continue;
        throw error;
      }
    }
  }

  /** The VAT rate a pro-forma asked for now gets, as the console quotes it. */
  vatPercentNow(now = new Date()): Promise<number> {
    return vatPercentOn(this.dataSource.manager, tunisDay(now));
  }

  /** GET /billing/pro-formas: the account's, newest first. */
  async proFormas(accountId: string): Promise<ProFormaView[]> {
    const payments = await this.dataSource.getRepository(Payment).find({ where: { accountId }, order: { createdAt: 'DESC', id: 'DESC' }, take: 100 });
    return Promise.all(payments.map(async (payment) => this.view(payment, await this.exponentOf(payment.currency))));
  }

  /** GET /billing/pro-formas/:id: the account's own, else 404. */
  async proForma(accountId: string, id: string): Promise<ProFormaView> {
    const payment = await this.dataSource.getRepository(Payment).findOneBy({ id, accountId });
    if (!payment) throw new NotFoundException(`Pro-forma ${id} not found`);
    return this.view(payment, await this.exponentOf(payment.currency));
  }

  /** GET /admin/payments: every account's, newest first, a page at a time; by reference, as typed from a bank statement. */
  async forOperators(filter: { status?: PaymentStatus; accountId?: string; reference?: string }, { limit, before }: { limit: number; before?: string }): Promise<AdminPaymentsPage> {
    const reference = filter.reference === undefined ? null : normalizedReference(filter.reference);
    if (filter.reference !== undefined && !reference) throw new BadRequestException(`"${filter.reference}" is not a payment reference, such as FF-7KQ2-9MXA`);
    const cursor = before ? PAYMENTS_CURSOR.exec(before) : null;
    const query = this.dataSource
      .getRepository(Payment)
      .createQueryBuilder('payment')
      .addSelect(`to_char(payment.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`, 'cursor_at')
      .orderBy('payment.createdAt', 'DESC')
      .addOrderBy('payment.id', 'DESC')
      .limit(limit + 1);
    if (filter.status) query.andWhere('payment.status = :status', { status: filter.status });
    if (filter.accountId) query.andWhere('payment.account_id = :accountId', { accountId: filter.accountId });
    if (reference) query.andWhere('payment.reference = :reference', { reference });
    if (cursor) {
      query.andWhere(`(payment.created_at, payment.id) < (CAST(:beforeAt AS timestamp) AT TIME ZONE 'UTC', CAST(:beforeId AS uuid))`, { beforeAt: cursor[1], beforeId: cursor[2] });
    }
    const { entities, raw } = await query.getRawAndEntities<{ cursor_at: string }>();
    const page = entities.slice(0, limit);
    const last = entities.length > limit ? limit - 1 : -1;
    return {
      payments: await Promise.all(page.map(async (payment) => this.adminView(payment, await this.exponentOf(payment.currency)))),
      next: last >= 0 ? `${raw[last].cursor_at}_${page[last].id}` : null,
    };
  }

  /**
   * POST /admin/bank-transfers: a transfer against its pro-forma's reference.
   * It must make the total with the share withheld at source. The wallet gets
   * the credit less that share; VAT is owed in full; the bank holds what
   * arrived. Once only: the pro-forma is locked while it is recorded.
   */
  async recordTransfer(entry: TransferEntry, reason: string, now = new Date()): Promise<AdminPaymentView> {
    const reference = normalizedReference(entry.reference);
    if (!reference) throw new BadRequestException(`"${entry.reference}" is not a payment reference, such as FF-7KQ2-9MXA`);
    // The bank statement's day is Tunisia's, where the next day begins an hour before UTC's.
    if (Number.isNaN(Date.parse(`${entry.receivedOn}T00:00:00Z`)) || entry.receivedOn > tunisDay(now)) {
      throw new BadRequestException(`receivedOn must be a day that has come in Tunisia, not ${entry.receivedOn}`);
    }
    const { payment, exponent } = await this.dataSource.transaction(async (manager) => {
      const found = await manager.findOne(Payment, { where: { reference }, lock: { mode: 'pessimistic_write' } });
      if (!found) throw new NotFoundException(`No pro-forma has the reference ${reference}`);
      const exponent = await this.exponentOf(found.currency, manager);
      if (found.status === PaymentStatus.PAID) {
        throw new ConflictException(`The transfer for ${reference} was recorded on ${(found.recordedAt as Date).toISOString().slice(0, 10)}: ${formatMinor(found.receivedMinor as bigint, exponent)} ${found.currency} received`);
      }
      const amounts = this.amounts(entry, exponent);
      const problem = transferProblem(found, amounts.received, amounts.withheld, exponent, found.currency);
      if (problem) throw new BadRequestException(problem);

      const posted = await this.ledger.postIn(manager, {
        kind: LedgerTransactionKind.PAYMENT,
        idempotencyKey: `transfer:${found.id}`,
        currency: found.currency,
        occurredAt: new Date(`${entry.receivedOn}T00:00:00Z`),
        metadata: { reference, received: formatMinor(amounts.received, exponent), withheld: formatMinor(amounts.withheld, exponent), bankReference: entry.bankReference ?? null },
        entries: [
          { account: { wallet: found.accountId }, amountMinor: found.creditMinor - amounts.withheld },
          { account: { ff: LedgerAccountType.VAT_PAYABLE }, amountMinor: found.vatMinor },
          { account: { ff: LedgerAccountType.PROVIDER_CLEARING }, amountMinor: -amounts.received },
        ],
      });
      const changes = {
        status: PaymentStatus.PAID,
        receivedMinor: amounts.received,
        withheldMinor: amounts.withheld,
        receivedOn: entry.receivedOn,
        bankReference: entry.bankReference ?? null,
        recordedBy: currentRequest()?.actor?.id ?? 'system',
        recordedAt: now,
        ledgerTransactionId: posted.transaction.id,
      };
      await manager.update(Payment, { id: found.id }, changes);
      await this.audit.record(
        {
          accountId: found.accountId,
          action: 'payment.record',
          resource: `payment:${found.id}`,
          details: {
            reason,
            reference,
            currency: found.currency,
            received: formatMinor(amounts.received, exponent),
            withheld: formatMinor(amounts.withheld, exponent),
            receivedOn: entry.receivedOn,
            bankReference: entry.bankReference ?? null,
            // A transfer that came for a cancelled pro-forma still pays it: the money has a pro-forma.
            ...(found.status === PaymentStatus.CANCELLED ? { wasCancelled: true } : {}),
          },
        },
        manager,
      );
      return { payment: { ...found, ...changes }, exponent };
    });
    await this.tellOwners(payment, (account, consoleUrl, language) => transferMail(transferFacts(payment, exponent, account, consoleUrl), language));
    return this.adminView(payment, exponent);
  }

  /**
   * POST /billing/pro-formas/:id/cancel: an owner cancels the account's
   * pending pro-forma (P-74), so that nobody pays it. A cancelled one stays
   * as it is; a paid one is never cancelled.
   */
  async cancelProForma(accountId: string, id: string, now = new Date()): Promise<ProFormaView> {
    const { payment, exponent } = await this.cancel(id, accountId, null, now);
    return this.view(payment, exponent);
  }

  /** POST /admin/payments/:id/cancel: an operator cancels a pending pro-forma, with the reason, which the owners' e-mail gives. */
  async cancelPayment(id: string, reason: string, now = new Date()): Promise<AdminPaymentView> {
    const { payment, exponent, cancelled } = await this.cancel(id, null, reason, now);
    if (cancelled) {
      await this.tellOwners(payment, (account, consoleUrl, language) =>
        cancelMail({ account, reference: payment.reference, totalMinor: payment.totalMinor, exponent, currency: payment.currency, reason, consoleUrl }, language),
      );
    }
    return this.adminView(payment, exponent);
  }

  /** Cancels a pending pro-forma, the account's own when given, with its audit entry: an owner's, or an operator's with a reason. */
  private cancel(id: string, accountId: string | null, reason: string | null, now: Date): Promise<{ payment: Payment; exponent: number; cancelled: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      const found = await manager.findOne(Payment, { where: accountId === null ? { id } : { id, accountId }, lock: { mode: 'pessimistic_write' } });
      if (!found) throw new NotFoundException(accountId === null ? `Payment ${id} not found` : `Pro-forma ${id} not found`);
      const exponent = await this.exponentOf(found.currency, manager);
      if (found.status === PaymentStatus.PAID) {
        throw new ConflictException(`The transfer for ${found.reference} was recorded on ${(found.recordedAt as Date).toISOString().slice(0, 10)}: a paid pro-forma isn't cancelled`);
      }
      if (found.status === PaymentStatus.CANCELLED) return { payment: found, exponent, cancelled: false };
      const changes = { status: PaymentStatus.CANCELLED, cancelledAt: now, cancelledBy: currentRequest()?.actor?.id ?? 'system' };
      await manager.update(Payment, { id: found.id }, changes);
      await this.audit.record(
        {
          accountId: found.accountId,
          action: reason === null ? 'billing.pro_forma_cancel' : 'payment.cancel',
          resource: `payment:${found.id}`,
          details: { ...(reason === null ? {} : { reason }), reference: found.reference, total: formatMinor(found.totalMinor, exponent), currency: found.currency },
        },
        manager,
      );
      return { payment: { ...found, ...changes }, exponent, cancelled: true };
    });
  }

  /**
   * PUT /admin/payments/:id/withholding-certificate: the certificate for the
   * share withheld at source, kept in object storage; that share is credited
   * now, against the tax FF claims with it. Once only.
   */
  async attachCertificate(id: string, file: Buffer, contentType: string, reason: string, now = new Date()): Promise<AdminPaymentView> {
    if (!CERTIFICATE_TYPES.includes(contentType)) throw new BadRequestException(`A certificate is a PDF, a PNG or a JPEG, not ${contentType || 'nothing'}`);
    if (!Buffer.isBuffer(file) || file.length === 0) throw new BadRequestException('The certificate is empty');
    const { payment, exponent } = await this.dataSource.transaction(async (manager) => {
      const found = await manager.findOne(Payment, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!found) throw new NotFoundException(`Payment ${id} not found`);
      if (found.status !== PaymentStatus.PAID) throw new ConflictException(`The transfer for ${found.reference} isn't recorded yet`);
      if (!found.withheldMinor) throw new ConflictException(`Nothing was withheld at source on ${found.reference}: there is no certificate to add`);
      if (found.certificateKey) throw new ConflictException(`The certificate for ${found.reference} was added on ${(found.certificateAt as Date).toISOString().slice(0, 10)}`);
      const exponent = await this.exponentOf(found.currency, manager);

      // Kept before the credit: if the database refuses it, a retry writes the same key again.
      const key = `withholding-certificates/${found.id}`;
      await this.storage.putDocument(key, file, contentType);
      const posted = await this.ledger.postIn(manager, {
        kind: LedgerTransactionKind.WITHHOLDING,
        idempotencyKey: `withholding:${found.id}`,
        currency: found.currency,
        metadata: { reference: found.reference },
        entries: [
          { account: { wallet: found.accountId }, amountMinor: found.withheldMinor },
          { account: { ff: LedgerAccountType.WITHHOLDING_RECEIVABLE }, amountMinor: -found.withheldMinor },
        ],
      });
      const changes = { certificateKey: key, certificateType: contentType, certificateAt: now, certificateTransactionId: posted.transaction.id };
      await manager.update(Payment, { id: found.id }, changes);
      await this.audit.record(
        {
          accountId: found.accountId,
          action: 'payment.withholding',
          resource: `payment:${found.id}`,
          details: { reason, reference: found.reference, currency: found.currency, withheld: formatMinor(found.withheldMinor, exponent), certificate: { type: contentType, bytes: file.length } },
        },
        manager,
      );
      return { payment: { ...found, ...changes }, exponent };
    });
    await this.tellOwners(payment, (account, consoleUrl, language) => withholdingMail(transferFacts(payment, exponent, account, consoleUrl), language));
    return this.adminView(payment, exponent);
  }

  /** GET /admin/payments/:id/withholding-certificate: the file as it was added. */
  async certificate(id: string): Promise<{ body: Buffer; contentType: string; reference: string }> {
    const payment = await this.dataSource.getRepository(Payment).findOneBy({ id });
    if (!payment) throw new NotFoundException(`Payment ${id} not found`);
    if (!payment.certificateKey) throw new NotFoundException(`No certificate was added for ${payment.reference}`);
    return { ...(await this.storage.getDocument(payment.certificateKey)), reference: payment.reference };
  }

  private amounts(entry: TransferEntry, exponent: number): { received: bigint; withheld: bigint } {
    const read = (name: string, text: string) => {
      try {
        return parseMinor(text, exponent);
      } catch (error) {
        throw new BadRequestException(`${name}: ${describeError(error)}`);
      }
    };
    return { received: read('received', entry.received), withheld: read('withheld', entry.withheld) };
  }

  private async exponentOf(currency: string, manager: EntityManager = this.dataSource.manager): Promise<number> {
    const [{ exponent }] = await manager.query<Array<{ exponent: number }>>(`SELECT "exponent" FROM "currencies" WHERE "code" = $1`, [currency]);
    return exponent;
  }

  /** E-mails each owner, after the change has committed; a failure is logged, never the request's. */
  private async tellOwners(payment: Payment, mail: (account: Account, consoleUrl: string, language: Language) => Omit<Mail, 'to'>): Promise<void> {
    try {
      const account = await this.dataSource.getRepository(Account).findOneByOrFail({ id: payment.accountId });
      const { consoleUrl } = this.config.getOrThrow<{ consoleUrl: string }>('mail');
      const owners = await this.dataSource.getRepository(Membership).find({ where: { accountId: payment.accountId, role: 'owner' }, relations: { user: true } });
      await this.mail.sendEach(recipientsOf(owners), (language) => mail(account, consoleUrl, language));
    } catch (error) {
      this.logger.error(`Could not tell the owners of ${payment.accountId} about ${payment.reference}: ${describeError(error)}`);
    }
  }

  private view(payment: Payment, exponent: number): ProFormaView {
    const money = (minor: bigint) => formatMinor(minor, exponent);
    const { seller, bank } = this.config.getOrThrow<{ seller: SellerView; bank: BankView }>('billing');
    return {
      id: payment.id,
      reference: payment.reference,
      status: payment.status,
      currency: payment.currency,
      credit: money(payment.creditMinor),
      vatPercent: payment.vatPercent,
      vat: money(payment.vatMinor),
      total: money(payment.totalMinor),
      createdAt: payment.createdAt,
      buyer: { name: payment.buyerName, taxId: payment.buyerTaxId },
      seller,
      bank,
      transfer:
        payment.status === PaymentStatus.PAID
          ? {
              received: money(payment.receivedMinor as bigint),
              withheld: money(payment.withheldMinor as bigint),
              receivedOn: payment.receivedOn as string,
              recordedAt: payment.recordedAt as Date,
              credited: money(payment.creditMinor - (payment.withheldMinor as bigint)),
              withheldCreditedAt: payment.certificateAt,
            }
          : null,
      cancelledAt: payment.cancelledAt,
    };
  }

  private adminView(payment: Payment, exponent: number): AdminPaymentView {
    return {
      ...this.view(payment, exponent),
      accountId: payment.accountId,
      requestedBy: payment.requestedBy,
      bankReference: payment.bankReference,
      recordedBy: payment.recordedBy,
      certificateType: payment.certificateType,
      cancelledBy: payment.cancelledBy,
    };
  }
}

/** What the owners' transfer e-mails say of a paid pro-forma. */
function transferFacts(payment: Payment, exponent: number, account: Account, consoleUrl: string): TransferFacts {
  return {
    account,
    reference: payment.reference,
    creditMinor: payment.creditMinor,
    receivedMinor: payment.receivedMinor as bigint,
    withheldMinor: payment.withheldMinor as bigint,
    exponent,
    currency: payment.currency,
    consoleUrl,
  };
}

import { Account } from '../accounts/entities/account.entity';
import { Invitation } from '../accounts/entities/invitation.entity';
import { Membership } from '../accounts/entities/membership.entity';
import { Plan } from '../accounts/entities/plan.entity';
import { User } from '../accounts/entities/user.entity';
import { ApiKey } from '../api-keys/entities/api-key.entity';
import { AuditEntry } from '../audit/audit-entry.entity';
import { FunctionInvocation } from '../functions/entities/function-invocation.entity';
import { Function } from '../functions/entities/function.entity';
import { FunctionMetrics } from '../metrics/entities/function-metrics.entity';
import { RateLimitedInvocations } from '../metrics/entities/rate-limited-invocations.entity';
import { NotificationDelivery } from '../notifications/entities/notification-delivery.entity';
import { WebhookSecret } from '../notifications/entities/webhook-secret.entity';
import { UsageRecord } from '../usage/usage-record.entity';
import { CapacitySample } from '../usage/capacity-sample.entity';
import { PlatformSetting } from '../admin/platform-setting.entity';
import { Currency } from '../billing/currency.entity';
import { PriceBook } from '../billing/price-book.entity';
import { LedgerAccount } from '../billing/ledger/ledger-account.entity';
import { LedgerEntry } from '../billing/ledger/ledger-entry.entity';
import { LedgerTransaction } from '../billing/ledger/ledger-transaction.entity';
import { RatingRun } from '../billing/rating-run.entity';
import { UsageCharge } from '../billing/usage-charge.entity';
import { UsageHourly } from '../billing/usage-hourly.entity';
import { LowBalanceNotice } from '../billing/low-balance-notice.entity';
import { Payment } from '../billing/payments/payment.entity';
import { TaxRate } from '../billing/tax-rate.entity';
import { Invoice } from '../billing/invoices/invoice.entity';
import { InvoiceLine } from '../billing/invoices/invoice-line.entity';
import { InvoiceCounter } from '../billing/invoices/invoice-counter.entity';
import { InvoiceNotice } from '../billing/invoices/invoice-notice.entity';

/**
 * Every entity, listed explicitly rather than found by a file glob: a glob over
 * the build output also matches the compiled `.d.ts` files. Add new entities here.
 */
export const ENTITIES = [Plan, Account, User, Membership, Invitation, ApiKey, AuditEntry, Function, FunctionInvocation, FunctionMetrics, RateLimitedInvocations, UsageRecord, CapacitySample, PlatformSetting, Currency, PriceBook, LedgerAccount, LedgerTransaction, LedgerEntry, UsageHourly, UsageCharge, RatingRun, LowBalanceNotice, Payment, TaxRate, Invoice, InvoiceLine, InvoiceCounter, InvoiceNotice, NotificationDelivery, WebhookSecret];

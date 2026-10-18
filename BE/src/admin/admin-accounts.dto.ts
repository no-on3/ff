import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { AccountStatus } from '../accounts/entities/account.entity';
import type { Role } from '../auth/principal';
import { CreditStateView } from '../billing/billing.dto';
import { UsageAmountsView } from '../usage/usage.dto';
import { AdminChange } from './admin.dto';

export const MAX_ADMIN_ACCOUNTS_PAGE = 100;

/** A plan's ID, as plans name them: "beta". */
const PLAN_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const PLAN_ID_MESSAGE = 'must be a plan ID, such as beta';

/**
 * The cursor of GET /admin/accounts' pages: the last account's creation time
 * in UTC, to the microsecond as PostgreSQL keeps it, then its ID.
 */
export const ACCOUNTS_CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6})_(\d{12})$/;

const STATUSES = Object.values(AccountStatus);

/** An account in an admin route's path. */
export class AccountIdParam {
  @Matches(/^\d{12}$/, { message: 'id must be an account ID: 12 digits' })
  id: string;
}

/** GET /admin/accounts' query (P-71): a search, filters, and a page. */
export class AdminAccountsQuery {
  @ApiPropertyOptional({ description: "Part of the account's ID or name, or of a member's e-mail, in any case", example: 'amira' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({ enum: AccountStatus, description: 'pending: the approvals queue' })
  @IsOptional()
  @IsIn(STATUSES, { message: `status must be one of: ${STATUSES.join(', ')}` })
  status?: AccountStatus;

  @ApiPropertyOptional({ example: 'beta' })
  @IsOptional()
  @Matches(PLAN_ID, { message: `plan ${PLAN_ID_MESSAGE}` })
  plan?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_ADMIN_ACCOUNTS_PAGE, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ADMIN_ACCOUNTS_PAGE)
  limit?: number;

  @ApiPropertyOptional({ description: "The previous page's `next`: accounts created before it" })
  @IsOptional()
  @Matches(ACCOUNTS_CURSOR, { message: "before must be the previous page's next" })
  before?: string;
}

/** PUT /admin/accounts/:id/plan. */
export class AdminPlanDto extends AdminChange {
  @ApiProperty({ example: 'beta' })
  @Matches(PLAN_ID, { message: `planId ${PLAN_ID_MESSAGE}` })
  planId: string;
}

/** PUT /admin/accounts/:id/egress. */
export class AdminEgressDto extends AdminChange {
  @ApiProperty({ example: true, description: "Whether the account's functions may reach the internet (D5): the tenant's NetworkPolicy follows it from P-62" })
  @IsBoolean()
  internetEgress: boolean;
}

export class AccountPersonView {
  @ApiProperty({ example: 'amira@ff.test' }) email: string;
  @ApiProperty({ nullable: true, type: String, example: 'Amira' }) name: string | null;
}

/** An account in the list: what sign-up collected, and its owners. */
export class AdminAccountSummaryView {
  @ApiProperty({ example: '000000000001' }) id: string;
  @ApiProperty({ example: 'Tunis Labs' }) name: string;
  @ApiProperty({ enum: AccountStatus }) status: AccountStatus;
  @ApiProperty({ example: 'beta' }) planId: string;
  @ApiProperty({ example: 'TN' }) country: string;
  @ApiProperty({ nullable: true, type: String, description: 'The tax ID (matricule fiscal)' }) taxId: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'What they plan to build, from sign-up' }) useCase: string | null;
  @ApiProperty({ description: 'Whether its functions may reach the internet (D5)' }) internetEgress: boolean;
  @ApiProperty() createdAt: Date;
  @ApiProperty({ nullable: true, type: Date, description: "When a closed account's functions, their invocation history and logs are deleted: its closure plus the notice period set then. Null unless the account is closed" })
  dataDeletionDueAt: Date | null;
  @ApiProperty({ nullable: true, type: Date, description: 'When they were deleted; null until then' }) dataDeletedAt: Date | null;
  @ApiProperty({ type: [AccountPersonView] }) owners: AccountPersonView[];
}

export class AdminAccountPageView {
  @ApiProperty({ type: [AdminAccountSummaryView] }) accounts: AdminAccountSummaryView[];
  @ApiProperty({ nullable: true, type: String, description: 'Pass it as `before` for the next page, older; null on the last one' })
  next: string | null;
}

export class AdminMemberView {
  @ApiProperty() userId: string;
  @ApiProperty({ example: 'amira@ff.test' }) email: string;
  @ApiProperty({ nullable: true, type: String }) name: string | null;
  @ApiProperty({ enum: ['owner', 'developer', 'viewer'] }) role: Role;
  @ApiProperty() joinedAt: Date;
}

export class AdminFunctionView {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'hello' }) name: string;
  @ApiProperty({ example: 'nodejs' }) runtime: string;
  @ApiProperty({ example: 128, description: 'MB' }) memory: number;
  @ApiProperty({ example: 'ACTIVE' }) status: string;
  @ApiProperty({ example: 0, description: 'Instances kept warm' }) minInstances: number;
  @ApiProperty({ nullable: true, type: Date, description: 'Its newest call, from its usage records, which outlive the invocation history (P-45); null if none' }) lastInvokedAt: Date | null;
}

/** One status the account went through: its creation, or an operator's change. */
export class AdminStatusEventView {
  @ApiProperty() at: Date;
  @ApiProperty({ example: 'account.approve' }) action: string;
  @ApiProperty({ enum: AccountStatus, description: 'The status it gave' }) status: AccountStatus;
  @ApiProperty({ example: 'operator@ff.test', description: 'Who: the owner who created it, or the operator' }) by: string;
  @ApiProperty({ nullable: true, type: String }) reason: string | null;
}

export class AdminAccountUsageView {
  @ApiProperty({ example: '2026-10', description: 'This month, by the UTC calendar' }) month: string;
  @ApiProperty({ type: UsageAmountsView }) totals: UsageAmountsView;
}

/** A wallet's balance (P-31): money is a string with the currency's decimals, never a JSON number. */
export class AdminBalanceView {
  @ApiProperty({ example: 'TND' }) currency: string;
  @ApiProperty({ example: '50.000', description: "Credit left, with the currency's decimals; below zero, a debt" }) balance: string;
}

/** The account's credit (P-33, P-74): the balance in the prices' currency, read as it is now, whether invokes go on, and this month's charges. */
export class AdminCreditView {
  @ApiProperty({ example: 'TND' }) currency: string;
  @ApiProperty({ example: '50.000', description: "Credit left, with the currency's decimals; below zero, usage the credit didn't cover" }) balance: string;
  @ApiProperty({ type: CreditStateView, description: 'Whether invokes go on (P-33)' }) state: CreditStateView;
  @ApiProperty({ description: 'D9: usage is rated each hour, not debited' }) shadowMode: boolean;
  @ApiProperty({ example: '2026-10', description: 'This month, by the UTC calendar' }) month: string;
  @ApiProperty({ example: '1.234', description: "This month's hourly charges debited from the wallet" }) debited: string;
  @ApiProperty({ example: '0.000', description: "This month's hourly charges rated in shadow mode, not debited" }) ratedOnly: string;
  @ApiProperty({ nullable: true, type: String, example: '2026-10-17T10:00:00.000Z', description: 'The end of the last hour rated: later usage is not charged yet' })
  ratedUntil: Date | null;
  @ApiProperty({ example: '100.000', description: 'A grant above this, either way, needs its amount typed again (D12)' }) largeCreditThreshold: string;
}

/** GET /admin/accounts/:id, and the answer to every change: the account page. */
export class AdminAccountView {
  @ApiProperty({ type: AdminAccountSummaryView }) account: AdminAccountSummaryView;
  @ApiProperty({ type: [AdminMemberView] }) members: AdminMemberView[];
  @ApiProperty({ type: [AdminFunctionView] }) functions: AdminFunctionView[];
  @ApiProperty({ type: AdminAccountUsageView }) usage: AdminAccountUsageView;
  @ApiProperty({ type: [AdminBalanceView], description: "Each wallet's balance (P-31); none before the account's first credit or debit" })
  balances: AdminBalanceView[];
  @ApiProperty({ type: AdminCreditView }) credit: AdminCreditView;
  @ApiProperty({ type: [AdminStatusEventView], description: 'Oldest first' }) statusHistory: AdminStatusEventView[];
}

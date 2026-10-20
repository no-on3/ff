import { ApiProperty } from '@nestjs/swagger';
import { AccountStatus } from '../accounts/entities/account.entity';

export class OverviewAccounts {
  @ApiProperty({ description: 'Every status, 0 included', example: { pending: 2, active: 14, rejected: 1, suspended: 0, closed: 1 } })
  byStatus: Record<AccountStatus, number>;

  @ApiProperty({ description: 'Accounts waiting for your approval', example: 2 })
  pendingApprovals: number;
}

export class OverviewFunctions {
  @ApiProperty({ example: 37 })
  total: number;

  @ApiProperty({ description: 'The statuses there are; a function being deleted counts no more', example: { ACTIVE: 35, ERROR: 2 } })
  byStatus: Record<string, number>;
}

export class OverviewToday {
  @ApiProperty({ description: 'Today, by the UTC calendar', example: '2026-10-20' })
  day: string;

  @ApiProperty({ description: 'Calls that reached a function', example: 1840 })
  invocations: number;

  @ApiProperty({ description: 'Calls that failed: error, timeout, platform_error or lost, as the metrics API counts Errors', example: 12 })
  errors: number;

  @ApiProperty({ description: "Calls refused: the instance limit's and the rate limit's", example: 3 })
  throttles: number;
}

export class OverviewMoney {
  @ApiProperty({ example: 'TND' })
  currency: string;

  @ApiProperty({
    description: "This month's usage charged: in all, debited from wallets, and only rated (shadow mode)",
    example: { charged: '41.250', debited: '30.000', shadow: '11.250' },
  })
  consumption: { charged: string; debited: string; shadow: string };

  @ApiProperty({ description: 'Transfers received this month (their bank date), and the credit they bought before tax', example: { payments: 3, credit: '300.000' } })
  topUps: { payments: number; credit: string };

  @ApiProperty({
    description: 'The wallets now: the unused credit FF owes its customers, what those in debt owe FF, and how many are in debt',
    example: { owedByFF: '812.500', owedToFF: '4.200', walletsInDebt: 1 },
  })
  balances: { owedByFF: string; owedToFF: string; walletsInDebt: number };
}

export class OverviewInvoices {
  @ApiProperty({ description: 'Invoices issued this month', example: 9 })
  issued: number;

  @ApiProperty({ description: 'Credit notes issued this month', example: 0 })
  creditNotes: number;

  @ApiProperty({
    description: "Last month's invoices still to issue (a month in Tunisia), and whether it is over so they can be",
    example: { month: '2026-09', drafts: 4, issuable: true },
  })
  toIssue: { month: string; drafts: number; issuable: boolean };
}

export class OverviewCapacityDay {
  @ApiProperty({ example: '2026-10-20' })
  day: string;

  @ApiProperty({ description: 'GB-s FF held: ready instances × memory, a minute per sample', example: 45 })
  reservedGbS: number;

  @ApiProperty({ description: 'GB-s billed at the provisioned price: minInstances × memory', example: 0 })
  provisionedGbS: number;

  @ApiProperty({ description: 'GB-s billed: the calls’ billed duration × memory', example: 0.752 })
  billedGbS: number;

  @ApiProperty({ description: 'Calls billed', example: 4 })
  requests: number;
}

/** GET /admin/stats/overview. */
export class OverviewView {
  @ApiProperty({ description: 'When these figures were worked out: at most a minute ago', example: '2026-10-20T10:00:00.000Z' })
  computedAt: string;

  @ApiProperty({ type: OverviewAccounts })
  accounts: OverviewAccounts;

  @ApiProperty({ type: OverviewFunctions })
  functions: OverviewFunctions;

  @ApiProperty({ type: OverviewToday })
  today: OverviewToday;

  @ApiProperty({ description: "This month, by the UTC calendar, as the rating's months; payments and invoices by their own dates in it", example: '2026-10' })
  month: string;

  @ApiProperty({ type: [OverviewMoney], description: 'One per currency FF has' })
  money: OverviewMoney[];

  @ApiProperty({ type: OverviewInvoices })
  invoices: OverviewInvoices;

  @ApiProperty({ type: [OverviewCapacityDay], description: 'The last 7 days, today included, oldest first, all accounts together' })
  capacity: OverviewCapacityDay[];
}

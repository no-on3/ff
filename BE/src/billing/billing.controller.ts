import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '../auth/principal';
import { RequireScope } from '../auth/route-rules';
import { BalanceView, BillingTransactionsPage, BillingTransactionsQuery } from './billing.dto';
import { BillingService } from './billing.service';

/**
 * The account's money (client-readiness plan, P-32, D9): every member may
 * read it, and an API key with usage:read, as for the usage it pays for.
 */
@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('balance')
  @RequireScope('usage:read')
  @ApiOperation({
    summary: "The account's balance, and this month's charges",
    description: 'Usage is rated each hour, once the hour has settled. In shadow mode (D9) its charges are shown and not debited.',
  })
  @ApiResponse({ status: 200, type: BalanceView })
  balance(@Principal() principal: Principal): Promise<BalanceView> {
    return this.billing.balance(principal.accountId);
  }

  @Get('transactions')
  @RequireScope('usage:read')
  @ApiOperation({ summary: "What moved the account's balance, newest first: hourly usage debits, credit, and later top-ups" })
  @ApiResponse({ status: 200, type: BillingTransactionsPage })
  transactions(@Principal() principal: Principal, @Query() query: BillingTransactionsQuery): Promise<BillingTransactionsPage> {
    return this.billing.transactions(principal.accountId, { limit: query.limit ?? 50, before: query.before });
  }
}

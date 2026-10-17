import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '../auth/principal';
import { RequireRole, RequireScope } from '../auth/route-rules';
import { AlertsDto, AlertsView, BalanceView, BillingTransactionsPage, BillingTransactionsQuery } from './billing.dto';
import { BillingService } from './billing.service';

/**
 * The account's money (client-readiness plan, P-32, P-33, D9): every member
 * may read it, and an API key with usage:read, as for the usage it pays for.
 * Only an owner, with a user's token, sets the low-balance e-mails.
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

  @Get('alerts')
  @RequireScope('usage:read')
  @ApiOperation({ summary: 'When the owners get a low-balance e-mail: shares of the last credit (P-33)' })
  @ApiResponse({ status: 200, type: AlertsView })
  alerts(@Principal() principal: Principal): Promise<AlertsView> {
    return this.billing.alerts(principal.accountId);
  }

  @Put('alerts')
  @RequireRole('owner')
  @ApiOperation({
    summary: "Sets the shares of the last credit at which the owners get a low-balance e-mail, or null for FF's (P-33)",
    description: 'Largest first, each once, five at most, from 0 to 100; [] for no e-mail. The change is in the audit log.',
  })
  @ApiResponse({ status: 200, type: AlertsView })
  setAlerts(@Principal() principal: Principal, @Body() body: AlertsDto): Promise<AlertsView> {
    return this.billing.setAlerts(principal.accountId, body);
  }
}

import { Controller, Get, Headers, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Principal } from '../auth/principal';
import { RequireScope } from '../auth/route-rules';
import { usageCsv, wantsCsv } from './usage-csv';
import { MonthlyUsageView, UsageQuery } from './usage.dto';
import { UsageService, monthOf } from './usage.service';

/**
 * The account's usage, a month at a time (client-readiness plan, P-22): every
 * member may read it, and an API key with usage:read. Prices come with the
 * price book (P-30).
 */
@ApiTags('usage')
@Controller('usage')
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get()
  @RequireScope('usage:read')
  @ApiOperation({
    summary: "The account's usage in a month, per function and in total: JSON, or CSV with Accept: text/csv",
    description:
      'Requests billed and billed duration as D7 counts them, GB-seconds, and the calls not billed. A month is a month of the UTC calendar.',
  })
  @ApiProduces('application/json', 'text/csv')
  @ApiResponse({ status: 200, type: MonthlyUsageView })
  async get(
    @Principal() principal: Principal,
    @Query() query: UsageQuery,
    @Headers('accept') accept: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MonthlyUsageView | string> {
    const view = await this.usage.monthly(principal.accountId, query.month ?? monthOf(new Date()));
    if (!wantsCsv(accept)) return view;
    response.setHeader('content-type', 'text/csv; charset=utf-8');
    response.setHeader('content-disposition', `attachment; filename="ff-usage-${principal.accountId}-${view.month}.csv"`);
    return usageCsv(view);
  }
}

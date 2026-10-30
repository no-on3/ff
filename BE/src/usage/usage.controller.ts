import { Controller, Get, Headers, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Principal } from '../auth/principal';
import { RequireScope } from '../auth/route-rules';
import { PricingService } from '../billing/pricing.service';
import { usageCsv, wantsCsv } from './usage-csv';
import { unlisted, withEstimate } from './usage-estimate';
import { MonthlyUsageView, UsageQuery } from './usage.dto';
import { UsageService, monthOf } from './usage.service';

/**
 * The account's usage, a month at a time (client-readiness plan, P-22): every
 * member may read it, and an API key with usage:read. With its estimated cost
 * at FF's prices, from the price books (P-30).
 */
@ApiTags('usage')
@Controller('usage')
export class UsageController {
  constructor(
    private readonly usage: UsageService,
    private readonly pricing: PricingService,
  ) {}

  @Get()
  @RequireScope('usage:read')
  @ApiOperation({
    summary: "The account's usage in a month, per function and in total: JSON, or CSV with Accept: text/csv",
    description:
      "Requests billed and billed duration, as AWS Lambda bills them, GB-seconds, and the calls not billed; each database's GB-months, from its size each hour; each bucket's GB-months, from what it held each hour, and its requests by S3's two classes; each queue's requests as SQS bills them, and its messages; each cache's hours and GB-hours, from its memory each hour, as ElastiCache bills a node; each function's, database's, bucket's, queue's and cache's estimated cost, and the month's, at FF's prices. A month is a month of the UTC calendar.",
  })
  @ApiProduces('application/json', 'text/csv')
  @ApiResponse({ status: 200, type: MonthlyUsageView })
  async get(
    @Principal() principal: Principal,
    @Query() query: UsageQuery,
    @Headers('accept') accept: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MonthlyUsageView | string> {
    const month = query.month ?? monthOf(new Date());
    const [records, databases, buckets, queues, caches, estimate] = await Promise.all([
      this.usage.monthly(principal.accountId, month),
      this.usage.monthlyDatabases(principal.accountId, month),
      this.usage.monthlyBuckets(principal.accountId, month),
      this.usage.monthlyQueues(principal.accountId, month),
      this.usage.monthlyCaches(principal.accountId, month),
      this.pricing.estimate(principal.accountId, month),
    ]);
    const names = await this.usage.functionNames(principal.accountId, unlisted(records, estimate));
    const view = withEstimate(records, estimate, names, databases, buckets, queues, caches);
    if (!wantsCsv(accept)) return view;
    response.setHeader('content-type', 'text/csv; charset=utf-8');
    response.setHeader('content-disposition', `attachment; filename="ff-usage-${principal.accountId}-${view.month}.csv"`);
    return usageCsv(view);
  }
}

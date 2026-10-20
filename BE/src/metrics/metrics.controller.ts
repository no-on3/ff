import { BadRequestException, Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '../auth/principal';
import { RequireScope } from '../auth/route-rules';
import { CustomerMetricsService } from './customer-metrics.service';
import { MetricsWindow, metricsWindow } from './customer-metrics';
import { MetricsQuery, MetricsView } from './dto/metrics-query.dto';

/** A window the request names, or 400 saying why it can't be. */
function windowOf(query: MetricsQuery): MetricsWindow {
  const window = metricsWindow(query, new Date());
  if ('problem' in window) throw new BadRequestException(window.problem);
  return window;
}

/**
 * The account's metrics, as CloudWatch names Lambda's, from its usage records
 * and capacity samples: a function's, or all its functions' together.
 */
@ApiTags('metrics')
@Controller()
export class MetricsController {
  constructor(private readonly metrics: CustomerMetricsService) {}

  @Get('functions/:id/metrics')
  @RequireScope('metrics:read')
  @ApiOperation({ summary: "A function's Invocations, Errors, Throttles, Duration, ColdStarts and Instances, a point per period" })
  @ApiResponse({ status: 200, type: MetricsView })
  forFunction(@Param('id', ParseUUIDPipe) id: string, @Query() query: MetricsQuery, @Principal() principal: Principal) {
    return this.metrics.forFunction(principal.accountId, id, windowOf(query));
  }

  @Get('metrics')
  @RequireScope('metrics:read')
  @ApiOperation({ summary: "The account's metrics, all its functions together, those deleted since included" })
  @ApiResponse({ status: 200, type: MetricsView })
  forAccount(@Query() query: MetricsQuery, @Principal() principal: Principal) {
    return this.metrics.forAccount(principal.accountId, windowOf(query));
  }
}

import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Principal } from '../auth/principal';
import { MetricsQuery } from './dto/metrics-query.dto';
import { MetricsService } from './metrics.service';

/** A function's metrics, for its own account only (D4), until P-50 replaces this route. */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get(':functionId')
  async getFunctionMetrics(
    @Param('functionId', ParseUUIDPipe) functionId: string,
    @Query() period: MetricsQuery,
    @Principal() principal: Principal,
  ) {
    return this.metricsService.getMetrics(principal.accountId, functionId, {
      start: new Date(period.start),
      end: new Date(period.end),
    });
  }
}

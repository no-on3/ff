import { Controller, Get, Param, Query } from '@nestjs/common';
import { MetricsService } from './metrics.service';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get(':functionId')
  async getFunctionMetrics(
    @Param('functionId') functionId: string,
    @Query('start') start: string,
    @Query('end') end: string,
  ) {
    const timeRange = {
      start: new Date(start),
      end: new Date(end),
    };
    return this.metricsService.getMetrics(functionId, timeRange);
  }
}

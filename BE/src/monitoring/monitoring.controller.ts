import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { MonitoringService } from './monitoring.service';

@ApiTags('monitoring')
@Controller('metrics')
export class MonitoringController {
  constructor(private readonly monitoringService: MonitoringService) {}

  @Get()
  @ApiOperation({ summary: 'Get Prometheus metrics' })
  async getMetrics(): Promise<string> {
    return await this.monitoringService.getMetrics();
  }
}

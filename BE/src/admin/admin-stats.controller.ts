import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { OverviewView } from './admin-stats.dto';
import { AdminStatsService } from './admin-stats.service';
import { AdminRoutes } from './operator';

/** The admin dashboard's overview: the platform at a glance (operators only). */
@ApiTags('admin')
@AdminRoutes()
@Controller('admin/stats')
export class AdminStatsController {
  constructor(private readonly stats: AdminStatsService) {}

  @Get('overview')
  @ApiOperation({ summary: "The accounts, functions and today's calls, this month's money, the invoices to issue, and capacity against billing; at most a minute old (operators only)" })
  @ApiResponse({ status: 200, type: OverviewView })
  overview(): Promise<OverviewView> {
    return this.stats.overview();
  }
}

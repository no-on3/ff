import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';

@ApiTags('health')
@Controller('health')
export class HealthController {
  @Public()
  @Get()
  @ApiOperation({ summary: 'The backend answers: for load balancers and probes, without a token' })
  @ApiResponse({ status: 200, description: '{"status":"ok"}' })
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }
}

import { ApiProperty } from '@nestjs/swagger';
import { IsISO8601 } from 'class-validator';

/** GET /metrics/:functionId: the period to read, as ISO 8601 date-times. */
export class MetricsQuery {
  @ApiProperty({ description: 'Start of the period', example: '2026-10-17T00:00:00.000Z' })
  @IsISO8601({ strict: true })
  start: string;

  @ApiProperty({ description: 'End of the period', example: '2026-10-17T01:00:00.000Z' })
  @IsISO8601({ strict: true })
  end: string;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsOptional, Matches } from 'class-validator';
import { PERIODS } from '../customer-metrics';

/** RFC 3339: a date, a time, and its zone. */
const RFC3339 = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?(Z|[+-]\d\d:\d\d)$/;

/** GET /functions/:id/metrics and GET /metrics: a window, cut into periods. */
export class MetricsQuery {
  @ApiPropertyOptional({ example: '2026-10-19T09:00:00Z', description: "The window's start, RFC 3339, rounded down to a period; 60 periods before the end by default" })
  @IsOptional()
  @Matches(RFC3339, { message: 'start must be an RFC 3339 time, such as 2026-10-19T09:00:00Z' })
  start?: string;

  @ApiPropertyOptional({ example: '2026-10-19T10:00:00Z', description: "The window's end, RFC 3339, rounded up to a period; now by default" })
  @IsOptional()
  @Matches(RFC3339, { message: 'end must be an RFC 3339 time, such as 2026-10-19T10:00:00Z' })
  end?: string;

  @ApiPropertyOptional({ enum: PERIODS, default: 60, description: 'Seconds per point: a minute, five, or an hour. An answer has at most 1,440 points' })
  @IsOptional()
  @Type(() => Number)
  @IsIn([...PERIODS], { message: `period must be one of ${PERIODS.join(', ')} seconds` })
  period?: number;
}

class DurationSeries {
  @ApiProperty({ type: [Number], nullable: true, description: 'Milliseconds; null for a period without a measured call' }) Average: Array<number | null>;
  @ApiProperty({ type: [Number], nullable: true }) Maximum: Array<number | null>;
  @ApiProperty({ type: [Number], nullable: true, description: 'The median, interpolated' }) p50: Array<number | null>;
  @ApiProperty({ type: [Number], nullable: true }) p95: Array<number | null>;
  @ApiProperty({ type: [Number], nullable: true }) p99: Array<number | null>;
}

class InstancesSeries {
  @ApiProperty({ type: [Number], description: 'The most instances ready at once, in one of the period\'s minutes' }) Maximum: number[];
  @ApiProperty({ type: [Number], description: 'The mean over the period\'s minutes, a minute without one counting 0' }) Average: number[];
}

class MetricSeries {
  @ApiProperty({ type: [Number], description: 'Calls that reached a function, failed or not: all but the throttled' }) Invocations: number[];
  @ApiProperty({ type: [Number], description: "Calls that failed: the function's error or timeout, FF's failure, or lost when the backend stopped" }) Errors: number[];
  @ApiProperty({ type: [Number], description: 'Calls refused: no instance free in time, or the account\'s rate limit' }) Throttles: number[];
  @ApiProperty({ type: [Number], description: 'Calls that started an instance first' }) ColdStarts: number[];
  @ApiProperty({ type: DurationSeries }) Duration: DurationSeries;
  @ApiProperty({ type: InstancesSeries }) Instances: InstancesSeries;
}

/** A point per period of the window, oldest first. */
export class MetricsView {
  @ApiProperty({ enum: PERIODS }) period: number;
  @ApiProperty() start: Date;
  @ApiProperty({ description: 'Excluded' }) end: Date;
  @ApiProperty({ type: [Date], description: "Each period's start" }) timestamps: Date[];
  @ApiProperty({ type: MetricSeries }) metrics: MetricSeries;
}

import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { AnyJson } from '../../common/no-nul.pipe';

/** An EventBridge rule's name: letters, digits, ".", "-" and "_". */
export const SCHEDULE_NAME = /^[.\-_A-Za-z0-9]+$/;

/** POST /functions/{id}/schedules: a schedule, as SAM's Schedule event declares one. */
export class CreateScheduleDto {
  @ApiProperty({ example: 'nightly-report', maxLength: 64, description: "Unique within the function: letters, digits, '.', '-' and '_', as an EventBridge rule's" })
  @IsString()
  @Length(1, 64)
  @Matches(SCHEDULE_NAME, { message: "name must be letters, digits, '.', '-' and '_', as an EventBridge rule's" })
  name: string;

  @ApiProperty({
    example: 'cron(0 2 * * ? *)',
    description: "EventBridge's: rate(5 minutes), rate(1 hour), rate(2 days)… or cron(minutes hours day-of-month month day-of-week year), in UTC",
  })
  @IsString()
  @MaxLength(256)
  expression: string;

  @ApiPropertyOptional({ maxLength: 512, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string | null;

  @ApiPropertyOptional({ description: "The function's event, any JSON value, as SAM's Input; without one, EventBridge's Scheduled Event", nullable: true })
  @IsOptional()
  @AnyJson()
  input?: unknown;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/** PUT /functions/{id}/schedules/{scheduleId}: what changes; what is left out stays. */
export class UpdateScheduleDto extends PartialType(CreateScheduleDto) {}

/** A schedule, as the API answers it. */
export class ScheduleView {
  @ApiProperty() id: string;
  @ApiProperty() functionId: string;
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true, type: String }) description: string | null;
  @ApiProperty() expression: string;
  @ApiProperty({ nullable: true, description: 'null: the Scheduled Event' }) input: unknown;
  @ApiProperty() enabled: boolean;
  @ApiProperty({ nullable: true, type: Date, description: 'null while disabled, or when a cron has no run left' }) nextRunAt: Date | null;
  @ApiProperty({ nullable: true, type: Date, description: 'When its last run was due' }) lastRunAt: Date | null;
  @ApiProperty({ nullable: true, type: String, description: "The last run's request ID, in the history and the logs" }) lastRequestId: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'success', description: 'success, error, timeout, throttled, or skipped: and why' }) lastOutcome: string | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

/** GET /schedules/next-runs: an expression's next runs, for a form's preview. */
export class NextRunsQuery {
  @ApiProperty({ example: 'cron(0 8 * * ? *)' })
  @IsString()
  @MaxLength(256)
  expression: string;
}

export class NextRunsView {
  @ApiProperty({ type: [Date], description: 'The next five, in UTC; fewer when a cron has fewer left' }) runs: Date[];
}

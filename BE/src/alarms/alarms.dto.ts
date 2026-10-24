import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { MAX_URL_LENGTH } from '../notifications/webhook-target';
import {
  ALARM_PERIODS,
  ALL_STATISTICS,
  AlarmState,
  COMPARISONS,
  Comparison,
  MAX_EVALUATION_PERIODS,
  MAX_WEBHOOKS,
  METRICS,
  MISSING_DATA,
  Metric,
  MissingData,
  STATES,
  Statistic,
} from './alarm-rules';

/** Who an alarm tells when it goes into ALARM, and out of it. */
export class AlarmActionsDto {
  @ApiProperty({ description: "true: an e-mail to each of the account's owners, in their language" })
  @IsBoolean()
  email: boolean;

  @ApiProperty({ type: [String], maxItems: MAX_WEBHOOKS, example: ['https://example.tn/ff-hooks'], description: "Webhook URLs, signed with the account's secret" })
  @IsArray()
  @ArrayMaxSize(MAX_WEBHOOKS)
  @IsString({ each: true })
  @MaxLength(MAX_URL_LENGTH, { each: true })
  webhookUrls: string[];
}

/** POST /alarms and PUT /alarms/:id: an alarm, whole. */
export class AlarmDto {
  @ApiProperty({ maxLength: 100, example: 'Errors in checkout' })
  @IsString()
  @Length(1, 100)
  name: string;

  @ApiPropertyOptional({ nullable: true, description: "The function watched; none for the whole account, and for Balance and MonthToDateCharges" })
  @IsOptional()
  @IsUUID('all', { message: 'functionId must be a UUID' })
  functionId?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'The database watched, for DatabaseConnections and VolumeBytesUsed, whose period is an hour; none otherwise' })
  @IsOptional()
  @IsUUID('all', { message: 'databaseId must be a UUID' })
  databaseId?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'photos',
    description: "The bucket watched, by its name, as CloudWatch's BucketName: for BucketSizeBytes, NumberOfObjects and its requests; none otherwise",
  })
  @IsOptional()
  @IsString()
  @MaxLength(63)
  bucketName?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'orders',
    description: "The queue watched, by its name, as CloudWatch's QueueName: for its messages, their age and size, and its requests; none otherwise",
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  queueName?: string | null;

  @ApiProperty({ enum: METRICS })
  @IsIn(METRICS, { message: `metric must be one of ${METRICS.join(', ')}` })
  metric: Metric;

  @ApiProperty({
    enum: ALL_STATISTICS,
    description:
      "Sum for the counts, a bucket's and a queue's requests among them; Average, Maximum, p50, p95 or p99 for Duration; Maximum or Average for Instances, a database's metrics, a queue's messages and an asynchronous call's age; Average for a bucket's storage; Average or Maximum for a queue's message size, Maximum for its oldest message's age; Latest for the money",
  })
  @IsIn(ALL_STATISTICS, { message: `statistic must be one of ${ALL_STATISTICS.join(', ')}` })
  statistic: Statistic;

  @ApiProperty({ enum: ALARM_PERIODS, description: 'Seconds per datapoint' })
  @Type(() => Number)
  @IsIn([...ALARM_PERIODS], { message: `period must be one of ${ALARM_PERIODS.join(', ')} seconds` })
  period: number;

  @ApiProperty({ enum: COMPARISONS })
  @IsIn(COMPARISONS, { message: `comparison must be one of ${COMPARISONS.join(', ')}` })
  comparison: Comparison;

  @ApiProperty({ example: 5, description: "The metric's unit: calls, milliseconds, instances, sessions, bytes, objects, requests, messages, seconds, or the prices' currency" })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  threshold: number;

  @ApiProperty({ minimum: 1, maximum: MAX_EVALUATION_PERIODS, description: 'N: the last periods judged, a day at most' })
  @IsInt()
  @Min(1)
  @Max(MAX_EVALUATION_PERIODS)
  evaluationPeriods: number;

  @ApiProperty({ minimum: 1, description: 'M: how many of the N must breach for ALARM' })
  @IsInt()
  @Min(1)
  datapointsToAlarm: number;

  @ApiPropertyOptional({ enum: MISSING_DATA, default: 'missing', description: 'What a period without a datapoint counts as' })
  @IsOptional()
  @IsIn(MISSING_DATA, { message: `treatMissingData must be one of ${MISSING_DATA.join(', ')}` })
  treatMissingData?: MissingData;

  @ApiProperty({ type: AlarmActionsDto })
  @ValidateNested()
  @Type(() => AlarmActionsDto)
  actions: AlarmActionsDto;
}

class AlarmActionsView {
  @ApiProperty() email: boolean;
  @ApiProperty({ type: [String] }) webhookUrls: string[];
}

export class AlarmView {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true, type: String }) functionId: string | null;
  @ApiProperty({ nullable: true, type: String }) databaseId: string | null;
  @ApiProperty({ nullable: true, type: String }) bucketName: string | null;
  @ApiProperty({ nullable: true, type: String }) queueName: string | null;
  @ApiProperty({ enum: METRICS }) metric: Metric;
  @ApiProperty({ enum: ALL_STATISTICS }) statistic: Statistic;
  @ApiProperty({ enum: ALARM_PERIODS }) period: number;
  @ApiProperty({ enum: COMPARISONS }) comparison: Comparison;
  @ApiProperty() threshold: number;
  @ApiProperty() evaluationPeriods: number;
  @ApiProperty() datapointsToAlarm: number;
  @ApiProperty({ enum: MISSING_DATA }) treatMissingData: MissingData;
  @ApiProperty({ type: AlarmActionsView }) actions: AlarmActionsView;
  @ApiProperty({ enum: STATES }) state: AlarmState;
  @ApiProperty({ nullable: true, type: String, description: 'Why, in English, as CloudWatch says it' }) stateReason: string | null;
  @ApiProperty({ nullable: true, type: Date }) stateChangedAt: Date | null;
  @ApiProperty({ nullable: true, type: Date, description: 'Its last evaluation: every minute' }) evaluatedAt: Date | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

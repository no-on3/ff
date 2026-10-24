import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';

/** Lambda's one function response type for SQS: the call's answer names the messages that failed. */
export const REPORT_BATCH_ITEM_FAILURES = 'ReportBatchItemFailures';

/** Lambda's ScalingConfig: how many batches may be in calls at once. */
export class ScalingConfigDto {
  @ApiPropertyOptional({ minimum: 2, maximum: 1000, example: 5, description: "The most batches in calls at once, within the function's instances" })
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(1000)
  maximumConcurrency?: number;
}

/** The settings both a new mapping and a change take, by Lambda's names. */
export class EventSourceSettingsDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 10000, example: 10, description: 'The most messages in one call: 10 when left out at first; over 10 needs a batching window' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  batchSize?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 300, example: 0, description: 'How long to wait to fill a batch, in seconds: 0 when left out at first, a call with what one receive gives' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(300)
  maximumBatchingWindowInSeconds?: number;

  @ApiPropertyOptional({
    type: [String],
    enum: [REPORT_BATCH_ITEM_FAILURES],
    example: [REPORT_BATCH_ITEM_FAILURES],
    description: "With ReportBatchItemFailures, the call's answer names the messages that failed, {\"batchItemFailures\": [{\"itemIdentifier\": \"<messageId>\"}]}, and the others are deleted",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1)
  @IsIn([REPORT_BATCH_ITEM_FAILURES], { each: true })
  functionResponseTypes?: string[];

  @ApiPropertyOptional({ type: ScalingConfigDto, nullable: true, description: "Null, or no maximumConcurrency, for as many as the function's instances" })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @ValidateNested()
  @Type(() => ScalingConfigDto)
  scalingConfig?: ScalingConfigDto | null;

  @ApiPropertyOptional({ example: true, description: 'Disabled, nothing is read, and the messages wait: true when left out at first' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/** POST /functions/:id/event-sources: as Lambda's CreateEventSourceMapping, for a queue of the account. */
export class CreateEventSourceDto extends EventSourceSettingsDto {
  @ApiProperty({ example: 'arn:aws:sqs:tn-tunis-1:000000000001:orders', description: "The queue's ARN, a queue of the account in FF's region" })
  @IsString()
  @MaxLength(256)
  eventSourceArn: string;
}

/** PATCH /event-sources/:uuid: as Lambda's UpdateEventSourceMapping, what is given changes, the rest stays. */
export class UpdateEventSourceDto extends EventSourceSettingsDto {}

export class ScalingConfigView {
  @ApiProperty({ example: 5 }) maximumConcurrency: number;
}

/** A function reading a queue, as Lambda's EventSourceMappingConfiguration. */
export class EventSourceView {
  @ApiProperty({ example: '6c2a1e8b-7d4c-4a9e-8f1a-2b3c4d5e6f70', description: "The mapping's ID, Lambda's UUID" })
  uuid: string;

  @ApiProperty({ example: 'arn:aws:sqs:tn-tunis-1:000000000001:orders' })
  eventSourceArn: string;

  @ApiProperty({ example: 'arn:aws:lambda:tn-tunis-1:000000000001:function:orders-worker' })
  functionArn: string;

  @ApiProperty({ example: 10 })
  batchSize: number;

  @ApiProperty({ example: 0 })
  maximumBatchingWindowInSeconds: number;

  @ApiProperty({ type: [String], example: [REPORT_BATCH_ITEM_FAILURES] })
  functionResponseTypes: string[];

  @ApiProperty({ type: ScalingConfigView, nullable: true, description: "Null: as many batches at once as the function's instances" })
  scalingConfig: ScalingConfigView | null;

  @ApiProperty({ enum: ['Enabled', 'Disabled'], description: "Lambda's state: Disabled, nothing is read" })
  state: 'Enabled' | 'Disabled';

  @ApiProperty({ example: 'USER_INITIATED', description: 'Why it is in that state: its users set it so' })
  stateTransitionReason: string;

  @ApiProperty({ description: "Lambda's LastModified: when it last changed" })
  lastModified: Date;
}

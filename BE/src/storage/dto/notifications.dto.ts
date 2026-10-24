import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { EVENT_TYPES, MAX_RULES } from '../bucket-notifications';

/** One rule of a key's filter, as S3 names it: a prefix or a suffix of the object's key. */
export class FilterRuleDto {
  @ApiProperty({ enum: ['prefix', 'suffix'], example: 'prefix' })
  @IsString()
  @MaxLength(16)
  name: string;

  @ApiProperty({ example: 'images/' })
  @IsString()
  @MaxLength(1024)
  value: string;
}

export class KeyFilterDto {
  @ApiProperty({ type: [FilterRuleDto] })
  @IsArray()
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => FilterRuleDto)
  filterRules: FilterRuleDto[];
}

export class NotificationFilterDto {
  @ApiProperty({ type: KeyFilterDto })
  @ValidateNested()
  @Type(() => KeyFilterDto)
  key: KeyFilterDto;
}

/** What every configuration has, by S3's names: its ID, its events and its filter. */
class ConfigurationDto {
  @ApiPropertyOptional({ example: 'thumbnails', description: 'Its ID, 1 to 255 characters; one is made when none is given' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  id?: string;

  @ApiProperty({ type: [String], enum: EVENT_TYPES, example: ['s3:ObjectCreated:*'] })
  @IsArray()
  @ArrayMinSize(1)
  @IsIn(EVENT_TYPES, { each: true })
  events: string[];

  @ApiPropertyOptional({ type: NotificationFilterDto, description: "The objects whose events go there, by their key's prefix and suffix" })
  @IsOptional()
  @ValidateNested()
  @Type(() => NotificationFilterDto)
  filter?: NotificationFilterDto;
}

export class LambdaFunctionConfigurationDto extends ConfigurationDto {
  @ApiProperty({ example: 'arn:aws:lambda:tn-tunis-1:000000000001:function:thumbnails', description: "A function of the account, by its ARN, or its name, kept as its ARN: it is called with S3's event without waiting" })
  @IsString()
  @MaxLength(256)
  lambdaFunctionArn: string;
}

export class QueueConfigurationDto extends ConfigurationDto {
  @ApiProperty({ example: 'arn:aws:sqs:tn-tunis-1:000000000001:uploads', description: "A queue of the account, by its ARN, or its name, kept as its ARN: it gets S3's event as a message" })
  @IsString()
  @MaxLength(256)
  queueArn: string;
}

/** PUT /buckets/:name/notifications, as S3's PutBucketNotificationConfiguration in its JSON names: replaced whole; empty, none. */
export class NotificationConfigurationDto {
  @ApiPropertyOptional({ type: [LambdaFunctionConfigurationDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_RULES)
  @ValidateNested({ each: true })
  @Type(() => LambdaFunctionConfigurationDto)
  lambdaFunctionConfigurations?: LambdaFunctionConfigurationDto[];

  @ApiPropertyOptional({ type: [QueueConfigurationDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_RULES)
  @ValidateNested({ each: true })
  @Type(() => QueueConfigurationDto)
  queueConfigurations?: QueueConfigurationDto[];
}

/** A bucket's notification configuration, as S3 answers it in its JSON names; each configuration with its ID. */
export class NotificationConfigurationView {
  @ApiProperty({ type: [LambdaFunctionConfigurationDto] })
  lambdaFunctionConfigurations: LambdaFunctionConfigurationDto[];

  @ApiProperty({ type: [QueueConfigurationDto] })
  queueConfigurations: QueueConfigurationDto[];
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';

export class DestinationDto {
  @ApiProperty({
    example: 'arn:aws:lambda:tn-tunis-1:000000000001:function:failed-orders',
    description:
      "Another function of the account, by its ARN, as Lambda's, or by its name, kept as its ARN; it gets the call's record as an asynchronous call of its own",
  })
  @IsString()
  @MaxLength(256)
  destination: string;
}

export class DestinationConfigDto {
  @ApiPropertyOptional({ type: DestinationDto, description: 'Where the record of a call that succeeded goes' })
  @IsOptional()
  @ValidateNested()
  @Type(() => DestinationDto)
  onSuccess?: DestinationDto;

  @ApiPropertyOptional({ type: DestinationDto, description: 'Where the record of a call goes once its retries are used up, or it is too old' })
  @IsOptional()
  @ValidateNested()
  @Type(() => DestinationDto)
  onFailure?: DestinationDto;
}

/** PUT /functions/:id/event-invoke-config: as Lambda's PutFunctionEventInvokeConfig, what is left out goes back to Lambda's default. */
export class PutEventInvokeConfigDto {
  @ApiPropertyOptional({ minimum: 0, maximum: 2, description: 'How many times a call its function failed is retried: 2 when left out' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2)
  maximumRetryAttempts?: number;

  @ApiPropertyOptional({ minimum: 60, maximum: 21600, description: 'How long a call is kept before it is dropped, in seconds: 21,600 (6 hours) when left out' })
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(21600)
  maximumEventAgeInSeconds?: number;

  @ApiPropertyOptional({ type: DestinationConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DestinationConfigDto)
  destinationConfig?: DestinationConfigDto;
}

export class DestinationView {
  @ApiPropertyOptional({ description: "The destination's ARN; none when there is none" })
  destination?: string;
}

export class DestinationConfigView {
  @ApiProperty({ type: DestinationView }) onSuccess: DestinationView;
  @ApiProperty({ type: DestinationView }) onFailure: DestinationView;
}

/** A function's settings for its asynchronous calls, as Lambda's GetFunctionEventInvokeConfig answers them. */
export class EventInvokeConfigView {
  @ApiProperty({ example: 'arn:aws:lambda:tn-tunis-1:000000000001:function:orders:$LATEST' }) functionArn: string;
  @ApiProperty({ nullable: true, type: Number, description: "Null: Lambda's default, 2" }) maximumRetryAttempts: number | null;
  @ApiProperty({ nullable: true, type: Number, description: "Null: Lambda's default, 21,600 (6 hours)" }) maximumEventAgeInSeconds: number | null;
  @ApiProperty({ type: DestinationConfigView }) destinationConfig: DestinationConfigView;
  @ApiProperty() lastModified: Date;
}

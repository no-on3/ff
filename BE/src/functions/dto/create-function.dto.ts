import { IsString, IsEnum, IsNumber, IsOptional, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PLATFORM_LIMITS } from '../../plans/plan-limits';
import { Runtime } from '../entities/function.entity';

export class CreateFunctionDto {
  @ApiProperty({ description: 'Name of the function' })
  @IsString()
  name: string;

  @ApiProperty({ enum: Runtime, description: 'Runtime environment for the function' })
  @IsEnum(Runtime)
  runtime: Runtime;

  @ApiProperty({ description: 'Function code' })
  @IsString()
  code: string;

  @ApiProperty({
    description: "Memory allocation in MB. The account's plan sets a lower maximum: 1,024 MB on the beta plan",
    minimum: 128,
    maximum: PLATFORM_LIMITS.memoryMb,
  })
  @IsNumber()
  @Min(128)
  @Max(PLATFORM_LIMITS.memoryMb)
  memory: number;

  @ApiProperty({
    description: "Function timeout in seconds. The account's plan sets a lower maximum: 300 s on the beta plan",
    minimum: 1,
    maximum: PLATFORM_LIMITS.timeoutSeconds,
  })
  @IsNumber()
  @Min(1)
  @Max(PLATFORM_LIMITS.timeoutSeconds)
  timeout: number;

  @ApiPropertyOptional({ description: 'Additional metadata', type: 'object', additionalProperties: true })
  @IsOptional()
  metadata?: Record<string, unknown>;
}

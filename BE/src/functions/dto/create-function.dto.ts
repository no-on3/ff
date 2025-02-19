import { IsString, IsEnum, IsNumber, IsOptional, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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

  @ApiProperty({ description: 'Memory allocation in MB', minimum: 128, maximum: 1024 })
  @IsNumber()
  @Min(128)
  @Max(1024)
  memory: number;

  @ApiProperty({ description: 'Function timeout in seconds', minimum: 1, maximum: 300 })
  @IsNumber()
  @Min(1)
  @Max(300)
  timeout: number;

  @ApiPropertyOptional({ description: 'Additional metadata', type: 'object' })
  @IsOptional()
  metadata?: Record<string, any>;
}

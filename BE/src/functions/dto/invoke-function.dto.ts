import { ApiProperty } from '@nestjs/swagger';
import { IsObject, IsOptional } from 'class-validator';

export class InvokeFunctionDto {
  @ApiProperty({ description: 'Function input data', type: 'object' })
  @IsObject()
  @IsOptional()
  input?: Record<string, any>;
}

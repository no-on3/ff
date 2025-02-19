import { IsObject, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class InvokeFunctionDto {
  @ApiProperty({ description: 'Function input data', type: 'object' })
  @IsObject()
  @IsOptional()
  input?: Record<string, any>;
}

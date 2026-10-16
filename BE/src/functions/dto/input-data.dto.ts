import { ApiProperty } from '@nestjs/swagger';
import { IsObject } from 'class-validator';

export class InputDataDto {
  @ApiProperty({ description: 'Input data for the function', type: 'object' })
  @IsObject()
  data: Record<string, any>;
}

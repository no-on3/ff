import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional } from 'class-validator';

export class InvokeFunctionDto {
  @ApiPropertyOptional({ description: 'The event passed to the handler: a JSON object; {} when missing', type: 'object', additionalProperties: true })
  @IsObject()
  @IsOptional()
  input?: Record<string, any>;
}

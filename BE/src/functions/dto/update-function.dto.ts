import { PartialType } from '@nestjs/swagger';
import { CreateFunctionDto } from './create-function.dto';

export class UpdateFunctionDto extends PartialType(CreateFunctionDto) {}

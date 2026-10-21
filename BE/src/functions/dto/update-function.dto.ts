import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateFunctionDto, EnvironmentProperty } from './create-function.dto';

/** A function's secrets change through PATCH /functions/{id}/secrets alone: an update never names them. */
export class UpdateFunctionDto extends PartialType(OmitType(CreateFunctionDto, ['environment', 'secrets'] as const)) {
  /** All the variables: those sent replace them all, as on AWS Lambda; an empty map removes them. */
  @EnvironmentProperty()
  environment?: Record<string, string>;
}

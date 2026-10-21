import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateFunctionDto, EnvironmentProperty } from './create-function.dto';

/**
 * A function's secrets change through PATCH /functions/{id}/secrets alone: an
 * update never names them. A field left out keeps its value; null is no value
 * of any field but metadata, which it removes, so it is refused rather than
 * taken for "unchanged".
 */
export class UpdateFunctionDto extends PartialType(OmitType(CreateFunctionDto, ['environment', 'secrets'] as const), { skipNullProperties: false }) {
  /** All the variables: those sent replace them all, as on AWS Lambda; an empty map removes them. */
  @EnvironmentProperty()
  environment?: Record<string, string>;
}

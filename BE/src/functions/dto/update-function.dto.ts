import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateFunctionDto, EnvironmentProperty } from './create-function.dto';

export class UpdateFunctionDto extends PartialType(OmitType(CreateFunctionDto, ['environment'] as const)) {
  /** All the variables: those sent replace them all, as on AWS Lambda; an empty map removes them. */
  @EnvironmentProperty()
  environment?: Record<string, string>;
}

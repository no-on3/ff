import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';

/** GET /functions: all the account's functions, or the one of a name, which is how the CLI finds a function. */
export class ListFunctionsQuery {
  @ApiPropertyOptional({
    description: 'Only the function of this name, compared exactly, case included: none or one, since names are unique within an account',
    maxLength: 256,
  })
  @IsOptional()
  @IsString()
  @Length(1, 256)
  name?: string;
}

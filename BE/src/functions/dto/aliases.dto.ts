import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateBy, ValidateNested } from 'class-validator';

/** An alias's name, as Lambda's: letters, digits, - and _, not digits alone, which name a version. */
export const ALIAS_NAME = /^(?!\d+$)[A-Za-z0-9_-]{1,128}$/;
/** What an alias points at: $LATEST, the function as it is, or a version by its number. */
const FUNCTION_VERSION = /^(\$LATEST|[1-9]\d{0,8})$/;

/** At most one version, by its number, with its share of the calls from 0 to 1; none clears it. */
export function isVersionWeights(value: unknown): value is Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 1 && entries.every(([version, weight]) => /^[1-9]\d{0,8}$/.test(version) && typeof weight === 'number' && weight >= 0 && weight <= 1);
}

/** As Lambda's AliasRoutingConfiguration: another version that gets a share of the alias's calls. */
export class AliasRoutingConfigDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number', minimum: 0, maximum: 1 },
    example: { '4': 0.1 },
    description: "One version, by its number, and its share of the alias's calls, from 0 to 1; the alias's own version gets the rest. {} for none",
  })
  @ValidateBy({
    name: 'versionWeights',
    validator: {
      validate: isVersionWeights,
      defaultMessage: () => "additionalVersionWeights names at most one version, by its number, with its share of the calls from 0 to 1, as Lambda's",
    },
  })
  additionalVersionWeights: Record<string, number>;
}

/** What PUT /functions/:id/aliases/:name may change, as Lambda's UpdateAlias: what it leaves out stays. */
export class UpdateAliasDto {
  @ApiPropertyOptional({ example: '3', description: "$LATEST, the function as it is, or a version's number" })
  @IsOptional()
  @Matches(FUNCTION_VERSION, { message: "functionVersion is $LATEST or a version's number" })
  functionVersion?: string;

  @ApiPropertyOptional({ maxLength: 256, example: 'What the shop runs' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  description?: string;

  @ApiPropertyOptional({ type: AliasRoutingConfigDto, description: "Another version's share of the calls; { additionalVersionWeights: {} } for none" })
  @IsOptional()
  @ValidateNested()
  @Type(() => AliasRoutingConfigDto)
  routingConfig?: AliasRoutingConfigDto;

  @ApiPropertyOptional({ description: 'Change it only if it is still at this revision, as GET gives it: refused with 412 once another change came between' })
  @IsOptional()
  @IsUUID()
  revisionId?: string;
}

/** POST /functions/:id/aliases: as Lambda's CreateAlias. */
export class CreateAliasDto {
  @ApiProperty({ example: 'live', description: "1 to 128 letters, digits, - and _, not digits alone, as Lambda's" })
  @Matches(ALIAS_NAME, { message: "name is 1 to 128 letters, digits, - and _, not digits alone, which name a version, as Lambda's" })
  name: string;

  @ApiProperty({ example: '3', description: "$LATEST, the function as it is, or a version's number" })
  @Matches(FUNCTION_VERSION, { message: "functionVersion is $LATEST or a version's number" })
  functionVersion: string;

  @ApiPropertyOptional({ maxLength: 256, example: 'What the shop runs' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  description?: string;

  @ApiPropertyOptional({ type: AliasRoutingConfigDto, description: "Another version's share of the calls, as Lambda's weighted aliases" })
  @IsOptional()
  @ValidateNested()
  @Type(() => AliasRoutingConfigDto)
  routingConfig?: AliasRoutingConfigDto;
}

/** An alias, as AWS Lambda's AliasConfiguration. */
export class FunctionAliasView {
  @ApiProperty({ example: 'arn:aws:lambda:tn-tunis-1:000000000001:function:orders:live', description: "The alias's ARN, as Lambda's: the function's, then its name" })
  aliasArn: string;
  @ApiProperty({ example: 'live' }) name: string;
  @ApiProperty({ example: '3', description: '$LATEST or the number of the version its calls go to' }) functionVersion: string;
  @ApiProperty({ example: 'What the shop runs' }) description: string;
  @ApiPropertyOptional({ type: AliasRoutingConfigDto, description: "Another version's share of the calls; absent when there is none" })
  routingConfig?: AliasRoutingConfigDto;
  @ApiProperty({ format: 'uuid', description: "Lambda's RevisionId of an alias, new with each change" }) revisionId: string;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

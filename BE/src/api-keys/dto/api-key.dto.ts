import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayNotEmpty, ArrayUnique, IsArray, IsIn, IsISO8601, IsOptional, IsString, Length } from 'class-validator';
import { SCOPES, Scope } from '../api-key-format';

/** POST /api-keys. */
export class CreateApiKeyDto {
  @ApiProperty({ description: 'What the key is for, e.g. "CI deploys"', maxLength: 100 })
  @IsString()
  @Length(1, 100)
  name: string;

  @ApiProperty({ enum: SCOPES, isArray: true, description: 'What the key may do' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsIn(SCOPES, { each: true })
  scopes: Scope[];

  @ApiPropertyOptional({ description: 'When the key stops working (ISO 8601); never, by default' })
  @IsOptional()
  @IsISO8601({ strict: true })
  expiresAt?: string;
}

/** A key, as its account's owners see it: never its secret. */
export class ApiKeyView {
  @ApiProperty({ example: '0f3a9c21be47', description: 'The key ID: safe to show and to log' }) id: string;
  @ApiProperty() name: string;
  @ApiProperty({ enum: SCOPES, isArray: true }) scopes: Scope[];
  @ApiProperty({ description: 'The user who created it: the key never does more than their role allows' }) createdBy: string;
  @ApiProperty() createdAt: Date;
  @ApiProperty({ nullable: true, type: Date }) expiresAt: Date | null;
  @ApiProperty({ nullable: true, type: Date }) lastUsedAt: Date | null;
  @ApiProperty({ nullable: true, type: Date }) revokedAt: Date | null;
}

/** The answer to POST /api-keys: the only time the whole key is shown. */
export class CreatedApiKey extends ApiKeyView {
  @ApiProperty({ example: 'ffk_0f3a9c21be47_…', description: 'Send it as "Authorization: Bearer <key>". It is shown once.' })
  key: string;
}

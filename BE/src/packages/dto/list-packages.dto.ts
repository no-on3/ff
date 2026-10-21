import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';
import { CODE_SHA256, CODE_SHA256_RULE } from '../../functions/code-package';

export class ListPackagesQuery {
  @ApiPropertyOptional({
    description: "Only the account's package of this SHA-256, in base64 (URL-encoded in a query): none or one. Tells whether a package needs uploading",
    pattern: CODE_SHA256.source,
  })
  @IsOptional()
  @Matches(CODE_SHA256, { message: `codeSha256 ${CODE_SHA256_RULE}` })
  codeSha256?: string;
}

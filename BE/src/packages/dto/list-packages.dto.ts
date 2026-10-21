import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';

/** A SHA-256 in base64, as AWS Lambda's CodeSha256 gives one: 43 characters and a =. */
export const CODE_SHA256 = /^[A-Za-z0-9+/]{43}=$/;

export class ListPackagesQuery {
  @ApiPropertyOptional({
    description: "Only the account's package of this SHA-256, in base64 (URL-encoded in a query): none or one. Tells whether a package needs uploading",
    pattern: CODE_SHA256.source,
  })
  @IsOptional()
  @Matches(CODE_SHA256, { message: 'codeSha256 must be a SHA-256 in base64, as AWS Lambda gives it: 44 characters ending with =' })
  codeSha256?: string;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';

/** S3's IndexDocument: what a folder's path answers. */
export class IndexDocumentDto {
  @ApiProperty({ example: 'index.html', description: "Appended to a folder's path, as S3's Suffix: a name without a slash" })
  @IsString()
  @MaxLength(1024)
  suffix: string;
}

/** S3's ErrorDocument: what a path with no file answers, with 404. */
export class ErrorDocumentDto {
  @ApiProperty({ example: '404.html', description: "The key of the bucket's object that answers, as S3's Key" })
  @IsString()
  @MaxLength(1024)
  key: string;
}

/** PUT /buckets/:name/website: S3's website configuration, in its JSON names, and FF's one setting more. */
export class WebsiteConfigurationDto {
  @ApiProperty({ type: IndexDocumentDto })
  @ValidateNested()
  @Type(() => IndexDocumentDto)
  indexDocument: IndexDocumentDto;

  @ApiPropertyOptional({ type: ErrorDocumentDto, description: "Without one, a path with no file answers a page of FF's, with 404" })
  @IsOptional()
  @ValidateNested()
  @Type(() => ErrorDocumentDto)
  errorDocument?: ErrorDocumentDto;

  @ApiPropertyOptional({
    example: true,
    description:
      "FF's own, for a single-page app: a path with no file answers the index document with 200, as CloudFront's custom error response gives one, so that the app's own routes load. False by default, as S3 alone answers",
  })
  @IsOptional()
  @IsBoolean()
  singlePageApp?: boolean;
}

/** A bucket's website configuration, as the API answers it, with the site's address. */
export class WebsiteView {
  @ApiProperty({ type: IndexDocumentDto })
  indexDocument: IndexDocumentDto;

  @ApiPropertyOptional({ type: ErrorDocumentDto })
  errorDocument?: ErrorDocumentDto;

  @ApiProperty()
  singlePageApp: boolean;

  @ApiProperty({ example: 'https://photos.site.ffunc.cloud', description: "The site's address: every file of the bucket is public to read there" })
  url: string;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { AwsEndpoint } from '../../common/aws-endpoint';
import { EventFormat, PackageType, Runtime } from '../entities/function.entity';

/** POST /functions/:id/versions: as AWS Lambda's PublishVersion, each check made only when its value is given. */
export class PublishVersionDto {
  @ApiPropertyOptional({ maxLength: 256, example: 'Receipts in French', description: "What the version is, as Lambda's Description" })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  description?: string;

  @ApiPropertyOptional({
    example: 'n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=',
    description: "Publish only if the function's code has this SHA-256, in base64, as GET /functions/{id} gives it: refused with 400 when it hasn't",
  })
  @IsOptional()
  @IsString()
  @MaxLength(44)
  codeSha256?: string;

  @ApiPropertyOptional({
    description: 'Publish only if the function is still at this revision, as GET /functions/{id} gives it: refused with 412 once another change came between',
  })
  @IsOptional()
  @IsUUID()
  revisionId?: string;
}

/** A version, as AWS Lambda's FunctionConfiguration of one, its fields as FF's API names a function's. */
export class FunctionVersionView {
  @ApiProperty({ format: 'uuid' }) functionId: string;
  @ApiProperty({ example: 'arn:aws:lambda:tn-tunis-1:000000000001:function:orders:3', description: "The version's ARN, as Lambda's: the function's, then its number" })
  functionArn: string;
  @ApiProperty({ example: '3', description: 'Its number, as Lambda writes it: 1, 2, 3…, never given twice' }) version: string;
  @ApiProperty({ example: 'Receipts in French' }) description: string;
  @ApiProperty({ enum: Runtime }) runtime: Runtime;
  @ApiProperty({ example: 'function.handler' }) handler: string;
  @ApiProperty({ enum: PackageType }) packageType: PackageType;
  @ApiProperty({ description: 'The SHA-256 of its code, in base64, as the function had it when it was published' }) codeSha256: string;
  @ApiProperty({ description: "Its code's size in bytes" }) codeSize: number;
  @ApiProperty({ example: 128 }) memory: number;
  @ApiProperty({ example: 30 }) timeout: number;
  @ApiProperty({ enum: EventFormat }) eventFormat: EventFormat;
  @ApiProperty({ enum: AwsEndpoint, isArray: true }) awsEndpoints: AwsEndpoint[];
  @ApiProperty({ format: 'uuid', description: "Lambda's RevisionId of a version, which never changes" }) revisionId: string;
  @ApiProperty() createdAt: Date;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Its variables as they were published, in GET /functions/{id}/versions/{version} alone; never its secrets',
  })
  environment?: Record<string, string>;
}

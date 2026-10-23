import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayNotEmpty, ArrayUnique, IsArray, IsBoolean, IsOptional, IsString, MaxLength, Validate, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';
import { BucketStatus } from '../bucket.entity';
import { bucketNameProblem } from '../storage-names';

@ValidatorConstraint({ name: 'bucketName' })
class BucketNameRule implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && bucketNameProblem(value) === undefined;
  }

  /** Why: of a list, as `each` validates one, its first name that fails. */
  defaultMessage(args?: { value?: unknown }): string {
    const values: unknown[] = Array.isArray(args?.value) ? (args.value as unknown[]) : [args?.value];
    const wrong = values.find((value) => typeof value !== 'string' || bucketNameProblem(value) !== undefined);
    return typeof wrong === 'string' ? (bucketNameProblem(wrong) as string) : 'a bucket name must be text';
  }
}

/** POST /buckets. */
export class CreateBucketDto {
  @ApiProperty({ example: 'photos', description: "The bucket's name, AWS's rules without dots: 3 to 63 lower-case letters, digits and hyphens, unique across FF" })
  @IsString()
  @MaxLength(63)
  @Validate(BucketNameRule)
  name: string;
}

/** A bucket, as the API shows it. */
export class BucketView {
  @ApiProperty({ example: 'photos', description: 'Its name, which S3 requests name' })
  name: string;

  @ApiProperty({ enum: BucketStatus, description: 'active; deleting while it is emptied and deleted' })
  status: BucketStatus;

  @ApiProperty({ example: 'tn-tunis-1', description: "FF's region, as GetBucketLocation answers it" })
  region: string;

  @ApiProperty({ example: 'https://s3.ffunc.tn', description: "The S3 endpoint to give AWS's SDKs and CLI" })
  endpoint: string;

  @ApiProperty({ example: 'https://photos.s3.ffunc.tn', description: 'Its own address, virtual-hosted' })
  url: string;

  @ApiProperty({ nullable: true, type: Number, example: 161_480_253, description: 'What it held at its last hourly measure, in bytes, as S3 bills storage; null before its first' })
  sizeBytes: number | null;

  @ApiProperty({ nullable: true, type: Number, example: 1_204, description: 'Its objects then' })
  objects: number | null;

  @ApiProperty({ nullable: true, type: Date, description: 'The hour of its last measure; the next comes within the next hour' })
  measuredAt: Date | null;

  @ApiProperty()
  createdAt: Date;
}

/** POST /storage-keys: what the key reaches. */
export class CreateStorageKeyDto {
  @ApiPropertyOptional({ type: [String], example: ['photos'], description: "The buckets it reaches, by name, as an IAM policy names them; all the account's without it" })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @ArrayMaxSize(100)
  @Validate(BucketNameRule, { each: true })
  buckets?: string[];

  @ApiPropertyOptional({ default: false, description: 'Reads and lists only: no write, copy or delete' })
  @IsOptional()
  @IsBoolean()
  readOnly?: boolean;
}

/** An access key to the account's buckets, as its owners see it: never its secret. */
export class StorageKeyView {
  @ApiProperty({ example: 'AKFF7Q2MLKX4RTZB3W5N', description: 'The access key ID, AWS_ACCESS_KEY_ID: safe to show and to log' })
  id: string;

  @ApiProperty({ type: [String], nullable: true, example: ['photos'], description: "The buckets it reaches; null for all the account's" })
  buckets: string[] | null;

  @ApiProperty()
  readOnly: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({ nullable: true, type: Date, description: 'When a request last came signed with it, to the minute' })
  lastUsedAt: Date | null;
}

/** The answer to POST /storage-keys: the only time its secret is shown. */
export class CreatedStorageKey extends StorageKeyView {
  @ApiProperty({ example: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', description: 'The secret access key, AWS_SECRET_ACCESS_KEY: shown once, FF keeps it sealed' })
  secretAccessKey: string;

  @ApiProperty({ example: 'https://s3.ffunc.tn', description: "The S3 endpoint to give AWS's SDKs and CLI with it" })
  endpoint: string;

  @ApiProperty({ example: 'tn-tunis-1' })
  region: string;
}

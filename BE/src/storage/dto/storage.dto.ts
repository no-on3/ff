import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Validate,
  ValidateIf,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { FUNCTION_NAME } from '../../functions/dto/create-function.dto';
import { BucketStatus } from '../bucket.entity';
import { ALL_FUNCTIONS, FUNCTION_ACCESS, FunctionAccess } from '../storage-key.entity';
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

/** An access key's name, as an IAM user's: 1 to 64 letters, digits and +=,.@_-. */
export const KEY_NAME = /^[\w+=,.@-]{1,64}$/;

@ValidatorConstraint({ name: 'functionNames' })
class FunctionNamesRule implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return Array.isArray(value) && value.every((name) => typeof name === 'string' && (name === ALL_FUNCTIONS || FUNCTION_NAME.test(name))) && (value.length === 1 || !value.includes(ALL_FUNCTIONS));
  }

  defaultMessage(): string {
    return `functions must be functions' names, 1 to 64 letters, digits, hyphens or underscores, or "${ALL_FUNCTIONS}" alone for all the account's`;
  }
}

/** Whether a key's request names functions or a level for them: then both are needed. */
const namesFunctions = (dto: CreateStorageKeyDto): boolean => dto.functions !== undefined || dto.functionAccess !== undefined;

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

  @ApiProperty({ example: 'https://s3.ffunc.cloud', description: "The S3 endpoint to give AWS's SDKs and CLI" })
  endpoint: string;

  @ApiProperty({ example: 'https://photos.s3.ffunc.cloud', description: 'Its own address, virtual-hosted' })
  url: string;

  @ApiProperty({ nullable: true, type: Number, example: 161_480_253, description: 'What it held at its last hourly measure, in bytes, as S3 bills storage; null before its first' })
  sizeBytes: number | null;

  @ApiProperty({ nullable: true, type: Number, example: 1_204, description: 'Its objects then' })
  objects: number | null;

  @ApiProperty({ nullable: true, type: Date, description: 'The hour of its last measure; the next comes within the next hour' })
  measuredAt: Date | null;

  @ApiProperty({ nullable: true, type: String, example: 'https://photos.site.ffunc.cloud', description: "Its site's address, public to read, once its website configuration is set; null for none" })
  siteUrl: string | null;

  @ApiProperty()
  createdAt: Date;
}

/** POST /storage-keys: the key's name, and what it reaches. */
export class CreateStorageKeyDto {
  @ApiPropertyOptional({
    example: 'shop-uploads',
    description: "Its name, as an IAM user's: 1 to 64 letters, digits and +=,.@_-, the account's working keys' once; its ID when none is given",
  })
  @IsOptional()
  @IsString()
  @Matches(KEY_NAME, { message: "name must be 1 to 64 letters, digits and +=,.@_-, as an IAM user's" })
  name?: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['photos'],
    description: "The buckets it reaches, by name, as an IAM policy names them. Naming neither buckets nor queues, it reaches all the account's; naming some, those alone",
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @ArrayMaxSize(100)
  @Validate(BucketNameRule, { each: true })
  buckets?: string[];

  @ApiPropertyOptional({ type: [String], example: ['orders'], description: 'The queues it reaches, by name, as buckets: naming queues alone, it reaches no bucket' })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @ArrayMaxSize(100)
  @Matches(/^[A-Za-z0-9_-]{1,80}$/, { each: true, message: "each of queues must be a queue's name: 1 to 80 letters, digits, hyphens or underscores" })
  queues?: string[];

  @ApiPropertyOptional({ default: false, description: 'Its buckets, queues and mail read and listed only: no write, copy or delete' })
  @IsOptional()
  @IsBoolean()
  readOnly?: boolean;

  @ApiPropertyOptional({
    type: [String],
    example: ['orders'],
    description: `The functions it reaches, by name, or ["${ALL_FUNCTIONS}"] for all the account's, at its functionAccess; none when not given, as a key made before. Naming functions alone, it reaches no bucket, queue or mail`,
  })
  @ValidateIf(namesFunctions)
  @IsDefined({ message: `functions goes with functionAccess: the functions' names, or ["${ALL_FUNCTIONS}"]` })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @ArrayMaxSize(100)
  @Validate(FunctionNamesRule)
  functions?: string[];

  @ApiPropertyOptional({
    enum: FUNCTION_ACCESS,
    description:
      "What it may do with its functions, as IAM groups Lambda's actions: read (Lambda's List and Read actions), invoke (those, and InvokeFunction, so an AWS_IAM function URL too), write (every operation). It goes with functions",
  })
  @ValidateIf(namesFunctions)
  @IsIn(FUNCTION_ACCESS, { message: 'functionAccess goes with functions, and is read, invoke or write' })
  functionAccess?: FunctionAccess;
}

/** An access key to the account's buckets, queues, mail and functions, as its owners see it: never its secret. */
export class StorageKeyView {
  @ApiProperty({ example: 'AKFF7Q2MLKX4RTZB3W5N', description: 'The access key ID, AWS_ACCESS_KEY_ID: safe to show and to log' })
  id: string;

  @ApiProperty({ example: 'shop-uploads', description: 'Its name, as an IAM user\'s; a key made before keys had names has its ID' })
  name: string;

  @ApiProperty({ type: [String], nullable: true, example: ['photos'], description: "The buckets it names; null for none named. A key that names neither buckets nor queues reaches all the account's" })
  buckets: string[] | null;

  @ApiProperty({ type: [String], nullable: true, example: null, description: 'The queues it names; null for none named' })
  queues: string[] | null;

  @ApiProperty()
  readOnly: boolean;

  @ApiProperty({ type: [String], nullable: true, example: ['orders'], description: `The functions it names, or ["${ALL_FUNCTIONS}"] for all; null for none` })
  functions: string[] | null;

  @ApiProperty({ enum: FUNCTION_ACCESS, nullable: true, description: 'What it may do with them: read, invoke or write; null while it names none' })
  functionAccess: FunctionAccess | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({ nullable: true, type: Date, description: 'When a request last came signed with it, to the minute' })
  lastUsedAt: Date | null;
}

/** The answer to POST /buckets/:name/website/deploy-keys: a key to the bucket alone, for an hour, its secret shown this once. */
export class CreatedDeployKey {
  @ApiProperty({ example: 'shop' })
  bucket: string;

  @ApiProperty({ example: 'AKFF0123456789ABCDEF', description: 'AWS_ACCESS_KEY_ID' })
  accessKeyId: string;

  @ApiProperty({ example: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', description: 'AWS_SECRET_ACCESS_KEY: shown once, FF keeps it sealed' })
  secretAccessKey: string;

  @ApiProperty({ description: 'When it stops working: an hour after it was made' })
  expiresAt: Date;

  @ApiProperty({ example: 'https://s3.ffunc.cloud', description: 'The S3 endpoint it signs for' })
  endpoint: string;

  @ApiProperty({ example: 'tn-tunis-1' })
  region: string;
}

/** The answer to POST /storage-keys: the only time its secret is shown. */
export class CreatedStorageKey extends StorageKeyView {
  @ApiProperty({ example: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', description: 'The secret access key, AWS_SECRET_ACCESS_KEY: shown once, FF keeps it sealed' })
  secretAccessKey: string;

  @ApiProperty({ example: 'https://s3.ffunc.cloud', description: "The S3 endpoint to give AWS's SDKs and CLI with it" })
  endpoint: string;

  @ApiProperty({ example: 'https://sqs.ffunc.cloud', description: "The SQS endpoint to give them, AWS_ENDPOINT_URL_SQS, for the account's queues" })
  sqsEndpoint: string;

  @ApiProperty({ example: 'https://email.ffunc.cloud', description: "The SES endpoint to give them, AWS_ENDPOINT_URL_SESV2, for the account's mail: a key that names buckets, queues or functions doesn't reach it" })
  sesEndpoint: string;

  @ApiProperty({ example: 'tn-tunis-1' })
  region: string;
}

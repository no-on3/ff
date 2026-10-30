import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MaxLength, Validate, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';
import { cacheNameProblem } from '../cache-names';
import { CacheStatus } from '../cache.entity';

@ValidatorConstraint({ name: 'cacheName' })
class CacheNameRule implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && cacheNameProblem(value) === undefined;
  }

  defaultMessage(): string {
    return 'name must be 1 to 40 lower-case letters, digits and hyphens, a letter first, no two hyphens in a row and none last, as AWS ElastiCache names its clusters';
  }
}

export class CreateCacheDto {
  @ApiProperty({ example: 'sessions', description: "The cache's name in the account: 1 to 40 lower-case letters, digits and hyphens, a letter first" })
  @IsString()
  @MaxLength(40)
  @Validate(CacheNameRule)
  name: string;
}

/** A cache, as the API shows it: never its password, which FF doesn't keep. */
export class CacheView {
  @ApiProperty({ example: 'sessions', description: 'Its name in the account' })
  name: string;

  @ApiProperty({ enum: CacheStatus, description: 'active; suspended with its account (its user can\'t log in); creating, deleting' })
  status: CacheStatus;

  @ApiProperty({ example: 'cache.ffunc.cloud', description: 'The server, as functions and developers reach it' })
  host: string;

  @ApiProperty({ example: 6400, description: 'Its own port on the server' })
  port: number;

  @ApiProperty({ example: 'rediss://default@cache.ffunc.cloud:6400', description: 'How to connect, over TLS, without the password' })
  address: string;

  @ApiProperty({ example: 64, description: "Its memory, in MB, the plan's: past it, the least recently used keys go, as Valkey's allkeys-lru" })
  memoryMb: number;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 1_048_576, description: 'The bytes its keys use now (BytesUsedForCache); null when the server could not be asked' })
  bytesUsedForCache: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 2, description: 'Its connections now (CurrConnections); null when the server could not be asked' })
  currConnections: number | null;

  @ApiProperty({ example: 'Valkey 9.1', description: 'What answers: Valkey, which speaks Redis OSS\'s protocol, as ElastiCache for Valkey runs it' })
  engine: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  passwordSetAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

/** A cache just made, or its password just changed: the password, in this answer only. */
export class CacheWithPassword extends CacheView {
  @ApiProperty({ example: 'Xq3v…', description: 'The password: FF keeps no copy, so this answer is the only time it is shown' })
  password: string;

  @ApiProperty({
    example: 'rediss://default:Xq3v…@cache.ffunc.cloud:6400',
    description: "Its address with the password, for a function's REDIS_URL secret, as redis, ioredis and redis-py take it: shown this once",
  })
  url: string;
}

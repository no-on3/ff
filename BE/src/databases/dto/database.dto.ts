import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MaxLength, Validate, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';
import { databaseNameProblem } from '../database-names';
import { DatabaseStatus } from '../database.entity';

@ValidatorConstraint({ name: 'databaseName' })
class DatabaseNameRule implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && databaseNameProblem(value) === undefined;
  }

  defaultMessage(): string {
    return 'name must be 1 to 63 lower-case letters, digits and hyphens, a letter first, no two hyphens in a row and none last, as AWS RDS names its databases';
  }
}

export class CreateDatabaseDto {
  @ApiProperty({ example: 'orders', description: "The database's name in the account: 1 to 63 lower-case letters, digits and hyphens, a letter first" })
  @IsString()
  @MaxLength(63)
  @Validate(DatabaseNameRule)
  name: string;
}

/** A database, as the API shows it: never its password, which FF doesn't keep. */
export class DatabaseView {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'orders', description: "Its name in the account" })
  name: string;

  @ApiProperty({ enum: DatabaseStatus, description: 'active; read_only past the plan\'s storage (its new sessions read-only); suspended with its account; creating, deleting' })
  status: DatabaseStatus;

  @ApiProperty({ example: 'db.ffunc.cloud', description: 'The server, as functions and developers reach it' })
  host: string;

  @ApiProperty({ example: 5432 })
  port: number;

  @ApiProperty({ example: 'ff_3f9c2a1e8b7d4c6a9e5f1a2b', description: 'The database on the server, and its user: the same opaque name' })
  database: string;

  @ApiProperty({ example: 'ff_3f9c2a1e8b7d4c6a9e5f1a2b' })
  user: string;

  @ApiProperty({ example: 'postgresql://ff_3f9c2a1e8b7d4c6a9e5f1a2b@db.ffunc.cloud:5432/ff_3f9c2a1e8b7d4c6a9e5f1a2b?sslmode=require', description: 'How to connect, without the password' })
  connectionUrl: string;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 7_634_423, description: 'Its size now, in bytes; null when the server could not be asked' })
  sizeBytes: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 2, description: 'Its sessions now; null when the server could not be asked' })
  connections: number | null;

  @ApiProperty({ example: 10, description: "The plan's sessions at most, which the server enforces" })
  connectionLimit: number;

  @ApiProperty({ example: 1024, description: "The plan's storage for it, in MB: past it, its new sessions start read-only" })
  storageLimitMb: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  passwordSetAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

/** A database just made, or its password just changed: the password, in this answer only. */
export class DatabaseWithPassword extends DatabaseView {
  @ApiProperty({ example: 'Xq3v…', description: 'The password: FF keeps no copy, so this answer is the only time it is shown' })
  password: string;

  @ApiProperty({
    example: 'postgresql://ff_3f9c…:Xq3v…@db.ffunc.cloud:5432/ff_3f9c…?sslmode=require',
    description: "The connection string with the password, for a function's DATABASE_URL secret: shown this once",
  })
  connectionString: string;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO31661Alpha2, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { Role } from '../../auth/principal';
import { AccountStatus } from '../entities/account.entity';

/** POST /accounts: a new account, whose creator becomes its owner. */
export class CreateAccountDto {
  @ApiProperty({ description: "The account's name: a company, a team or a project", maxLength: 100 })
  @IsString()
  @Length(1, 100)
  name: string;

  @ApiPropertyOptional({ description: 'What you plan to build: it helps us approve the account during the beta', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  useCase?: string;

  @ApiPropertyOptional({ description: 'ISO 3166 country code', default: 'TN' })
  @IsOptional()
  @IsISO31661Alpha2()
  country?: string;

  @ApiPropertyOptional({ description: 'The tax ID (matricule fiscal), for invoices', maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  taxId?: string;
}

/** PATCH /accounts/:id: the owner renames the account or sets its tax ID (null removes it). */
export class UpdateAccountDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  name?: string;

  @ApiPropertyOptional({ maxLength: 32, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  taxId?: string | null;
}

/** An account, as its members see it. */
export class AccountView {
  @ApiProperty({ example: '123456789012' }) id: string;
  @ApiProperty() name: string;
  @ApiProperty({ enum: AccountStatus }) status: AccountStatus;
  @ApiProperty({ enum: ['owner', 'developer', 'viewer'] }) role: Role;
  @ApiProperty({ example: 'beta' }) planId: string;
  @ApiProperty({ example: 'TN' }) country: string;
  @ApiProperty({ nullable: true, type: String }) taxId: string | null;
  @ApiProperty() internetEgress: boolean;
  @ApiProperty({ nullable: true, type: String }) useCase: string | null;
  @ApiProperty() createdAt: Date;
}

class MeUser {
  @ApiProperty() id: string;
  @ApiProperty() email: string;
  @ApiProperty({ nullable: true, type: String }) name: string | null;
  @ApiProperty() locale: string;
}

class MeAccount {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty({ enum: AccountStatus }) status: AccountStatus;
  @ApiProperty({ enum: ['owner', 'developer', 'viewer'] }) role: Role;
}

/** GET /me: the user, and the accounts they belong to (D4). */
export class MeView {
  @ApiProperty({ type: MeUser, nullable: true, description: 'null in development mode, which acts without a user' })
  user: MeUser | null;

  @ApiProperty({ type: [MeAccount] })
  accounts: MeAccount[];
}

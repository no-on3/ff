import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO31661Alpha2, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { SCOPES } from '../../api-keys/api-key-format';
import { Role } from '../../auth/principal';
import { LOCALES, Locale } from '../../mail/language';
import { PlanSummary } from '../../plans/plan.dto';
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
  @ApiProperty({ enum: LOCALES, description: 'The language of the e-mails FF sends this user: French (fr-TN), as at first, or English (en)' }) locale: string;
}

/** PATCH /me: the logged-in user's own settings, for all their accounts. */
export class UpdateMeDto {
  @ApiProperty({ enum: LOCALES, description: 'The language of the e-mails FF sends you: French (fr-TN) or English (en)' })
  @IsIn([...LOCALES], { message: `locale must be one of ${LOCALES.join(', ')}` })
  locale: Locale;
}

class MeAccount {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty({ enum: AccountStatus }) status: AccountStatus;
  @ApiProperty({ enum: ['owner', 'developer', 'viewer'] }) role: Role;
  @ApiProperty({ type: PlanSummary, description: "The account's plan and its limits (D5)" }) plan: PlanSummary;
  @ApiProperty({ description: "Whether its functions may reach the internet: its plan's default when it was made, unless FF's operator changed it" })
  internetEgress: boolean;
  @ApiProperty({ nullable: true, type: Date, description: "When a closed account's functions, their invocation history and logs are deleted: its closure plus the notice period set then. Null unless the account is closed" })
  dataDeletionDueAt: Date | null;
  @ApiProperty({ nullable: true, type: Date, description: 'When they were deleted; null until then' }) dataDeletedAt: Date | null;
  @ApiProperty({ nullable: true, type: Date, description: "When FF turned the account's databases and buckets off: their users can't log in. Null while they are on" })
  storageDisabledAt: Date | null;
  @ApiProperty({ nullable: true, type: String, description: "FF's reason for it; null while they are on" }) storageDisabledReason: string | null;
}

/** The API key a request came with, as GET /me shows it to the key itself. */
class MeKey {
  @ApiProperty({ example: '0123456789ab', description: 'The key ID: the key reads ffk_<id>_<secret>' }) id: string;
  @ApiProperty({ example: 'laptop' }) name: string;
  @ApiProperty({ enum: SCOPES, isArray: true, description: 'What the key may do, within its creator\'s role' }) scopes: string[];
}

/** GET /me: the user, and the accounts they belong to (D4); or the API key, and its account. */
export class MeView {
  @ApiProperty({ type: MeUser, nullable: true, description: 'null for an API key, and in development mode, which acts without a user' })
  user: MeUser | null;

  @ApiProperty({ type: MeKey, nullable: true, description: "The API key the request came with; null for a user's token and in development mode" })
  key: MeKey | null;

  @ApiProperty({ type: [MeAccount], description: "The user's accounts; for a key, its own, with its creator's role, which bounds what the key may do" })
  accounts: MeAccount[];
}

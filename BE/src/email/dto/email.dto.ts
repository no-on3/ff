import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { EmailIdentityStatus, EmailIdentityType } from '../email-identity.entity';
import { SuppressionReason } from '../email-suppression.entity';

export class CreateEmailIdentityDto {
  @ApiProperty({ example: 'shop.example.tn', description: 'A domain to send from, proved by its DKIM record; or an address, proved by the link FF e-mails it' })
  @IsString()
  @MaxLength(320)
  identity: string;
}

/** A record a domain publishes, and what it is for. */
export class MailRecordView {
  @ApiProperty({ enum: ['DKIM', 'MAIL_FROM', 'SPF', 'DMARC'], description: 'DKIM proves the domain; MAIL_FROM and SPF bring its bounces back; DMARC, advised, only reports' })
  purpose: 'DKIM' | 'MAIL_FROM' | 'SPF' | 'DMARC';

  @ApiProperty({ enum: ['TXT', 'MX'] })
  type: 'TXT' | 'MX';

  @ApiProperty({ example: 'ff3c9a1b2e._domainkey.shop.example.tn' })
  name: string;

  @ApiProperty({ example: 'v=DKIM1; k=rsa; p=MIIBIjANBgkq…' })
  value: string;
}

/** A domain or an address the account sends mail from, as SES v2 keeps an email identity. */
export class EmailIdentityView {
  @ApiProperty({ example: 'shop.example.tn', description: 'The domain, or the address, in lower case' })
  identity: string;

  @ApiProperty({ enum: EmailIdentityType })
  type: EmailIdentityType;

  @ApiProperty({ enum: EmailIdentityStatus, description: "As SES's VerificationStatus: PENDING until its record is found or its link followed; FAILED past 72 hours; TEMPORARY_FAILURE, its record gone since" })
  status: EmailIdentityStatus;

  @ApiProperty({ description: 'Whether mail may go from it: once proved' })
  sendingEnabled: boolean;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'ff3c9a1b2e', description: "A domain's DKIM selector: its record is at <selector>._domainkey.<domain>" })
  dkimSelector: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'bounces.mail.shop.example.tn', description: "A domain's own return path, where its bounces come back once its MX record is FF's" })
  mailFromDomain: string | null;

  @ApiProperty({ description: "Whether the return path's MX record is found: until then, bounces come back to FF's own" })
  mailFromVerified: boolean;

  @ApiProperty({ type: [MailRecordView], description: "The records a domain publishes; none for an address" })
  records: MailRecordView[];

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  verifiedAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

/** The account's sending, as SES v2's GetAccount says it. */
export class EmailAccountView {
  @ApiProperty({ description: 'In the sandbox, as SES has one: mail goes only to the addresses the account proved, until an operator lets it out' })
  sandbox: boolean;

  @ApiProperty()
  sendingEnabled: boolean;

  @ApiProperty({ enum: ['HEALTHY', 'PROBATION', 'SHUTDOWN'], description: "As SES's EnforcementStatus: reviewed past its bounce or complaint rate, then stopped" })
  enforcementStatus: 'HEALTHY' | 'PROBATION' | 'SHUTDOWN';

  @ApiProperty({ example: 200, description: "Messages a day, each recipient one, the plan's: SES's Max24HourSend" })
  max24HourSend: number;

  @ApiProperty({ example: 1, description: "Messages a second, the plan's: SES's MaxSendRate" })
  maxSendRate: number;

  @ApiProperty({ example: 12, description: 'What it sent in the last 24 hours, each recipient one' })
  sentLast24Hours: number;
}

export class PutSuppressionDto {
  @ApiProperty({ enum: SuppressionReason, description: 'Why: a bounce or a complaint, as SES names them' })
  @IsIn(Object.values(SuppressionReason), { message: 'reason must be BOUNCE or COMPLAINT' })
  reason: SuppressionReason;
}

export class SuppressionQuery {
  @ApiPropertyOptional({ enum: SuppressionReason, description: 'Those put there for this reason alone' })
  @IsOptional()
  @IsIn(Object.values(SuppressionReason), { message: 'reason must be BOUNCE or COMPLAINT' })
  reason?: SuppressionReason;

  @ApiPropertyOptional({ example: 100, description: 'A page: 1 to 1,000, 100 by default' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;

  @ApiPropertyOptional({ description: "The page after the one whose `next` this is" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  next?: string;
}

/** An address on the account's suppression list. */
export class SuppressionView {
  @ApiProperty({ example: 'gone@example.tn' })
  address: string;

  @ApiProperty({ enum: SuppressionReason })
  reason: SuppressionReason;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'The message whose bounce or complaint put it there; null when the account did' })
  messageId: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: "What the receiving server answered, for a bounce" })
  feedback: string | null;

  @ApiProperty({ type: String, format: 'date-time', description: 'When it was put there last' })
  updatedAt: Date;
}

export class SuppressionPageView {
  @ApiProperty({ type: [SuppressionView], description: 'The latest put there first' })
  suppressions: SuppressionView[];

  @ApiPropertyOptional({ type: String, nullable: true, description: "The next page's token; null after the last" })
  next: string | null;
}

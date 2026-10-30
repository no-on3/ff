import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { EmailIdentityStatus, EmailIdentityType } from '../email/email-identity.entity';
import type { EnforcementStatus } from '../email/email-sending.entity';
import { AdminChange } from './admin.dto';

const ENFORCEMENT: EnforcementStatus[] = ['HEALTHY', 'PROBATION', 'SHUTDOWN'];

/** PUT /admin/accounts/:id/email: any of the three, with the reason. */
export class AdminEmailDto extends AdminChange {
  @ApiPropertyOptional({ description: 'Out of the sandbox: its mail may go to any address, within its quotas. False puts it back in' })
  @IsOptional()
  @IsBoolean()
  productionAccess?: boolean;

  @ApiPropertyOptional({ description: "Its sending's switch: off, the SES endpoint refuses its messages (SendingPausedException)" })
  @IsOptional()
  @IsBoolean()
  sendingEnabled?: boolean;

  @ApiPropertyOptional({ enum: ENFORCEMENT, description: 'As SES\'s EnforcementStatus: its rates raise it, and only an operator clears it, after a review' })
  @IsOptional()
  @IsIn(ENFORCEMENT, { message: 'enforcementStatus must be HEALTHY, PROBATION or SHUTDOWN' })
  enforcementStatus?: EnforcementStatus;
}

export class AdminEmailIdentityView {
  @ApiProperty({ example: 'shop.example.tn' }) identity: string;
  @ApiProperty({ enum: EmailIdentityType }) type: EmailIdentityType;
  @ApiProperty({ enum: EmailIdentityStatus }) status: EmailIdentityStatus;
}

/** An account's sending, as GetAccount says it, for FF's operators. */
export class AdminEmailView {
  @ApiProperty({ description: 'In the sandbox: its mail goes only to the addresses and domains it proved' }) sandbox: boolean;
  @ApiProperty() sendingEnabled: boolean;
  @ApiProperty({ enum: ENFORCEMENT }) enforcementStatus: EnforcementStatus;
  @ApiProperty({ example: 200, description: "The plan's messages a day, each recipient one" }) max24HourSend: number;
  @ApiProperty({ example: 1, description: "The plan's messages a second" }) maxSendRate: number;
  @ApiProperty({ example: 12, description: 'What it sent in the last 24 hours, each recipient one' }) sentLast24Hours: number;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Why it was last changed, by an operator or by its rates' }) reason: string | null;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) updatedAt: Date | null;
  @ApiProperty({ type: [AdminEmailIdentityView], description: 'The domains and addresses it sends from' }) identities: AdminEmailIdentityView[];
}

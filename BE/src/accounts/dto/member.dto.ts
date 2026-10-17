import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsIn, MaxLength } from 'class-validator';
import { Role } from '../../auth/principal';

export const ROLES: readonly Role[] = ['owner', 'developer', 'viewer'];

/** POST /members: invite someone, by e-mail, with a role (P-16). */
export class InviteMemberDto {
  @ApiProperty({ example: 'salma@example.tn', description: 'Whoever next calls the API with a login for this address joins' })
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({ enum: ROLES, description: 'owner: everything; developer: functions; viewer: reads' })
  @IsIn(ROLES)
  role: Role;
}

/** PATCH /members/:userId. */
export class ChangeRoleDto {
  @ApiProperty({ enum: ROLES })
  @IsIn(ROLES)
  role: Role;
}

export class MemberView {
  @ApiProperty() userId: string;
  @ApiProperty() email: string;
  @ApiProperty({ nullable: true, type: String }) name: string | null;
  @ApiProperty({ enum: ROLES }) role: Role;
  @ApiProperty() joinedAt: Date;
}

export class InvitationView {
  @ApiProperty() id: string;
  @ApiProperty({ description: 'Lowercase' }) email: string;
  @ApiProperty({ enum: ROLES }) role: Role;
  @ApiProperty({ description: 'The user who sent it' }) invitedBy: string;
  @ApiProperty() createdAt: Date;
  @ApiProperty({ description: 'Seven days after it was sent, or sent again' }) expiresAt: Date;
  @ApiProperty({ description: 'Past its expiry: invite again to renew it' }) expired: boolean;
}

/** GET /members: the account's members, and the invitations nobody has accepted yet. */
export class MembersView {
  @ApiProperty({ type: [MemberView] }) members: MemberView[];
  @ApiProperty({ type: [InvitationView] }) invitations: InvitationView[];
}

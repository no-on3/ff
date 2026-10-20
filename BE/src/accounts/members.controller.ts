import { BadRequestException, Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { Principal } from '../auth/principal';
import { RequireRole } from '../auth/route-rules';
import { ChangeRoleDto, InvitationView, InviteMemberDto, MemberView, MembersView } from './dto/member.dto';
import { User } from './entities/user.entity';
import { MembersService } from './members.service';

/** Members are users: development mode, which has none, can't manage them. */
function requireUser(user: User | undefined): User {
  if (!user) throw new BadRequestException('Development mode acts as FF_DEV_ACCOUNT_ID, without a user: log in to manage members');
  return user;
}

/**
 * The account's members and invitations (P-16, D4): owners only, with a
 * user's token. No route names a scope, so API keys can't call them.
 */
@ApiTags('members')
@Controller('members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  @RequireRole('owner')
  @ApiOperation({ summary: "The account's members, and the invitations not accepted yet" })
  @ApiResponse({ status: 200, type: MembersView })
  async list(@Principal() principal: Principal, @CurrentUser() user: User | undefined): Promise<MembersView> {
    requireUser(user);
    return this.members.list(principal.accountId);
  }

  @Post()
  @RequireRole('owner')
  @ApiOperation({ summary: 'Invite someone by e-mail: whoever next calls the API with a login for that address joins, within 7 days' })
  @ApiResponse({ status: 201, type: InvitationView })
  async invite(
    @Principal() principal: Principal,
    @CurrentUser() user: User | undefined,
    @Body() dto: InviteMemberDto,
  ): Promise<InvitationView> {
    return this.members.invite(principal.accountId, requireUser(user), dto);
  }

  @Delete('invitations/:id')
  @RequireRole('owner')
  @ApiOperation({ summary: 'Cancel an invitation nobody has accepted yet' })
  async cancelInvitation(
    @Principal() principal: Principal,
    @CurrentUser() user: User | undefined,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    requireUser(user);
    await this.members.cancelInvitation(principal.accountId, id);
  }

  @Patch(':userId')
  @RequireRole('owner')
  @ApiOperation({ summary: "Change a member's role; the last owner stays one" })
  @ApiResponse({ status: 200, type: MemberView })
  async changeRole(
    @Principal() principal: Principal,
    @CurrentUser() user: User | undefined,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ChangeRoleDto,
  ): Promise<MemberView> {
    requireUser(user);
    return this.members.changeRole(principal.accountId, userId, dto.role);
  }

  @Delete(':userId')
  @RequireRole('owner')
  @ApiOperation({ summary: 'Remove a member, whose API keys stop at once; the last owner stays' })
  async remove(
    @Principal() principal: Principal,
    @CurrentUser() user: User | undefined,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    requireUser(user);
    await this.members.remove(principal.accountId, userId);
  }
}

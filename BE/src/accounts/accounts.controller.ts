import { BadRequestException, Body, Controller, Get, Param, Patch, PipeTransform, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { ACCOUNT_ID, RequestWithPrincipal, resolvePrincipal } from '../auth/principal';
import { AccountsService } from './accounts.service';
import { AccountView, CreateAccountDto, MeView, UpdateAccountDto } from './dto/account.dto';
import { User } from './entities/user.entity';

/** An account ID in a path: 12 digits, else 400. */
class ParseAccountIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!ACCOUNT_ID.test(value)) throw new BadRequestException('The account ID must be 12 digits');
    return value;
  }
}

/** A user's own records: these routes need a logged-in user, not a chosen account. */
function requireUser(user: User | undefined): User {
  if (!user) throw new BadRequestException('Development mode acts as FF_DEV_ACCOUNT_ID, without a user: log in to manage accounts');
  return user;
}

@ApiTags('accounts')
@Controller()
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get('me')
  @ApiOperation({ summary: 'The logged-in user, and their accounts and roles' })
  @ApiResponse({ status: 200, type: MeView })
  async me(@CurrentUser() user: User | undefined, @Req() request: RequestWithPrincipal): Promise<MeView> {
    return user ? this.accounts.me(user) : this.accounts.developmentMe(resolvePrincipal(request));
  }

  @Post('accounts')
  @ApiOperation({ summary: 'Create an account: you become its owner, and it waits for approval during the beta' })
  @ApiResponse({ status: 201, type: AccountView })
  async create(@CurrentUser() user: User | undefined, @Body() dto: CreateAccountDto): Promise<AccountView> {
    return this.accounts.create(requireUser(user), dto);
  }

  @Get('accounts/:id')
  @ApiOperation({ summary: 'One of your accounts' })
  @ApiResponse({ status: 200, type: AccountView })
  async get(@CurrentUser() user: User | undefined, @Param('id', ParseAccountIdPipe) id: string): Promise<AccountView> {
    return this.accounts.get(requireUser(user), id);
  }

  @Patch('accounts/:id')
  @ApiOperation({ summary: "Rename an account, or set its tax ID: the owner's only" })
  @ApiResponse({ status: 200, type: AccountView })
  async update(
    @CurrentUser() user: User | undefined,
    @Param('id', ParseAccountIdPipe) id: string,
    @Body() dto: UpdateAccountDto,
  ): Promise<AccountView> {
    return this.accounts.update(requireUser(user), id, dto);
  }
}

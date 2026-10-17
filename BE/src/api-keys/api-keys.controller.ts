import { BadRequestException, Body, Controller, Delete, Get, Param, PipeTransform, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { User } from '../accounts/entities/user.entity';
import { CurrentUser } from '../auth/current-user.decorator';
import { Principal } from '../auth/principal';
import { RequireRole } from '../auth/route-rules';
import { ApiKeysService } from './api-keys.service';
import { ApiKeyView, CreateApiKeyDto, CreatedApiKey } from './dto/api-key.dto';

/** A key ID in a path: 12 lowercase hex characters, else 400. */
class ParseKeyIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!/^[0-9a-f]{12}$/.test(value)) throw new BadRequestException('The key ID must be 12 lowercase hex characters');
    return value;
  }
}

/** Keys belong to a user's account: development mode, which has no user, can't make them. */
function requireUser(user: User | undefined): User {
  if (!user) throw new BadRequestException('Development mode acts as FF_DEV_ACCOUNT_ID, without a user: log in to manage API keys');
  return user;
}

/** The account's API keys (D3): owners manage them (D4), with a token, never with a key. */
@ApiTags('api-keys')
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get()
  @RequireRole('owner')
  @ApiOperation({ summary: "The account's API keys, without their secrets" })
  @ApiResponse({ status: 200, type: [ApiKeyView] })
  async list(@Principal() principal: Principal, @CurrentUser() user: User | undefined): Promise<ApiKeyView[]> {
    requireUser(user);
    return this.keys.list(principal.accountId);
  }

  @Post()
  @RequireRole('owner')
  @ApiOperation({ summary: 'Create an API key: the answer is the only time the whole key is shown' })
  @ApiResponse({ status: 201, type: CreatedApiKey })
  async create(
    @Principal() principal: Principal,
    @CurrentUser() user: User | undefined,
    @Body() dto: CreateApiKeyDto,
  ): Promise<CreatedApiKey> {
    return this.keys.create(principal.accountId, requireUser(user).id, dto);
  }

  @Delete(':id')
  @RequireRole('owner')
  @ApiOperation({ summary: 'Revoke an API key: it stops working at once' })
  @ApiResponse({ status: 200, type: ApiKeyView })
  async revoke(
    @Principal() principal: Principal,
    @CurrentUser() user: User | undefined,
    @Param('id', ParseKeyIdPipe) id: string,
  ): Promise<ApiKeyView> {
    requireUser(user);
    return this.keys.revoke(principal.accountId, id);
  }
}

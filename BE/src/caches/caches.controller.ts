import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '../auth/principal';
import { RequireActiveAccount, RequireRole, RequireScope, WRITERS } from '../auth/route-rules';
import { CachesService } from './caches.service';
import { CacheView, CacheWithPassword, CreateCacheDto } from './dto/cache.dto';

/**
 * Customers' caches (ADR 0013), as AWS ElastiCache for Valkey gives one:
 * every member sees them; owners and developers make them, change their
 * passwords and delete them. Deleting needs no active account: a suspended
 * account may still delete its data.
 */
@ApiTags('caches')
@Controller('caches')
export class CachesController {
  constructor(private readonly caches: CachesService) {}

  @Get()
  @RequireScope('caches:read')
  @ApiOperation({ summary: "The account's caches, with their memory used and connections now" })
  @ApiResponse({ status: 200, type: [CacheView] })
  list(@Principal() principal: Principal): Promise<CacheView[]> {
    return this.caches.list(principal.accountId);
  }

  @Post()
  @RequireScope('caches:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({
    summary: 'Make a cache, a Valkey of its own',
    description:
      "Valkey, which speaks Redis OSS's protocol, as AWS ElastiCache for Valkey runs it, on FF's server of customers' caches: a process of its own at a port of its own, " +
      "the plan's memory, the least recently used keys evicted past it, nothing kept on disk, TLS only. The answer holds the password and the address, this once: FF keeps no copy. " +
      "Functions reach the server whatever their account's internet access.",
  })
  @ApiResponse({ status: 201, type: CacheWithPassword })
  @ApiResponse({ status: 400, description: 'The name was refused, or the plan allows no more caches' })
  @ApiResponse({ status: 409, description: 'The account has a cache of that name' })
  @ApiResponse({ status: 503, description: "FF has no server for customers' caches, or it couldn't make it: nothing was made" })
  create(@Body() dto: CreateCacheDto, @Principal() principal: Principal): Promise<CacheWithPassword> {
    return this.caches.create(principal.accountId, dto);
  }

  @Get(':name')
  @RequireScope('caches:read')
  @ApiOperation({ summary: 'A cache: how to reach it, its memory used and connections now' })
  @ApiResponse({ status: 200, type: CacheView })
  @ApiResponse({ status: 404, description: 'No such cache in the account' })
  get(@Param('name') name: string, @Principal() principal: Principal): Promise<CacheView> {
    return this.caches.get(principal.accountId, name);
  }

  @Post(':name/password')
  @HttpCode(200)
  @RequireScope('caches:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({
    summary: 'Give the cache a new password',
    description: 'The old one stops working for new connections at once; those under way keep going. The new one is in this answer only.',
  })
  @ApiResponse({ status: 200, type: CacheWithPassword })
  @ApiResponse({ status: 404, description: 'No such cache in the account' })
  resetPassword(@Param('name') name: string, @Principal() principal: Principal): Promise<CacheWithPassword> {
    return this.caches.resetPassword(principal.accountId, name);
  }

  @Delete(':name')
  @HttpCode(204)
  @RequireScope('caches:write')
  @RequireRole(...WRITERS)
  @ApiOperation({ summary: 'Delete a cache, with its keys', description: 'Its connections end; its keys are gone, as a deleted ElastiCache cluster\'s are.' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, description: 'No such cache in the account' })
  async remove(@Param('name') name: string, @Principal() principal: Principal): Promise<void> {
    await this.caches.remove(principal.accountId, name);
  }
}

import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '../auth/principal';
import { RequireActiveAccount, RequireRole, RequireScope, WRITERS } from '../auth/route-rules';
import { DatabasesService } from './databases.service';
import { CreateDatabaseDto, DatabaseView, DatabaseWithPassword } from './dto/database.dto';

/**
 * Customers' PostgreSQL databases (ADR 0008), as AWS RDS gives one: every
 * member sees them; owners and developers make them, change their passwords
 * and delete them. Deleting needs no active account: a suspended account may
 * still delete its data.
 */
@ApiTags('databases')
@Controller('databases')
export class DatabasesController {
  constructor(private readonly databases: DatabasesService) {}

  @Get()
  @RequireScope('databases:read')
  @ApiOperation({ summary: "The account's databases, with their size and sessions now" })
  @ApiResponse({ status: 200, type: [DatabaseView] })
  list(@Principal() principal: Principal): Promise<DatabaseView[]> {
    return this.databases.list(principal.accountId);
  }

  @Post()
  @RequireScope('databases:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({
    summary: 'Make a PostgreSQL database, and its user',
    description:
      'PostgreSQL 18, as AWS RDS runs it, on FF\'s server of customers\' databases: a database and its owner, both with an opaque name, ' +
      "the plan's connection limit, TLS only. The answer holds the password and the connection string, this once: FF keeps no copy. " +
      "Functions reach the server whatever their account's internet access.",
  })
  @ApiResponse({ status: 201, type: DatabaseWithPassword })
  @ApiResponse({ status: 400, description: 'The name was refused, or the plan allows no more databases' })
  @ApiResponse({ status: 409, description: 'The account has a database of that name' })
  @ApiResponse({ status: 503, description: "FF has no server for customers' databases, or it couldn't make it: nothing was made" })
  create(@Body() dto: CreateDatabaseDto, @Principal() principal: Principal): Promise<DatabaseWithPassword> {
    return this.databases.create(principal.accountId, dto);
  }

  @Get(':id')
  @RequireScope('databases:read')
  @ApiOperation({ summary: 'A database: how to reach it, its size and sessions now, its limits' })
  @ApiResponse({ status: 200, type: DatabaseView })
  @ApiResponse({ status: 404, description: 'No such database in the account' })
  get(@Param('id', ParseUUIDPipe) id: string, @Principal() principal: Principal): Promise<DatabaseView> {
    return this.databases.get(principal.accountId, id);
  }

  @Post(':id/password')
  @HttpCode(200)
  @RequireScope('databases:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({
    summary: 'Give the database a new password',
    description: 'The old one stops working for new sessions; sessions under way keep theirs. The answer holds the new password and connection string, this once.',
  })
  @ApiResponse({ status: 200, type: DatabaseWithPassword })
  resetPassword(@Param('id', ParseUUIDPipe) id: string, @Principal() principal: Principal): Promise<DatabaseWithPassword> {
    return this.databases.resetPassword(principal.accountId, id);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireScope('databases:write')
  @RequireRole(...WRITERS)
  @ApiOperation({ summary: 'Delete the database, with its data', description: 'Its sessions end, and the database and its user are dropped. Nothing can bring it back.' })
  @ApiResponse({ status: 204 })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Principal() principal: Principal): Promise<void> {
    await this.databases.remove(principal.accountId, id);
  }
}

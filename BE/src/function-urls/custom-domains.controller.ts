import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '../auth/principal';
import { RequireActiveAccount, RequireRole, RequireScope, WRITERS } from '../auth/route-rules';
import { CustomDomainsService } from './custom-domains.service';
import { AddCustomDomainDto, CustomDomainView } from './dto/custom-domain.dto';

/**
 * A function URL's own domains: every member reads them; owners and developers
 * add, verify and remove them, as they change the URL. Removing needs no active
 * account, as deleting the URL doesn't.
 */
@ApiTags('functions')
@Controller('functions/:id/url/domains')
export class CustomDomainsController {
  constructor(private readonly domains: CustomDomainsService) {}

  @Get()
  @RequireScope('functions:read')
  @ApiOperation({ summary: "The URL's own domains, each with the DNS records that prove it and where it stands" })
  @ApiResponse({ status: 200, type: [CustomDomainView] })
  list(@Param('id', ParseUUIDPipe) id: string, @Principal() principal: Principal): Promise<CustomDomainView[]> {
    return this.domains.list(principal.accountId, id);
  }

  @Post()
  @RequireScope('functions:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({
    summary: 'Add a domain of yours to the URL',
    description:
      'Its records are checked at once, and the answer says which to make if they are not there: a CNAME to the URL\'s host, or, for a domain ' +
      'apex, which can\'t be one, a TXT record with the token and the edge\'s addresses. Once proved, the URL answers there too, over HTTPS, with a ' +
      'certificate the edge gets at the first request. The plan limits how many domains an account has.',
  })
  @ApiResponse({ status: 201, type: CustomDomainView })
  @ApiResponse({ status: 400, description: 'A name that is no domain, or the plan\'s limit reached' })
  @ApiResponse({ status: 409, description: 'The account has the domain already' })
  add(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddCustomDomainDto, @Principal() principal: Principal): Promise<CustomDomainView> {
    return this.domains.add(principal.accountId, id, dto.domain);
  }

  @Post(':domain/verify')
  @HttpCode(200)
  @RequireScope('functions:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({
    summary: "Check the domain's records again",
    description: 'Proved, it is verified, and served; not, it is pending, with why, a verified one too, whose URL then stops answering there.',
  })
  @ApiResponse({ status: 200, type: CustomDomainView })
  @ApiResponse({ status: 409, description: 'Another account proved the domain first' })
  verify(@Param('id', ParseUUIDPipe) id: string, @Param('domain') domain: string, @Principal() principal: Principal): Promise<CustomDomainView> {
    return this.domains.verify(principal.accountId, id, domain);
  }

  @Delete(':domain')
  @HttpCode(204)
  @RequireScope('functions:write')
  @RequireRole(...WRITERS)
  @ApiOperation({ summary: 'Remove the domain: the URL stops answering there at once' })
  @ApiResponse({ status: 204 })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Param('domain') domain: string, @Principal() principal: Principal): Promise<void> {
    await this.domains.remove(principal.accountId, id, domain);
  }
}

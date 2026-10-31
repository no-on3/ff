import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '../auth/principal';
import { RequireActiveAccount, RequireRole, RequireScope, WRITERS } from '../auth/route-rules';
import { CustomDomainsService } from './custom-domains.service';
import { AddCustomDomainDto, SiteDomainView } from './dto/custom-domain.dto';

/**
 * A bucket's site's own domains, proved as a function URL's are: every member
 * reads them; owners and developers add, verify and remove them, as they set
 * the site. Removing needs no active account, as deleting the bucket doesn't.
 */
@ApiTags('buckets')
@Controller('buckets/:name/website/domains')
export class SiteDomainsController {
  constructor(private readonly domains: CustomDomainsService) {}

  @Get()
  @RequireScope('storage:read')
  @ApiOperation({
    summary: "The site's own domains, each with the DNS records that prove it and where it stands",
    description: 'A bucket no longer a site keeps its domains, to read and remove: none is served until it is a site again.',
  })
  @ApiResponse({ status: 200, type: [SiteDomainView] })
  @ApiResponse({ status: 404, description: 'No such bucket in the account' })
  list(@Param('name') name: string, @Principal() principal: Principal): Promise<SiteDomainView[]> {
    return this.domains.listForSite(principal.accountId, name);
  }

  @Post()
  @RequireScope('storage:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({
    summary: 'Add a domain of yours to the site',
    description:
      "Its records are checked at once, and the answer says which to make if they are not there: a CNAME to the site's host, or, for a domain apex, which can't be one, " +
      "a TXT record with the token and the edge's addresses. Once proved, the site answers there too, over HTTPS, with a certificate the edge gets at the first request. " +
      "The plan's custom domains count those of function URLs and sites together.",
  })
  @ApiResponse({ status: 201, type: SiteDomainView })
  @ApiResponse({ status: 400, description: "A name that is no domain, or the plan's limit reached" })
  @ApiResponse({ status: 404, description: 'No such bucket in the account, or it is no site' })
  @ApiResponse({ status: 409, description: 'The account has the domain already' })
  add(@Param('name') name: string, @Body() dto: AddCustomDomainDto, @Principal() principal: Principal): Promise<SiteDomainView> {
    return this.domains.addToSite(principal.accountId, name, dto.domain);
  }

  @Post(':domain/verify')
  @HttpCode(200)
  @RequireScope('storage:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({
    summary: "Check the domain's records again",
    description: 'Proved, it is verified, and the site answers there; not, it is pending, with why, a verified one too, where the site then stops answering.',
  })
  @ApiResponse({ status: 200, type: SiteDomainView })
  @ApiResponse({ status: 409, description: 'Another account proved the domain first' })
  verify(@Param('name') name: string, @Param('domain') domain: string, @Principal() principal: Principal): Promise<SiteDomainView> {
    return this.domains.verifyForSite(principal.accountId, name, domain);
  }

  @Delete(':domain')
  @HttpCode(204)
  @RequireScope('storage:write')
  @RequireRole(...WRITERS)
  @ApiOperation({ summary: 'Remove the domain: the site stops answering there at once' })
  @ApiResponse({ status: 204 })
  async remove(@Param('name') name: string, @Param('domain') domain: string, @Principal() principal: Principal): Promise<void> {
    await this.domains.removeFromSite(principal.accountId, name, domain);
  }
}

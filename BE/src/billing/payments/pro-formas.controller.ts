import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '../../auth/principal';
import { RequireRole, RequireScope } from '../../auth/route-rules';
import { ProFormaView, ProFormasPage, RequestProFormaDto } from './payments.dto';
import { PaymentsService } from './payments.service';

/**
 * Pro-formas for bank transfers (client-readiness plan, P-35, D9): an owner
 * asks for one, with a user's token, whatever the account's status, since a
 * suspended or closed account may still owe usage; every member reads them,
 * and an API key with usage:read, as for the account's other money.
 */
@ApiTags('billing')
@Controller('billing/pro-formas')
export class ProFormasController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  @RequireRole('owner')
  @ApiOperation({
    summary: 'A pro-forma for prepaid credit: the credit, the VAT on top, FF\'s bank account, and the reference for the transfer',
    description: 'FF adds the credit once the transfer is in, less any share withheld at source, which comes with the withholding certificate.',
  })
  @ApiResponse({ status: 201, type: ProFormaView })
  request(@Principal() principal: Principal, @Body() body: RequestProFormaDto): Promise<ProFormaView> {
    return this.payments.requestProForma(principal.accountId, body.credit);
  }

  @Get()
  @RequireScope('usage:read')
  @ApiOperation({ summary: "The account's pro-formas, newest first, each with its transfer once FF recorded it" })
  @ApiResponse({ status: 200, type: ProFormasPage })
  async list(@Principal() principal: Principal): Promise<ProFormasPage> {
    return { proFormas: await this.payments.proFormas(principal.accountId) };
  }

  @Get(':id')
  @RequireScope('usage:read')
  @ApiOperation({ summary: 'One of the account\'s pro-formas' })
  @ApiResponse({ status: 200, type: ProFormaView })
  get(@Principal() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<ProFormaView> {
    return this.payments.proForma(principal.accountId, id);
  }
}

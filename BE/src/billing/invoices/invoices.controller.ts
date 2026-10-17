import { Controller, Get, Param, ParseUUIDPipe, Res } from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Principal } from '../../auth/principal';
import { RequireScope } from '../../auth/route-rules';
import { InvoicesPage } from './invoices.dto';
import { InvoicesService } from './invoices.service';

/** A PDF as a download, named for the file a person keeps. */
export function sendPdf(response: Response, body: Buffer, filename: string): void {
  response.setHeader('content-type', 'application/pdf');
  response.setHeader('content-disposition', `attachment; filename="${filename}"`);
  response.send(body);
}

/**
 * The account's invoices and usage statements (client-readiness plan, P-36,
 * D9): every member reads them, and an API key with usage:read, as for the
 * account's other money.
 */
@ApiTags('billing')
@Controller('billing')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get('invoices')
  @RequireScope('usage:read')
  @ApiOperation({ summary: "The account's issued invoices and credit notes, newest first" })
  @ApiResponse({ status: 200, type: InvoicesPage })
  async list(@Principal() principal: Principal): Promise<InvoicesPage> {
    return { invoices: await this.invoices.forAccount(principal.accountId) };
  }

  @Get('invoices/:id/pdf')
  @RequireScope('usage:read')
  @ApiProduces('application/pdf')
  @ApiOperation({ summary: 'An invoice or credit note, as its PDF was issued, in French; an invoice has its usage statement attached' })
  @ApiResponse({ status: 200 })
  async pdf(@Principal() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Res() response: Response): Promise<void> {
    const { body, number } = await this.invoices.pdf(id, principal.accountId);
    sendPdf(response, body, `${number}.pdf`);
  }

  @Get('statements/:month/pdf')
  @RequireScope('usage:read')
  @ApiProduces('application/pdf')
  @ApiOperation({ summary: "The account's usage statement for a month (YYYY-MM, UTC), as rated so far, in French" })
  @ApiResponse({ status: 200 })
  async statement(@Principal() principal: Principal, @Param('month') month: string, @Res() response: Response): Promise<void> {
    sendPdf(response, await this.invoices.statementPdf(principal.accountId, month), `releve-${month}.pdf`);
  }
}

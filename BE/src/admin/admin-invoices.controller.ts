import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { sendPdf } from '../billing/invoices/invoices.controller';
import { AdminInvoicesPage, AdminInvoicesQuery, AdminInvoiceView, CreditNoteDto, DraftsPage, DraftsQuery, IssueInvoicesDto, IssueResult } from '../billing/invoices/invoices.dto';
import { InvoicesService } from '../billing/invoices/invoices.service';
import { AdminRoutes } from './operator';

/**
 * Invoices, for FF's operators (P-36, P-74, D9): a month's drafts to review,
 * issued all at once or account by account, every issued document, and the
 * credit note that corrects an invoice.
 */
@ApiTags('admin')
@AdminRoutes()
@Controller('admin/invoices')
export class AdminInvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get('drafts')
  @ApiOperation({ summary: "A month's invoices still to issue, each with its payments and totals (operators only)" })
  @ApiResponse({ status: 200, type: DraftsPage })
  drafts(@Query() query: DraftsQuery): Promise<DraftsPage> {
    return this.invoices.drafts(query.month ?? InvoicesService.lastMonth());
  }

  @Post('issue')
  @HttpCode(200)
  @ApiOperation({
    summary: "Issues a month's invoices: every draft, or the accounts named (operators only)",
    description: 'One after the other, each numbered, its stamp duty taken from the credit, its PDF written, its owners told; one that fails is named and the rest go on.',
  })
  @ApiResponse({ status: 200, type: IssueResult })
  issue(@Body() body: IssueInvoicesDto): Promise<IssueResult> {
    return this.invoices.issueAll(body.month, body.accountIds, body.reason);
  }

  @Get()
  @ApiOperation({ summary: "Every account's issued invoices and credit notes, newest first, a page at a time (operators only)" })
  @ApiResponse({ status: 200, type: AdminInvoicesPage })
  list(@Query() query: AdminInvoicesQuery): Promise<AdminInvoicesPage> {
    return this.invoices.forOperators({ accountId: query.accountId, kind: query.kind, month: query.month }, { limit: query.limit ?? 50, before: query.before });
  }

  @Get(':id/pdf')
  @ApiProduces('application/pdf')
  @ApiOperation({ summary: 'An issued invoice or credit note, as its PDF was issued (operators only)' })
  @ApiResponse({ status: 200 })
  async pdf(@Param('id', ParseUUIDPipe) id: string, @Res() response: Response): Promise<void> {
    const { body, number } = await this.invoices.pdf(id, null);
    sendPdf(response, body, `${number}.pdf`);
  }

  @Post(':id/credit-notes')
  @ApiOperation({ summary: 'Issues a credit note against an invoice: what it gives back, before tax, line by line (operators only)' })
  @ApiResponse({ status: 201, type: AdminInvoiceView })
  creditNote(@Param('id', ParseUUIDPipe) id: string, @Body() body: CreditNoteDto): Promise<AdminInvoiceView> {
    return this.invoices.creditNote(id, body.lines, body.reason);
  }
}

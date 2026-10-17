import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ApiConsumes, ApiHeader, ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { raw } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { AdminPaymentView, AdminPaymentsPage, AdminPaymentsQuery, RecordTransferDto } from '../billing/payments/payments.dto';
import { CERTIFICATE_LIMIT, CERTIFICATE_TYPES, PaymentsService } from '../billing/payments/payments.service';
import { AdminRoutes, REASON_HEADER, reasonOf } from './operator';

/** A withholding certificate's body, a PDF or an image, read as is: before the guard, which then finds its reason in a header. */
export const certificateBody = (): RequestHandler => raw({ type: CERTIFICATE_TYPES, limit: CERTIFICATE_LIMIT });

/**
 * Payments, for FF's operators (P-35, P-74): every pro-forma and its transfer,
 * the transfer recorded from the bank statement, and the withholding
 * certificate that credits the share withheld at source.
 */
@ApiTags('admin')
@AdminRoutes()
@Controller('admin')
export class AdminPaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('payments')
  @ApiOperation({ summary: 'Every account\'s payments, newest first, a page at a time (operators only)' })
  @ApiResponse({ status: 200, type: AdminPaymentsPage })
  list(@Query() query: AdminPaymentsQuery): Promise<AdminPaymentsPage> {
    return this.payments.forOperators({ status: query.status, accountId: query.accountId, reference: query.reference }, { limit: query.limit ?? 50, before: query.before });
  }

  @Post('bank-transfers')
  @ApiOperation({
    summary: 'Records a transfer against its pro-forma\'s reference, with any share withheld at source (operators only)',
    description: 'What arrived and what was withheld must make the total. The wallet gets the credit less the withheld share; the owners get an e-mail.',
  })
  @ApiResponse({ status: 201, type: AdminPaymentView })
  record(@Body() body: RecordTransferDto): Promise<AdminPaymentView> {
    return this.payments.recordTransfer(body, body.reason);
  }

  @Put('payments/:id/withholding-certificate')
  @ApiConsumes(...CERTIFICATE_TYPES)
  @ApiHeader({ name: REASON_HEADER, required: true, description: 'The reason, URI-encoded: the body is the file' })
  @ApiOperation({ summary: 'Adds the withholding certificate, which credits the share withheld at source (operators only)' })
  @ApiResponse({ status: 200, type: AdminPaymentView })
  addCertificate(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request, @Headers('content-type') contentType: string | undefined): Promise<AdminPaymentView> {
    const type = (contentType ?? '').split(';')[0].trim();
    return this.payments.attachCertificate(id, request.body as Buffer, type, reasonOf(request) as string);
  }

  @Get('payments/:id/withholding-certificate')
  @ApiProduces(...CERTIFICATE_TYPES)
  @ApiOperation({ summary: 'The withholding certificate, as it was added (operators only)' })
  @ApiResponse({ status: 200 })
  async certificate(@Param('id', ParseUUIDPipe) id: string, @Res() response: Response): Promise<void> {
    const { body, contentType, reference } = await this.payments.certificate(id);
    const extension = contentType === 'application/pdf' ? 'pdf' : contentType === 'image/png' ? 'png' : 'jpg';
    response.setHeader('content-type', contentType);
    response.setHeader('content-disposition', `attachment; filename="withholding-${reference}.${extension}"`);
    response.send(body);
  }
}

import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminChange } from './admin.dto';
import { CreatePriceBookDto, PreviewPriceBookDto, PriceBookPreviewView, PriceBookView } from './admin-prices.dto';
import { AdminPricesService } from './admin-prices.service';
import { AdminRoutes, ChangesNothing, CurrentOperator, Operator } from './operator';

/** FF's price books (P-73, D8): each version, from its start; one that has started never changes. */
@ApiTags('admin')
@AdminRoutes()
@Controller('admin/price-books')
export class AdminPricesController {
  constructor(private readonly prices: AdminPricesService) {}

  @Get()
  @ApiOperation({ summary: 'Every price book, oldest first: past, active and scheduled (operators only)' })
  @ApiResponse({ status: 200, type: [PriceBookView] })
  list(): Promise<PriceBookView[]> {
    return this.prices.list();
  }

  @Post()
  @ApiOperation({ summary: 'A new price book, from a whole hour in the future (operators only)' })
  @ApiResponse({ status: 201, type: PriceBookView })
  create(@CurrentOperator() operator: Operator, @Body() body: CreatePriceBookDto): Promise<PriceBookView> {
    return this.prices.create(new Date(body.validFrom), body.document, operator, body.reason);
  }

  @Post('preview')
  @HttpCode(200)
  @ChangesNothing()
  @ApiOperation({ summary: "Last month priced with a draft book, per account, next to the books valid then; nothing is saved (operators only)" })
  @ApiResponse({ status: 200, type: PriceBookPreviewView })
  preview(@Body() body: PreviewPriceBookDto): Promise<PriceBookPreviewView> {
    return this.prices.preview(body.document);
  }

  @Delete(':id')
  @ApiOperation({ summary: "Removes a price book that hasn't started (operators only)" })
  @ApiResponse({ status: 200 })
  async remove(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: AdminChange): Promise<void> {
    await this.prices.remove(id, body.reason);
  }
}

import { Controller, Get, HttpStatus, PayloadTooLargeException, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Principal } from '../auth/principal';
import { RequireActiveAccount, RequireRole, RequireScope, WRITERS } from '../auth/route-rules';
import { ListPackagesQuery } from './dto/list-packages.dto';
import { PackageView, PackagesService } from './packages.service';

/** The Content-Length the client gave, if any. */
function contentLength(request: Request): number | undefined {
  const length = Number(request.headers['content-length']);
  return request.headers['content-length'] !== undefined && Number.isFinite(length) ? length : undefined;
}

/**
 * Functions' packages, for the caller's account (D4): a zip uploaded once, then
 * named by its SHA-256. Uploading is a change, as a create is: writers only, an
 * approved account, a key with functions:write. Every member reads the list.
 */
@ApiTags('packages')
@Controller('packages')
export class PackagesController {
  constructor(private readonly packages: PackagesService) {}

  @Post()
  @RequireScope('functions:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({
    summary: "Upload a function's package",
    description:
      'The body is a zip, as AWS Lambda takes one (Content-Type: application/zip): the handler\'s file and its libraries, 50 MB at most, ' +
      '250 MB and 20,000 files unpacked. Every name must stay in the package; links, encrypted files and other methods than deflate are ' +
      'refused, and every byte is checked against its size and checksum. The answer names it by its SHA-256 in base64, as Lambda\'s ' +
      'CodeSha256: the account has each package once, and one that no function names is deleted after an hour.',
  })
  @ApiConsumes('application/zip')
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @ApiResponse({ status: 201, description: 'The package, new to the account' })
  @ApiResponse({ status: 200, description: 'The package, which the account had already: nothing was stored again' })
  @ApiResponse({ status: 400, description: 'The package is refused, saying why; or the account keeps 20 packages that no function names' })
  @ApiResponse({ status: 413, description: 'The body is over 50 MB (52,428,800 bytes)' })
  @ApiResponse({ status: 415, description: 'The body was not sent as application/zip' })
  async upload(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Principal() principal: Principal): Promise<PackageView> {
    try {
      const { created, package: uploaded } = await this.packages.upload(principal.accountId, request, request.headers['content-type'], contentLength(request));
      response.status(created ? HttpStatus.CREATED : HttpStatus.OK);
      return uploaded;
    } catch (error) {
      // The rest of a body too large isn't read: the connection closes after the answer.
      if (error instanceof PayloadTooLargeException) response.setHeader('Connection', 'close');
      throw error;
    }
  }

  @Get()
  @RequireScope('functions:read')
  @ApiOperation({ summary: "List the account's packages, newest first; with codeSha256, the one of that SHA-256" })
  @ApiResponse({ status: 200, description: 'Each package: its SHA-256, its sizes, its number of files, when it was uploaded' })
  async list(@Query() query: ListPackagesQuery, @Principal() principal: Principal): Promise<PackageView[]> {
    return this.packages.list(principal.accountId, query.codeSha256);
  }
}

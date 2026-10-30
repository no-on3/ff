import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '../auth/principal';
import { RequireActiveAccount, RequireRole, RequireScope, WRITERS } from '../auth/route-rules';
import {
  CreateEmailIdentityDto,
  EmailAccountView,
  EmailIdentityView,
  EmailMessageListView,
  EmailMessageQuery,
  EmailMessageView,
  PutSuppressionDto,
  SendEmailDto,
  SentEmailView,
  SuppressionPageView,
  SuppressionQuery,
  SuppressionView,
} from './dto/email.dto';
import { EmailAccountService } from './email-account.service';
import { EmailIdentitiesService, IdentityRefusal } from './email-identities.service';
import { EmailIdentity, EmailIdentityStatus, EmailIdentityType } from './email-identity.entity';
import { EmailMessage } from './email-message.entity';
import { EmailMessagesService, SendRefusal, SendRefusalKind } from './email-messages.service';
import { addressProblem, identityKey } from './email-names';
import { EmailSuppression } from './email-suppression.entity';
import { EmailSuppressionsService } from './email-suppressions.service';
import { mailFromDomain } from './mail-domain';

/**
 * Customers' mail (ADR 0012) in FF's API, beside the SES endpoint: the
 * domains and addresses the account sends from, with the records a domain
 * publishes; its quotas and its sandbox; its suppression list; the messages
 * it sent, and one to send, as SendEmail takes it. Every member reads them;
 * owners and developers of an active account add, prove and change them, and
 * send, and delete them, a suspended account too.
 */
/** A refusal of a message's, as FF's API answers it. */
const REFUSALS: Record<SendRefusalKind, (message: string) => HttpException> = {
  invalid: (message) => new BadRequestException(message),
  rejected: (message) => new BadRequestException(message),
  paused: (message) => new ForbiddenException(message),
  suspended: (message) => new ForbiddenException(message),
  daily: (message) => new HttpException(message, HttpStatus.TOO_MANY_REQUESTS),
  rate: (message) => new HttpException(message, HttpStatus.TOO_MANY_REQUESTS),
  unavailable: (message) => new ServiceUnavailableException(message),
};

@ApiTags('email')
@Controller('email')
export class EmailController {
  constructor(
    private readonly identities: EmailIdentitiesService,
    private readonly suppressions: EmailSuppressionsService,
    private readonly account: EmailAccountService,
    private readonly messages: EmailMessagesService,
  ) {}

  @Get('identities')
  @RequireScope('email:read')
  @ApiOperation({ summary: 'The domains and addresses the account sends mail from, as SES v2 lists its identities' })
  @ApiResponse({ status: 200, type: [EmailIdentityView] })
  async list(@Principal() principal: Principal): Promise<EmailIdentityView[]> {
    return (await this.identities.list(principal.accountId)).map((row) => this.view(row));
  }

  @Post('identities')
  @RequireScope('email:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({
    summary: 'Add a domain or an address to send mail from',
    description:
      'A domain gets a DKIM key of its own, FF\'s, as SES\'s "bring your own DKIM" takes one: the answer gives the records to publish, its DKIM key\'s, which proves it, ' +
      "and its return path's, which brings its bounces back. FF looks them up every minute for 72 hours. An address gets a link, e-mailed to it, whose following proves it: " +
      'in the sandbox, mail goes only to the addresses the account proved.',
  })
  @ApiResponse({ status: 201, type: EmailIdentityView })
  @ApiResponse({ status: 400, description: 'Neither a domain nor an address, or the plan allows no more domains' })
  @ApiResponse({ status: 409, description: 'The account has that identity already' })
  async create(@Body() dto: CreateEmailIdentityDto, @Principal() principal: Principal): Promise<EmailIdentityView> {
    try {
      return this.view(await this.identities.create({ accountId: principal.accountId }, dto.identity));
    } catch (error) {
      if (!(error instanceof IdentityRefusal)) throw error;
      throw error.kind === 'exists' ? new ConflictException(error.message) : new BadRequestException(error.message);
    }
  }

  @Get('identities/:identity')
  @RequireScope('email:read')
  @ApiOperation({ summary: 'A domain or an address, with the records a domain publishes and where its proof is' })
  @ApiResponse({ status: 200, type: EmailIdentityView })
  @ApiResponse({ status: 404, description: 'No such identity in the account' })
  async get(@Param('identity') identity: string, @Principal() principal: Principal): Promise<EmailIdentityView> {
    return this.view(await this.identityOf(principal.accountId, identity));
  }

  @Post('identities/:identity/verify')
  @HttpCode(200)
  @RequireScope('email:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({ summary: "A domain's records looked up now; for an address, its link e-mailed again, the last one no longer good" })
  @ApiResponse({ status: 200, type: EmailIdentityView })
  @ApiResponse({ status: 404, description: 'No such identity in the account' })
  async verify(@Param('identity') identity: string, @Principal() principal: Principal): Promise<EmailIdentityView> {
    return this.view(await this.identities.checkNow({ accountId: principal.accountId }, await this.identityOf(principal.accountId, identity)));
  }

  @Delete('identities/:identity')
  @HttpCode(204)
  @RequireScope('email:write')
  @RequireRole(...WRITERS)
  @ApiOperation({ summary: 'Delete a domain or an address, with its DKIM key: mail goes from it no more' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, description: 'No such identity in the account' })
  async remove(@Param('identity') identity: string, @Principal() principal: Principal): Promise<void> {
    if (!(await this.identities.remove({ accountId: principal.accountId }, identity))) throw new NotFoundException(`The account has no identity ${identityKey(identity)}`);
  }

  @Get('account')
  @RequireScope('email:read')
  @ApiOperation({ summary: "The account's sending, as SES v2's GetAccount says it: its quotas, the plan's, and whether it is in the sandbox" })
  @ApiResponse({ status: 200, type: EmailAccountView })
  accountView(@Principal() principal: Principal): Promise<EmailAccountView> {
    return this.account.state(principal.accountId);
  }

  @Get('suppressions')
  @RequireScope('email:read')
  @ApiOperation({ summary: "The account's suppression list, the latest put there first: no mail of the account goes to these addresses" })
  @ApiResponse({ status: 200, type: SuppressionPageView })
  @ApiResponse({ status: 400, description: 'A next that is no page of the list' })
  async listSuppressions(@Query() query: SuppressionQuery, @Principal() principal: Principal): Promise<SuppressionPageView> {
    const page = await this.suppressions.list(principal.accountId, { reasons: query.reason ? [query.reason] : [], pageSize: query.limit ?? 100, next: query.next });
    if (!page) throw new BadRequestException('next is no page of the list');
    return { suppressions: page.suppressions.map((row) => this.suppressionView(row)), next: page.next };
  }

  @Put('suppressions/:address')
  @RequireScope('email:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({ summary: 'Put an address on the suppression list: no mail of the account goes to it while it is there' })
  @ApiResponse({ status: 200, type: SuppressionView })
  @ApiResponse({ status: 400, description: 'Not an address, or not a reason' })
  async putSuppression(@Param('address') address: string, @Body() dto: PutSuppressionDto, @Principal() principal: Principal): Promise<SuppressionView> {
    const problem = addressProblem(identityKey(address));
    if (problem) throw new BadRequestException(`${address} is not an address: ${problem}`);
    return this.suppressionView(await this.suppressions.put({ accountId: principal.accountId }, principal.accountId, address, dto.reason));
  }

  @Delete('suppressions/:address')
  @HttpCode(204)
  @RequireScope('email:write')
  @RequireRole(...WRITERS)
  @ApiOperation({ summary: "Take an address off the suppression list: the account's mail goes to it again" })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, description: 'The address is not on the list' })
  async removeSuppression(@Param('address') address: string, @Principal() principal: Principal): Promise<void> {
    if (!(await this.suppressions.remove({ accountId: principal.accountId }, address))) throw new NotFoundException(`${identityKey(address)} is not on the account's suppression list`);
  }

  @Get('messages')
  @RequireScope('email:read')
  @ApiOperation({ summary: "The account's latest messages, through the SES endpoint or FF's API, and what became of each recipient" })
  @ApiResponse({ status: 200, type: EmailMessageListView })
  async listMessages(@Query() query: EmailMessageQuery, @Principal() principal: Principal): Promise<EmailMessageListView> {
    return { messages: (await this.messages.latest(principal.accountId, query.limit ?? 50)).map((row) => this.messageView(row)) };
  }

  @Post('messages')
  @RequireScope('email:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({
    summary: 'Send a message, as SES v2\'s SendEmail sends a simple one: to try a domain or an address',
    description:
      'From an address the account proved, or one at a domain it proved, whose DKIM key signs it; in the sandbox, to the addresses and domains it proved alone. ' +
      "Each recipient counts against the plan's quotas, one on the suppression list too, which it never reaches. The message is queued, and the answer names it at once.",
  })
  @ApiResponse({ status: 201, type: SentEmailView })
  @ApiResponse({ status: 400, description: 'Not a message SES takes, or from or to an identity the account has not proved' })
  @ApiResponse({ status: 403, description: "The account's sending is paused or stopped" })
  @ApiResponse({ status: 429, description: "Past the plan's quota a day, or its rate a second" })
  @ApiResponse({ status: 503, description: "FF has no server of customers' mail here" })
  async send(@Body() dto: SendEmailDto, @Principal() principal: Principal): Promise<SentEmailView> {
    try {
      const messageId = await this.messages.send(principal.accountId, {
        from: dto.from,
        to: dto.to,
        cc: dto.cc ?? [],
        bcc: dto.bcc ?? [],
        replyTo: dto.replyTo ?? [],
        content: { simple: { subject: dto.subject, text: dto.text, html: dto.html, headers: [] } },
      });
      return { messageId };
    } catch (error) {
      if (!(error instanceof SendRefusal)) throw error;
      throw REFUSALS[error.kind](error.message);
    }
  }

  private async identityOf(accountId: string, name: string): Promise<EmailIdentity> {
    const found = await this.identities.find(accountId, name);
    if (!found) throw new NotFoundException(`The account has no identity ${identityKey(name)}`);
    return found;
  }

  private view(row: EmailIdentity): EmailIdentityView {
    const domain = row.type === EmailIdentityType.DOMAIN;
    return {
      identity: row.identity,
      type: row.type,
      status: row.status,
      sendingEnabled: row.status === EmailIdentityStatus.SUCCESS,
      dkimSelector: row.dkimSelector,
      mailFromDomain: domain ? mailFromDomain(row.identity) : null,
      mailFromVerified: row.mailFromVerified,
      records: this.identities.recordsOf(row),
      verifiedAt: row.verifiedAt,
      createdAt: row.createdAt,
    };
  }

  private messageView(row: EmailMessage): EmailMessageView {
    return {
      messageId: row.id,
      from: row.fromAddress,
      identity: row.identity,
      status: row.status,
      recipients: row.recipients.map((recipient) => ({ address: recipient.address, status: recipient.status, diagnostic: recipient.diagnostic ?? null })),
      sizeBytes: row.sizeBytes,
      createdAt: row.createdAt,
      sentAt: row.sentAt,
    };
  }

  private suppressionView(row: EmailSuppression): SuppressionView {
    return { address: row.address, reason: row.reason, messageId: row.messageId, feedback: row.feedback, updatedAt: row.updatedAt };
  }
}

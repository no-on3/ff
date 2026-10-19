import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { User } from '../accounts/entities/user.entity';
import { CurrentUser } from '../auth/current-user.decorator';
import { Principal } from '../auth/principal';
import { RequireActiveAccount, RequireRole, WRITERS } from '../auth/route-rules';
import { DeliveriesQuery, DeliveryViewDto, TestNotificationDto, TestNotificationView, WebhookSecretView } from './notifications.dto';
import { DeliveryView, NotificationsService } from './notifications.service';
import { WebhookSecret } from './entities/webhook-secret.entity';

const secretView = ({ secret, createdAt, previousExpiresAt }: WebhookSecret): WebhookSecretView => ({ secret, createdAt, previousExpiresAt });

/**
 * The account's notifications: the secret its webhooks are signed with, a
 * test, and how the latest deliveries went. For its members, with a login or
 * in development mode; never with an API key, as no route names a scope.
 */
@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('webhook-secret')
  @RequireRole('owner')
  @ApiOperation({ summary: "The secret the account's webhooks are signed with, made at its first need: the owners' only" })
  @ApiResponse({ status: 200, type: WebhookSecretView })
  async secret(@Principal() principal: Principal): Promise<WebhookSecretView> {
    return secretView(await this.notifications.secret(principal.accountId));
  }

  @Post('webhook-secret/rotate')
  @HttpCode(200)
  @RequireRole('owner')
  @RequireActiveAccount()
  @ApiOperation({ summary: 'A new signing secret; the previous one signs too for 24 hours, so that receivers can change over' })
  @ApiResponse({ status: 200, type: WebhookSecretView })
  async rotate(@Principal() principal: Principal): Promise<WebhookSecretView> {
    return secretView(await this.notifications.rotate(principal.accountId));
  }

  @Post('test')
  @HttpCode(202)
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({ summary: "A test notification to a webhook URL, the owners' e-mail, or both, sent as alarms' will be" })
  @ApiResponse({ status: 202, type: TestNotificationView })
  test(@Principal() principal: Principal, @CurrentUser() user: User | undefined, @Body() dto: TestNotificationDto) {
    return this.notifications.test(principal.accountId, dto, user?.email ?? 'development mode');
  }

  @Get('deliveries')
  @ApiOperation({ summary: "The account's latest notification deliveries, newest first, and how each went" })
  @ApiResponse({ status: 200, type: [DeliveryViewDto] })
  deliveries(@Principal() principal: Principal, @Query() query: DeliveriesQuery): Promise<DeliveryView[]> {
    return this.notifications.deliveries(principal.accountId, query.limit);
  }
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { DeliveryChannel, DeliveryStatus } from './entities/notification-delivery.entity';
import { MAX_LISTED } from './notifications.service';
import { MAX_URL_LENGTH } from './webhook-target';

/** POST /notifications/test: where to send a test notification. */
export class TestNotificationDto {
  @ApiPropertyOptional({ example: 'https://example.tn/ff-hooks', description: 'A webhook URL, http or https, on the internet: signed with the account\'s secret' })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_URL_LENGTH)
  webhookUrl?: string;

  @ApiPropertyOptional({ description: "true: an e-mail to each of the account's owners too, in their language" })
  @IsOptional()
  @IsBoolean()
  email?: boolean;
}

/** GET /notifications/deliveries: how many, newest first. */
export class DeliveriesQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_LISTED, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LISTED)
  limit?: number;
}

/** The secret the account's webhooks are signed with. */
export class WebhookSecretView {
  @ApiProperty({ example: 'whsec_…', description: 'The HMAC-SHA256 key of the FF-Signature header, as written' }) secret: string;
  @ApiProperty() createdAt: Date;
  @ApiProperty({ nullable: true, type: Date, description: 'Until when the previous secret signs too, after a rotation; null otherwise' })
  previousExpiresAt: Date | null;
}

export class DeliveryViewDto {
  @ApiProperty() id: string;
  @ApiProperty({ description: "The notification's ID: the webhook's FF-Event-Id, the same for each of its deliveries" }) notificationId: string;
  @ApiProperty({ example: 'test' }) kind: string;
  @ApiProperty({ enum: DeliveryChannel }) channel: DeliveryChannel;
  @ApiProperty({ description: 'The e-mail address, or the webhook URL' }) target: string;
  @ApiProperty({ enum: DeliveryStatus }) status: DeliveryStatus;
  @ApiProperty({ description: 'The attempts made so far: up to 6' }) attempts: number;
  @ApiProperty({ nullable: true, type: String, example: 'HTTP 500' }) lastError: string | null;
  @ApiProperty({ nullable: true, type: Number, description: "The webhook's last HTTP status" }) responseStatus: number | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty({ nullable: true, type: Date }) deliveredAt: Date | null;
  @ApiProperty({ nullable: true, type: Date, description: 'When it is tried next; null once delivered or failed' }) nextAttemptAt: Date | null;
}

export class TestNotificationView {
  @ApiProperty() notificationId: string;
  @ApiProperty({ type: [DeliveryViewDto], description: 'Pending: GET /notifications/deliveries says how each went' }) deliveries: DeliveryViewDto[];
}

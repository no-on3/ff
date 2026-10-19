import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { MailModule } from '../mail/mail.module';
import { NotificationDelivery } from './entities/notification-delivery.entity';
import { WebhookSecret } from './entities/webhook-secret.entity';
import { NotificationWorker } from './notification-worker.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [TypeOrmModule.forFeature([NotificationDelivery, WebhookSecret]), MailModule, AuditModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationWorker],
  exports: [NotificationsService],
})
export class NotificationsModule {}

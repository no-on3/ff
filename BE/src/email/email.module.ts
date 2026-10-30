import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { EncryptionModule } from '../encryption/encryption.module';
import { MailModule } from '../mail/mail.module';
import { PlansModule } from '../plans/plans.module';
import { StorageModule } from '../storage/storage.module';
import { EmailAccountService } from './email-account.service';
import { EmailBounces } from './email-bounces.service';
import { EmailIdentitiesService, MAIL_RESOLVER } from './email-identities.service';
import { EmailIdentity } from './email-identity.entity';
import { EmailMessage } from './email-message.entity';
import { EmailMessagesService } from './email-messages.service';
import { EmailSender } from './email-sender.service';
import { EmailSending } from './email-sending.entity';
import { EmailSuppression } from './email-suppression.entity';
import { EmailSuppressionsService } from './email-suppressions.service';
import { EmailController } from './email.controller';
import { NodeMailResolver } from './mail-domain';
import { SesFrontDoor } from './ses-front-door';
import { SesOperations } from './ses-operations';

/**
 * Customers' mail (ADR 0012): its identities, suppression lists and quotas, in FF's API and at the SES endpoint, which
 * main.ts starts on its port; its messages, queued, handed to the server of customers' mail, their bounces taken back.
 */
@Module({
  imports: [TypeOrmModule.forFeature([EmailIdentity, EmailSuppression, EmailMessage, EmailSending]), AuditModule, EncryptionModule, MailModule, PlansModule, StorageModule],
  controllers: [EmailController],
  providers: [
    EmailIdentitiesService,
    EmailSuppressionsService,
    EmailAccountService,
    EmailSender,
    EmailMessagesService,
    EmailBounces,
    SesOperations,
    SesFrontDoor,
    { provide: MAIL_RESOLVER, inject: [ConfigService], useFactory: (config: ConfigService) => new NodeMailResolver(config.getOrThrow<string[]>('email.domainResolvers')) },
  ],
  exports: [EmailIdentitiesService, EmailSuppressionsService, EmailAccountService, EmailMessagesService, SesFrontDoor],
})
export class EmailModule {}

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailService } from './mail.service';

@Module({
  providers: [{ provide: MailService, inject: [ConfigService], useFactory: (config: ConfigService) => new MailService(config) }],
  exports: [MailService],
})
export class MailModule {}

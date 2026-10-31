import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Account } from '../accounts/entities/account.entity';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { AuditModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';
import { FunctionUrl } from '../functions/entities/function-url.entity';
import { FunctionsModule } from '../functions/functions.module';
import { MetricsModule } from '../metrics/metrics.module';
import { PlansModule } from '../plans/plans.module';
import { Bucket } from '../storage/bucket.entity';
import { StorageModule } from '../storage/storage.module';
import { CustomDomain } from './custom-domain.entity';
import { CustomDomainsController } from './custom-domains.controller';
import { CustomDomainsService, DOMAIN_RESOLVER } from './custom-domains.service';
import { NodeDomainResolver } from './domain-check';
import { FunctionUrlGateway } from './function-url.gateway';
import { FunctionUrlsController } from './function-urls.controller';
import { FunctionUrlsService } from './function-urls.service';
import { SiteDomainsController } from './site-domains.controller';

/**
 * Functions' URLs: their configuration and customers' own domains for them,
 * and for buckets' sites, under the API, and the gateway that answers them on a
 * port of its own, handing a site's domain to the website server.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([FunctionUrl, CustomDomain, Account, Bucket]),
    FunctionsModule,
    ApiKeysModule,
    AuditModule,
    BillingModule,
    MetricsModule,
    PlansModule,
    StorageModule,
  ],
  controllers: [FunctionUrlsController, CustomDomainsController, SiteDomainsController],
  providers: [
    FunctionUrlsService,
    CustomDomainsService,
    FunctionUrlGateway,
    // The system's DNS servers, or those the settings name.
    { provide: DOMAIN_RESOLVER, inject: [ConfigService], useFactory: (config: ConfigService) => new NodeDomainResolver(config.getOrThrow<string[]>('functionUrls.domainResolvers')) },
  ],
  exports: [FunctionUrlsService, CustomDomainsService, FunctionUrlGateway],
})
export class FunctionUrlsModule {}

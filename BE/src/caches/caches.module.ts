import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Account } from '../accounts/entities/account.entity';
import { AuditModule } from '../audit/audit.module';
import { CacheSettings } from '../config/configuration';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { PlansModule } from '../plans/plans.module';
import { CacheSamplesService } from './cache-samples.service';
import { AgentCacheServer, CACHE_SERVER, CacheServer } from './cache-server';
import { Cache } from './cache.entity';
import { CachesController } from './caches.controller';
import { CachesService } from './caches.service';

/** Customers' caches (ADR 0013): their routes, their hourly measures, and the server they live on through its agent, none without FF_CACHE_HOST. */
@Module({
  imports: [TypeOrmModule.forFeature([Cache, Account]), AuditModule, OrchestratorModule, PlansModule],
  controllers: [CachesController],
  providers: [
    CachesService,
    CacheSamplesService,
    {
      provide: CACHE_SERVER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): CacheServer | null => {
        const settings = config.get<CacheSettings | null>('cache');
        return settings ? new AgentCacheServer(settings) : null;
      },
    },
  ],
  exports: [CachesService],
})
export class CachesModule {}

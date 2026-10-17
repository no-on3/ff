import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountsModule } from './accounts/accounts.module';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { AuthGuard } from './auth/auth.guard';
import { TokenVerifier } from './auth/token-verifier';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { RequestIdInterceptor } from './common/request-context';
import configuration, { DatabaseSettings } from './config/configuration';
import { dataSourceOptions } from './database/database.options';
import { FunctionsModule } from './functions/functions.module';
import { HealthController } from './health/health.controller';
import { MinioClientModule } from './minio-client/minio-client.module';
import { PlansModule } from './plans/plans.module';
import { PlansService } from './plans/plans.service';
import { RateLimitGuard, rateLimitOptions } from './plans/rate-limits';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        dataSourceOptions(configService.getOrThrow<DatabaseSettings>('database')),
    }),
    // Per-account rate limits, sized by each account's plan (D5).
    ThrottlerModule.forRootAsync({
      imports: [PlansModule],
      inject: [PlansService, Reflector],
      useFactory: (plans: PlansService, reflector: Reflector) => rateLimitOptions(plans, reflector),
    }),
    AccountsModule,
    ApiKeysModule,
    FunctionsModule,
    MinioClientModule,
    PlansModule,
  ],
  controllers: [HealthController],
  providers: [
    // Every route needs a valid token unless it is @Public(), or development mode is on (D4).
    TokenVerifier,
    { provide: APP_GUARD, useClass: AuthGuard },
    // Then the rate limits, which count against the account the AuthGuard found: global guards run in this order.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    // Every answer carries its request ID, and platform failures stay generic (D4).
    { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule {}

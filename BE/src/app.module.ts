import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthGuard } from './auth/auth.guard';
import { TokenVerifier } from './auth/token-verifier';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { RequestIdInterceptor } from './common/request-context';
import configuration, { DatabaseSettings } from './config/configuration';
import { dataSourceOptions } from './database/database.options';
import { FunctionsModule } from './functions/functions.module';
import { HealthController } from './health/health.controller';
import { MinioClientModule } from './minio-client/minio-client.module';

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
    FunctionsModule,
    MinioClientModule,
  ],
  controllers: [HealthController],
  providers: [
    // Every route needs a valid token unless it is @Public(), or development mode is on (D4).
    TokenVerifier,
    { provide: APP_GUARD, useClass: AuthGuard },
    // Every answer carries its request ID, and platform failures stay generic (D4).
    { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule {}

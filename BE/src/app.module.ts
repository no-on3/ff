import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { RequestIdInterceptor } from './common/request-context';
import configuration, { DatabaseSettings } from './config/configuration';
import { dataSourceOptions } from './database/database.options';
import { FunctionsModule } from './functions/functions.module';
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
  providers: [
    // Every answer carries its request ID, and platform failures stay generic (D4).
    { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule {}

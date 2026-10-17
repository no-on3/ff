import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import configuration from './config/configuration';
import { DatabaseSettings, dataSourceOptions } from './database/database.options';
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
})
export class AppModule {}

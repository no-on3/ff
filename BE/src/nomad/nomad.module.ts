import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MinioClientModule } from '../minio-client/minio-client.module';
import { NomadService } from './nomad.service';

@Module({
  imports: [ConfigModule, MinioClientModule],
  providers: [NomadService],
  exports: [NomadService],
})
export class NomadModule {}

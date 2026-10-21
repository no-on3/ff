import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { MinioClientModule } from '../minio-client/minio-client.module';
import { Package } from './package.entity';
import { PackagesController } from './packages.controller';
import { PackagesService } from './packages.service';

/** Functions' packages: uploaded, checked, kept, and deleted once unused. */
@Module({
  imports: [TypeOrmModule.forFeature([Package]), MinioClientModule, AuditModule],
  controllers: [PackagesController],
  providers: [PackagesService],
  exports: [PackagesService],
})
export class PackagesModule {}

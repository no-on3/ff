import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { ObjectStoreModule } from '../object-store/object-store.module';
import { CodeImagesService } from './code-images.service';
import { Package } from './package.entity';
import { PackagesController } from './packages.controller';
import { PackagesService } from './packages.service';

/** Functions' packages: uploaded, checked, kept, run as code images, and deleted once unused. */
@Module({
  imports: [TypeOrmModule.forFeature([Package]), ObjectStoreModule, AuditModule],
  controllers: [PackagesController],
  providers: [PackagesService, CodeImagesService],
  exports: [PackagesService, CodeImagesService],
})
export class PackagesModule {}

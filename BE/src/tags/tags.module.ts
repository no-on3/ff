import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { ResourceTag } from './resource-tag.entity';
import { ResourceTagsService } from './resource-tags.service';

/** Tags on an account's resources, as AWS's: its functions' for now. */
@Module({
  imports: [TypeOrmModule.forFeature([ResourceTag]), AuditModule],
  providers: [ResourceTagsService],
  exports: [ResourceTagsService],
})
export class TagsModule {}

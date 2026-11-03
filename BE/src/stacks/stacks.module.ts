import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { Function } from '../functions/entities/function.entity';
import { Queue } from '../queues/queue.entity';
import { Bucket } from '../storage/bucket.entity';
import { Stack, StackResource } from './stack.entity';
import { StacksController } from './stacks.controller';
import { StacksService } from './stacks.service';

/** Stacks (ADR 0016): their routes, and which stack a function is in, for the functions' answers. */
@Module({
  imports: [TypeOrmModule.forFeature([Stack, StackResource, Function, Queue, Bucket]), AuditModule],
  controllers: [StacksController],
  providers: [StacksService],
  exports: [StacksService],
})
export class StacksModule {}

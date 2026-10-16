import { MetricsModule } from '@/metrics/metrics.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MinioClientModule } from '../minio-client/minio-client.module';
import { NomadModule } from '../nomad/nomad.module';
import { FunctionInvocation } from './entities/function-invocation.entity';
import { Function } from './entities/function.entity';
import { FunctionsController } from './functions.controller';
import { FunctionsService } from './functions.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Function, FunctionInvocation]),
    MinioClientModule,
    NomadModule,
    MetricsModule
  ],
  controllers: [FunctionsController],
  providers: [FunctionsService],
  exports: [FunctionsService],
})
export class FunctionsModule {}

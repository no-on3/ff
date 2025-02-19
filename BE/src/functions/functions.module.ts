import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FunctionsController } from './functions.controller';
import { FunctionsService } from './functions.service';
import { Function } from './entities/function.entity';
import { FunctionInvocation } from './entities/function-invocation.entity';
import { MinioClientModule } from '../minio-client/minio-client.module';
import { NomadModule } from '../nomad/nomad.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Function, FunctionInvocation]),
    MinioClientModule,
    NomadModule,
  ],
  controllers: [FunctionsController],
  providers: [FunctionsService],
  exports: [FunctionsService],
})
export class FunctionsModule {}

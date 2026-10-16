import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FunctionMetrics } from './entities/function-metrics.entity';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';
import { Function } from '../functions/entities/function.entity';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    TypeOrmModule.forFeature([FunctionMetrics, Function]),
    OrchestratorModule,
    ConfigModule,
  ],
  providers: [MetricsService],
  controllers: [MetricsController],
  exports: [MetricsService],
})
export class MetricsModule {}

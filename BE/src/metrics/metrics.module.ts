import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomerMetricsService } from './customer-metrics.service';
import { FunctionMetrics } from './entities/function-metrics.entity';
import { RateLimitedInvocations } from './entities/rate-limited-invocations.entity';
import { RefusedInvocationsService } from './refused-invocations.service';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';
import { Function } from '../functions/entities/function.entity';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { PlansModule } from '../plans/plans.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([FunctionMetrics, Function, RateLimitedInvocations]),
    OrchestratorModule,
    PlansModule,
  ],
  providers: [MetricsService, CustomerMetricsService, RefusedInvocationsService],
  controllers: [MetricsController],
  exports: [MetricsService, RefusedInvocationsService, CustomerMetricsService],
})
export class MetricsModule {}

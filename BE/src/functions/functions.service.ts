import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MetricsService } from '../metrics/metrics.service';
import { MinioClientService } from '../minio-client/minio-client.service';
import { FunctionRuntimeError, FunctionTimeoutError } from '../orchestrator/orchestrator.errors';
import { ORCHESTRATOR, Orchestrator } from '../orchestrator/orchestrator.types';
import { CreateFunctionDto } from './dto/create-function.dto';
import { UpdateFunctionDto } from './dto/update-function.dto';
import { FunctionInvocation, InvocationStatus } from './entities/function-invocation.entity';
import { Function, FunctionStatus } from './entities/function.entity';

/** Fields whose change requires rolling out a new version of the function. */
const ROLLOUT_FIELDS = ['code', 'runtime', 'memory', 'timeout'] as const;

@Injectable()
export class FunctionsService {
  constructor(
    @InjectRepository(Function)
    private functionsRepository: Repository<Function>,
    @InjectRepository(FunctionInvocation)
    private invocationsRepository: Repository<FunctionInvocation>,
    private minioClientService: MinioClientService,
    @Inject(ORCHESTRATOR) private orchestrator: Orchestrator,
    private configService: ConfigService,
    private metricsService: MetricsService,
  ) {}

  private readyTimeoutMs(): number {
    return this.configService.get<number>('orchestrator.readyTimeoutSeconds', 90) * 1000;
  }

  async create(createFunctionDto: CreateFunctionDto, userId: string): Promise<Function> {
    const function_ = this.functionsRepository.create({
      ...createFunctionDto,
      userId,
      status: FunctionStatus.CREATING,
    });

    const savedFunction = await this.functionsRepository.save(function_);
    try {
      // Archive the code in object storage (the cluster gets it via an immutable ConfigMap).
      const codePath = `${savedFunction.id}/code.${this.getFileExtension(savedFunction.runtime)}`;
      await this.minioClientService.uploadCode(codePath, savedFunction.code);

      await this.orchestrator.deploy(savedFunction);
      // ACTIVE only once an instance can actually serve; otherwise ERROR with the diagnostics.
      await this.orchestrator.waitUntilReady(savedFunction, this.readyTimeoutMs());

      savedFunction.status = FunctionStatus.ACTIVE;
      await this.functionsRepository.save(savedFunction);

      return savedFunction;
    } catch (error) {
      savedFunction.status = FunctionStatus.ERROR;
      savedFunction.error = error.message;
      await this.functionsRepository.save(savedFunction);
      throw new BadRequestException(error.message);
    }
  }

  async findAllByUser(userId: string): Promise<Function[]> {
    return this.functionsRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string): Promise<Function> {
    const function_ = await this.functionsRepository.findOne({ where: { id } });
    if (!function_) {
      throw new NotFoundException(`Function with ID ${id} not found`);
    }
    return function_;
  }

  async update(id: string, updateFunctionDto: UpdateFunctionDto): Promise<Function> {
    const function_ = await this.findOne(id);
    const updated = { ...function_, ...updateFunctionDto } as Function;
    const needsRollout = ROLLOUT_FIELDS.some(
      (field) => updateFunctionDto[field] !== undefined && updateFunctionDto[field] !== function_[field],
    );

    if (needsRollout) {
      try {
        if (updateFunctionDto.code !== undefined) {
          const codePath = `${id}/code.${this.getFileExtension(updated.runtime)}`;
          await this.minioClientService.uploadCode(codePath, updated.code);
        }
        await this.orchestrator.update(updated);
        // The old version keeps serving during the rollout; record the change only once it's live.
        await this.orchestrator.waitUntilReady(updated, this.readyTimeoutMs());
      } catch (error) {
        throw new BadRequestException(error.message);
      }
    }

    Object.assign(function_, updateFunctionDto);
    return this.functionsRepository.save(function_);
  }

  async remove(id: string): Promise<void> {
    const function_ = await this.findOne(id);
    
    try {
      await this.orchestrator.remove(function_);
      
      // Remove code from MinIO
      const codePath = `${id}/code.${this.getFileExtension(function_.runtime)}`;
      await this.minioClientService.deleteCode(codePath);
      
      // Delete from database
      await this.functionsRepository.remove(function_);
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  async invoke(id: string, input?: Record<string, any>): Promise<FunctionInvocation> {
    const function_ = await this.findOne(id);
    if (function_.status !== FunctionStatus.ACTIVE) {
      throw new BadRequestException('Function is not active');
    }

    const invocation = this.invocationsRepository.create({
      functionId: id,
      input: input || {},
      status: InvocationStatus.RUNNING,
    });

    await this.invocationsRepository.save(invocation);

    const startTime = Date.now();
    try {
      const result = await this.orchestrator.invoke(function_, input || {});
      const duration = Date.now() - startTime;

      // Record metrics (end-to-end latency, as seen by callers)
      await this.metricsService.recordMetric(
        id,
        duration,
        result.cpuUsed || 0,
        result.memoryUsedMb || 0,
        false
      );

      // Update invocation with results and metrics. Duration is the execution
      // time reported by the runtime (the basis for metering), else end-to-end.
      invocation.output = result.output as Record<string, any>;
      invocation.duration = result.durationMs ?? duration;
      invocation.memoryUsed = result.memoryUsedMb;
      invocation.cpuUsed = result.cpuUsed;
      invocation.status = InvocationStatus.COMPLETED;
      await this.invocationsRepository.save(invocation);

      return invocation;
    } catch (error) {
      const duration = Date.now() - startTime;
      await this.metricsService.recordMetric(id, duration, 0, 0, true);

      invocation.duration = duration;
      invocation.status = error instanceof FunctionTimeoutError ? InvocationStatus.TIMEOUT : InvocationStatus.ERROR;
      invocation.error = error instanceof FunctionRuntimeError ? `${error.errorType}: ${error.message}` : error.message;
      await this.invocationsRepository.save(invocation);
      throw new BadRequestException(invocation.error);
    }
  }

  async getInvocations(
    functionId: string,
    limit: number,
    offset: number,
  ): Promise<{ invocations: FunctionInvocation[]; total: number }> {
    const [invocations, total] = await this.invocationsRepository.findAndCount({
      where: { functionId },
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    });


    return { invocations, total };
  }

  private getFileExtension(runtime: string): string {
    switch (runtime) {
      case 'nodejs':
        return 'ts';
      case 'python':
        return 'py';
      default:
        return 'txt';
    }
  }
}

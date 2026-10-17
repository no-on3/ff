import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MetricsService } from '../metrics/metrics.service';
import { MinioClientService } from '../minio-client/minio-client.service';
import { CodeTooLargeError, FunctionRuntimeError, FunctionTimeoutError } from '../orchestrator/orchestrator.errors';
import { ORCHESTRATOR, Orchestrator } from '../orchestrator/orchestrator.types';
import { CreateFunctionDto } from './dto/create-function.dto';
import { UpdateFunctionDto } from './dto/update-function.dto';
import { FunctionInvocation, InvocationStatus } from './entities/function-invocation.entity';
import { Function, FunctionStatus } from './entities/function.entity';

/** Fields whose change requires rolling out a new version of the function. */
const ROLLOUT_FIELDS = ['code', 'runtime', 'memory', 'timeout'] as const;

/** A message without its final period, to continue it with another sentence. */
const clause = (message: string): string => message.replace(/\.\s*$/, '');

/**
 * The function lifecycle (client-readiness plan, P-03). A function's record and
 * its Deployment always describe the same version:
 * - create: ACTIVE once an instance is ready; otherwise ERROR with the diagnosis,
 *   and scaled to zero so a pod that can't start doesn't hold the quota;
 * - update: rolled out and checked on a real instance, even at zero. A failure
 *   rolls back to the working version; a function that had none (not ACTIVE)
 *   keeps the attempt and its diagnosis instead. A success makes it ACTIVE.
 */
@Injectable()
export class FunctionsService {
  private readonly logger = new Logger(FunctionsService.name);

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
      await this.minioClientService.uploadCode(this.codePath(savedFunction), savedFunction.code);

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
      // Its objects and the diagnosis stay, so an update can repair it, and a delete removes everything.
      if (!(error instanceof CodeTooLargeError)) await this.releaseInstances(savedFunction);
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
    const changesVersion = ROLLOUT_FIELDS.some(
      (field) => updateFunctionDto[field] !== undefined && updateFunctionDto[field] !== function_[field],
    );
    // A function that isn't ACTIVE always rolls out, even unchanged, so the same code
    // can be retried after a passing failure (a full quota, a missing image).
    const repairing = function_.status !== FunctionStatus.ACTIVE;

    if (!changesVersion && !repairing) {
      Object.assign(function_, updateFunctionDto);
      return this.functionsRepository.save(function_);
    }

    try {
      await this.orchestrator.update(updated);
      // The old version keeps serving during the rollout; record the change only once it's live.
      await this.orchestrator.waitUntilReady(updated, this.readyTimeoutMs());
    } catch (error) {
      if (error instanceof CodeTooLargeError) throw new BadRequestException(error.message); // nothing was applied
      if (repairing) return this.keepFailedAttempt(function_, updateFunctionDto, error);
      return this.rollBack(function_, error);
    }

    const previousCodePath = this.codePath(function_);
    Object.assign(function_, updateFunctionDto, { status: FunctionStatus.ACTIVE, error: null });
    const saved = await this.functionsRepository.save(function_);
    await this.archiveCode(saved, previousCodePath);
    return saved;
  }

  /**
   * A failed update of a working function: apply the previous version again, so
   * the Deployment matches the record, and answer with the diagnosis. If that
   * fails too, the function is ERROR, with both messages.
   */
  private async rollBack(previous: Function, failure: Error): Promise<never> {
    this.logger.warn(`Update of function ${previous.id} failed, rolling back: ${failure.message}`);
    try {
      await this.orchestrator.update(previous);
      await this.orchestrator.waitUntilReady(previous, this.readyTimeoutMs());
    } catch (rollbackError) {
      previous.status = FunctionStatus.ERROR;
      previous.error =
        `The update failed: ${clause(failure.message)}. ` +
        `Rolling back to the previous version failed too: ${(rollbackError as Error).message}`;
      await this.functionsRepository.save(previous);
      await this.releaseInstances(previous);
      throw new BadRequestException(previous.error);
    }
    throw new BadRequestException(`${clause(failure.message)}. The update was rolled back: the previous version is still live.`);
  }

  /**
   * A failed update of a function that wasn't ACTIVE: there is no working version
   * to go back to. Keep the attempt and its diagnosis, so the record shows the
   * code that failed and why, and release its instance, as a failed create does.
   */
  private async keepFailedAttempt(function_: Function, changes: UpdateFunctionDto, failure: Error): Promise<never> {
    const previousCodePath = this.codePath(function_);
    Object.assign(function_, changes, { status: FunctionStatus.ERROR, error: failure.message });
    const saved = await this.functionsRepository.save(function_);
    await this.releaseInstances(saved);
    await this.archiveCode(saved, previousCodePath);
    throw new BadRequestException(failure.message);
  }

  /**
   * Scales a function that can't serve to zero: the idle sweep only scales ACTIVE
   * functions, so a pod that never becomes ready would hold the quota for good.
   */
  private async releaseInstances(function_: Function): Promise<void> {
    try {
      await this.orchestrator.scale(function_, 0);
    } catch (error) {
      this.logger.warn(`Could not scale failed function ${function_.id} to zero: ${(error as Error).message}`);
    }
  }

  /**
   * Object storage keeps a copy of the record's code. It is written after the
   * record, and a failure is only logged: nothing reads the copy yet, and the
   * record and the Deployment already agree.
   */
  private async archiveCode(function_: Function, previousCodePath: string): Promise<void> {
    const codePath = this.codePath(function_);
    try {
      await this.minioClientService.uploadCode(codePath, function_.code);
      // A runtime change moves the copy (code.ts ↔ code.py).
      if (previousCodePath !== codePath) await this.minioClientService.deleteCode(previousCodePath);
    } catch (error) {
      this.logger.error(`Could not archive the code of function ${function_.id}: ${(error as Error).message}`);
    }
  }

  async remove(id: string): Promise<void> {
    const function_ = await this.findOne(id);
    
    try {
      await this.orchestrator.remove(function_);
      
      // Remove the code's copy from object storage
      await this.minioClientService.deleteCode(this.codePath(function_));
      
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

  /** Where object storage keeps the copy of a function's code. */
  private codePath(function_: Pick<Function, 'id' | 'runtime'>): string {
    return `${function_.id}/code.${this.getFileExtension(function_.runtime)}`;
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

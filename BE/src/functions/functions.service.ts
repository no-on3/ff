import { BadRequestException, Inject, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MetricsService } from '../metrics/metrics.service';
import { MinioClientService } from '../minio-client/minio-client.service';
import { describeError } from '../common/describe-error';
import { CodeTooLargeError, FunctionTimeoutError } from '../orchestrator/orchestrator.errors';
import { ORCHESTRATOR, Orchestrator } from '../orchestrator/orchestrator.types';
import { CreateFunctionDto } from './dto/create-function.dto';
import { ListInvocationsQuery } from './dto/list-invocations.dto';
import { UpdateFunctionDto } from './dto/update-function.dto';
import { ScalingConfig, UpdateScalingConfigDto } from './dto/update-scaling-config.dto';
import { FunctionInvocation, InvocationStatus } from './entities/function-invocation.entity';
import { Function, FunctionStatus } from './entities/function.entity';
import { callersFailure, failureResponse, platformFailure } from './failures';

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
 *
 * Every method acts for one account (P-10, D4): it takes the account ID, every
 * query includes it, and another account's function is not found. Failures
 * show the function's own errors as they are, and platform failures as a
 * generic message with the request ID (failures.ts).
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

  async create(accountId: string, createFunctionDto: CreateFunctionDto): Promise<Function> {
    const function_ = this.functionsRepository.create({
      ...createFunctionDto,
      accountId,
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
      const failure = callersFailure(error) ?? platformFailure(this.logger, 'Deploying the function', error);
      savedFunction.status = FunctionStatus.ERROR;
      savedFunction.error = failure;
      await this.functionsRepository.save(savedFunction);
      // Its objects and the diagnosis stay, so an update can repair it, and a delete removes everything.
      if (!(error instanceof CodeTooLargeError)) await this.releaseInstances(savedFunction);
      throw failureResponse(error, failure);
    }
  }

  async findAll(accountId: string): Promise<Function[]> {
    return this.functionsRepository.find({
      where: { accountId },
      order: { createdAt: 'DESC' },
    });
  }

  /** The account's function; another account's is not found, exactly like one that doesn't exist (D4). */
  async findOne(accountId: string, id: string): Promise<Function> {
    const function_ = await this.functionsRepository.findOne({ where: { id, accountId } });
    if (!function_) {
      throw new NotFoundException(`Function with ID ${id} not found`);
    }
    return function_;
  }

  async update(accountId: string, id: string, updateFunctionDto: UpdateFunctionDto): Promise<Function> {
    const function_ = await this.findOne(accountId, id);
    const updated = { ...function_, ...updateFunctionDto };
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
  private async rollBack(previous: Function, error: unknown): Promise<never> {
    const failure = callersFailure(error) ?? platformFailure(this.logger, 'Updating the function', error);
    this.logger.warn(`Update of function ${previous.id} failed, rolling back: ${describeError(error)}`);
    try {
      await this.orchestrator.update(previous);
      await this.orchestrator.waitUntilReady(previous, this.readyTimeoutMs());
    } catch (rollbackError) {
      previous.status = FunctionStatus.ERROR;
      previous.error = `The update failed: ${clause(failure)}. ${platformFailure(this.logger, 'Rolling back to the previous version', rollbackError)}`;
      await this.functionsRepository.save(previous);
      await this.releaseInstances(previous);
      throw new InternalServerErrorException(previous.error);
    }
    throw failureResponse(error, `${clause(failure)}. The update was rolled back: the previous version is still live.`);
  }

  /**
   * A failed update of a function that wasn't ACTIVE: there is no working version
   * to go back to. Keep the attempt and its diagnosis, so the record shows the
   * code that failed and why, and release its instance, as a failed create does.
   */
  private async keepFailedAttempt(function_: Function, changes: UpdateFunctionDto, error: unknown): Promise<never> {
    const previousCodePath = this.codePath(function_);
    const failure = callersFailure(error) ?? platformFailure(this.logger, 'Updating the function', error);
    Object.assign(function_, changes, { status: FunctionStatus.ERROR, error: failure });
    const saved = await this.functionsRepository.save(function_);
    await this.releaseInstances(saved);
    await this.archiveCode(saved, previousCodePath);
    throw failureResponse(error, failure);
  }

  /**
   * Scales a function that can't serve to zero: the idle sweep only scales ACTIVE
   * functions, so a pod that never becomes ready would hold the quota for good.
   */
  private async releaseInstances(function_: Function): Promise<void> {
    try {
      await this.orchestrator.scale(function_, 0);
    } catch (error) {
      this.logger.warn(`Could not scale failed function ${function_.id} to zero: ${describeError(error)}`);
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
      this.logger.error(`Could not archive the code of function ${function_.id}: ${describeError(error)}`);
    }
  }

  async remove(accountId: string, id: string): Promise<void> {
    const function_ = await this.findOne(accountId, id);

    try {
      await this.orchestrator.remove(function_);
      
      // Remove the code's copy from object storage
      await this.minioClientService.deleteCode(this.codePath(function_));
      
      // Delete from database
      await this.functionsRepository.remove(function_);
    } catch (error) {
      throw new InternalServerErrorException(platformFailure(this.logger, 'Deleting the function', error));
    }
  }

  async invoke(accountId: string, id: string, input?: Record<string, unknown>): Promise<FunctionInvocation> {
    const function_ = await this.findOne(accountId, id);
    if (function_.status !== FunctionStatus.ACTIVE) {
      throw new BadRequestException('Function is not active');
    }

    const invocation = this.invocationsRepository.create({
      functionId: id,
      input: input || {},
      status: InvocationStatus.RUNNING,
    });

    await this.invocationsRepository.save(invocation);

    // Counted while it runs: concurrency is the scaling signal, and a burst scales up at once (D14).
    this.metricsService.invocationStarted(function_);
    const startTime = Date.now();
    try {
      const result = await this.orchestrator.invoke(function_, input || {});
      const duration = Date.now() - startTime;

      // Record metrics (end-to-end latency, as seen by callers)
      this.metricsService.recordMetric(id, duration, result.memoryUsedMb || 0, false);

      // Update invocation with results and metrics. Duration is the execution
      // time reported by the runtime (the basis for metering), else end-to-end.
      invocation.output = result.output;
      invocation.duration = result.durationMs ?? duration;
      invocation.memoryUsed = result.memoryUsedMb;
      invocation.status = InvocationStatus.COMPLETED;
      await this.invocationsRepository.save(invocation);

      return invocation;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.metricsService.recordMetric(id, duration, 0, true);

      invocation.duration = duration;
      invocation.status = error instanceof FunctionTimeoutError ? InvocationStatus.TIMEOUT : InvocationStatus.ERROR;
      // The history is the account's to read: a platform failure is generic there too (D4).
      invocation.error = callersFailure(error) ?? platformFailure(this.logger, 'The invocation', error);
      await this.invocationsRepository.save(invocation);
      throw failureResponse(error, invocation.error);
    } finally {
      this.metricsService.invocationFinished(function_);
    }
  }

  /** What GET /functions/:id/scaling-config answers. */
  scalingConfig(function_: Function): ScalingConfig {
    return {
      minInstances: function_.minInstances,
      maxInstances: function_.maxInstances,
      scaleToZero: function_.scaleToZero !== false && function_.minInstances === 0,
    };
  }

  /**
   * Changes a function's instance limits (D14), and brings its running instances
   * within them at once: more for a higher minInstances, fewer for a lower
   * maxInstances. Nothing is rolled out: the code doesn't change.
   */
  async updateScalingConfig(accountId: string, id: string, changes: UpdateScalingConfigDto): Promise<ScalingConfig> {
    const function_ = await this.findOne(accountId, id);
    const minInstances = changes.minInstances ?? function_.minInstances;
    const maxInstances = changes.maxInstances ?? function_.maxInstances;
    if (minInstances > maxInstances) {
      throw new BadRequestException(`minInstances (${minInstances}) can't be more than maxInstances (${maxInstances})`);
    }
    Object.assign(function_, { minInstances, maxInstances });
    const saved = await this.functionsRepository.save(function_);
    if (saved.status === FunctionStatus.ACTIVE) await this.applyInstanceLimits(saved);
    return this.scalingConfig(saved);
  }

  private async applyInstanceLimits(function_: Function): Promise<void> {
    try {
      const desired = await this.orchestrator.desiredInstances(function_);
      const target = Math.min(function_.maxInstances, Math.max(function_.minInstances, desired));
      if (target !== desired) await this.orchestrator.scale(function_, target);
    } catch (error) {
      // The limits are saved: the next rollout applies them, and so does the scaler's next tick with traffic.
      this.logger.warn(`Could not apply the instance limits of function ${function_.id}: ${(error as Error).message}`);
    }
  }

  /** One page of a function's history, newest first. */
  async getInvocations(
    accountId: string,
    id: string,
    page: Pick<ListInvocationsQuery, 'limit' | 'offset'>,
  ): Promise<{ invocations: FunctionInvocation[]; total: number }> {
    await this.findOne(accountId, id); // another account's function is not found
    const [invocations, total] = await this.invocationsRepository.findAndCount({
      // The account here too, so that this query alone never reads another account's history.
      where: { functionId: id, function: { accountId } },
      order: { createdAt: 'DESC' },
      take: page.limit,
      skip: page.offset,
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

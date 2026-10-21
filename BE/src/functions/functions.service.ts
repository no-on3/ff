import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  MessageEvent,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Observable } from 'rxjs';
import { EntityManager, Not, Repository } from 'typeorm';
import { MetricsService } from '../metrics/metrics.service';
import { MinioClientService } from '../minio-client/minio-client.service';
import { describeError } from '../common/describe-error';
import {
  CodeTooLargeError,
  FunctionRuntimeError,
  FunctionThrottledError,
  FunctionTimeoutError,
  InvalidLogCursorError,
  LogStoreUnavailableError,
  initMsOf,
} from '../orchestrator/orchestrator.errors';
import { FunctionWorkload, ORCHESTRATOR, Orchestrator } from '../orchestrator/orchestrator.types';
import { PlanView } from '../plans/plan-limits';
import { PlansService } from '../plans/plans.service';
import { AuditService } from '../audit/audit.service';
import { UsageStatus } from '../usage/usage-record.entity';
import { failureStatus, usageRecord } from '../usage/usage';
import { UsageService } from '../usage/usage.service';
import { CreditService } from '../billing/credit.service';
import { CreateFunctionDto } from './dto/create-function.dto';
import { FunctionLogsQuery, FunctionLogsStreamQuery, FunctionLogsView } from './dto/function-logs.dto';
import { ListInvocationsQuery } from './dto/list-invocations.dto';
import { UpdateFunctionDto } from './dto/update-function.dto';
import { ScalingConfig, UpdateScalingConfigDto } from './dto/update-scaling-config.dto';
import { SecretsView } from './dto/secrets.dto';
import { FunctionInvocation, InvocationStatus } from './entities/function-invocation.entity';
import { Function, FunctionStatus } from './entities/function.entity';
import {
  FunctionEnvironmentValues,
  NO_ENVIRONMENT,
  StoredSecret,
  changedSecrets,
  combinedProblems,
  isEmpty,
  newRevision,
  processEnvironment,
  sameVariables,
  secretsView,
  storedSecrets,
  variableChanges,
  withSecrets,
} from './environment';
import { EnvironmentStore } from './environment.store';
import { callersFailure, failureResponse, platformFailure } from './failures';
import { keptJson, keptText } from './history';
import { liveTail } from './live-tail';
import { logsQuery } from './logs-window';

/** Fields whose change requires rolling out a new version of the function; so does a change of its environment. */
const ROLLOUT_FIELDS = ['code', 'runtime', 'memory', 'timeout', 'eventFormat'] as const;

/** A function as the API answers it: its record and its variables. Its secrets' values are never part of it. */
export type FunctionView = Function & { environment: Record<string, string> };

/** The answer for a function: a copy of its record, with its variables. */
function viewOf(function_: Function, environment: FunctionEnvironmentValues): FunctionView {
  return { ...function_, environment: { ...environment.variables } };
}

/** The function as the orchestrator runs it: its record, and the variables and secrets its process gets. */
function workloadOf(function_: Function, environment: FunctionEnvironmentValues): FunctionWorkload {
  return {
    ...function_,
    environment: isEmpty(environment) ? undefined : { revision: environment.revision, values: processEnvironment(environment) },
  };
}

/** An environment with these variables, and a new revision when there is anything: a change rolls out. */
function withVariables(environment: FunctionEnvironmentValues, variables: Record<string, string>): FunctionEnvironmentValues {
  const next = { ...environment, variables: { ...variables } };
  return { ...next, revision: isEmpty(next) ? '' : newRevision() };
}

/** A name that is a variable and a secret, or more than 4 KB between them: 400, before anything changes. */
function refuseCombined(environment: FunctionEnvironmentValues): void {
  const problems = combinedProblems(environment);
  if (problems.length) throw new BadRequestException(problems);
}

/** A function's environment before a change, and after it: the same object when the change leaves it alone. */
interface EnvironmentChange {
  before: FunctionEnvironmentValues;
  after: FunctionEnvironmentValues;
}

/** The fields of a function a change asks for, without its environment. */
type FieldChanges = Omit<UpdateFunctionDto, 'environment'>;

/** Each secret's value, by name: to tell which changed, for the audit log, which keeps only the names. */
const valuesOf = (secrets: Record<string, StoredSecret>): Record<string, string> =>
  Object.fromEntries(Object.entries(secrets).map(([name, secret]) => [name, secret.value]));

/** A message without its final period, to continue it with another sentence. */
const clause = (message: string): string => message.replace(/\.\s*$/, '');

/** The values a request sets that the account's plan limits (D5). */
type Sized = Partial<Pick<Function, 'memory' | 'timeout' | 'minInstances' | 'maxInstances'>>;

/**
 * What the account's plan refuses in these values, each naming the plan's limit.
 * Only values that change are checked: a function keeps what an older, larger
 * plan gave it until it is changed.
 */
export function planProblems(plan: PlanView, change: Sized, current: Sized = {}): string[] {
  const { limits, name } = plan;
  const changes = (field: keyof Sized) => change[field] !== undefined && change[field] !== current[field];
  const problems: string[] = [];
  if (changes('memory') && (change.memory as number) > limits.memoryMb) {
    problems.push(`memory must be at most ${limits.memoryMb} MB on the ${name} plan`);
  }
  if (changes('timeout') && (change.timeout as number) > limits.timeoutSeconds) {
    problems.push(`timeout must be at most ${limits.timeoutSeconds} s on the ${name} plan`);
  }
  for (const field of ['minInstances', 'maxInstances'] as const) {
    if (changes(field) && (change[field] as number) > limits.instancesPerFunction) {
      problems.push(`${field} must be at most ${limits.instancesPerFunction} on the ${name} plan`);
    }
  }
  return problems;
}

function refuseOverPlan(plan: PlanView, change: Sized, current?: Sized): void {
  const problems = planProblems(plan, change, current);
  if (problems.length) throw new BadRequestException(problems);
}

/**
 * Locks the account's row until the transaction ends. Every create and rename
 * takes it, so they run one at a time per account: the plan's count and the
 * name each one checks stay true until it saves.
 */
function lockAccount(manager: EntityManager, accountId: string): Promise<unknown> {
  return manager.query('SELECT 1 FROM "accounts" WHERE "id" = $1 FOR NO KEY UPDATE', [accountId]);
}

/** Whether another of the account's functions has this name. */
function nameInUse(manager: EntityManager, accountId: string, name: string, otherThan?: string): Promise<boolean> {
  return manager.existsBy(Function, { accountId, name, ...(otherThan ? { id: Not(otherThan) } : {}) });
}

/** The answer when another of the account's functions has the name. */
function nameTaken(name: string): ConflictException {
  return new ConflictException(`A function named "${name}" already exists in this account: choose another name, or change that function`);
}

/** How a save goes on when the new name was taken since the update checked it. */
type WhenNameTaken = 'refuse' | 'keepOldName';

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
 * query includes it, and another account's function is not found. The account's
 * plan limits what it may create and change (P-15, D5), and the audit log
 * records each change (P-17). Failures
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
    private plans: PlansService,
    private audit: AuditService,
    private usage: UsageService,
    private credit: CreditService,
    private environments: EnvironmentStore,
  ) {}

  private readyTimeoutMs(): number {
    return this.configService.get<number>('orchestrator.readyTimeoutSeconds', 90) * 1000;
  }

  async create(accountId: string, createFunctionDto: CreateFunctionDto): Promise<FunctionView> {
    const plan = await this.plans.forAccount(accountId);
    refuseOverPlan(plan, createFunctionDto);
    const { environment: variables, secrets, ...fields } = createFunctionDto;
    const environment = withSecrets(withVariables(NO_ENVIRONMENT, variables ?? {}), storedSecrets(secrets ?? {}, new Date()));
    refuseCombined(environment);
    const function_ = this.functionsRepository.create({
      ...fields,
      accountId,
      status: FunctionStatus.CREATING,
    });

    const savedFunction = await this.insertWithinPlan(plan, function_, environment);
    try {
      // Archive the code in object storage (the cluster gets it via an immutable ConfigMap).
      await this.minioClientService.uploadCode(this.codePath(savedFunction), savedFunction.code);

      await this.plans.withTenant(accountId, (tenant) => this.orchestrator.deploy(workloadOf(savedFunction, environment), tenant));
      // ACTIVE only once an instance can actually serve; otherwise ERROR with the diagnostics.
      await this.orchestrator.waitUntilReady(savedFunction, this.readyTimeoutMs());

      savedFunction.status = FunctionStatus.ACTIVE;
      await this.functionsRepository.save(savedFunction);

      return viewOf(savedFunction, environment);
    } catch (error) {
      const failure = callersFailure(error) ?? platformFailure(this.logger, 'Deploying the function', error);
      savedFunction.status = FunctionStatus.ERROR;
      savedFunction.error = failure;
      await this.functionsRepository.save(savedFunction);
      // Its objects and the diagnosis stay, so an update can repair it, and a delete removes everything.
      if (!(error instanceof CodeTooLargeError)) await this.releaseInstances(savedFunction);
      // The function exists all the same: its ID lets the caller open it to fix it, rather than create it again.
      throw failureResponse(error, failure, { functionId: savedFunction.id });
    }
  }

  /**
   * Saves a new function and its environment, unless another of its account's
   * has the name, or the account has as many as its plan allows. The account's
   * row stays locked meanwhile, so that two creates at once can't both take the
   * name or the last place.
   */
  private insertWithinPlan(plan: PlanView, function_: Function, environment: FunctionEnvironmentValues): Promise<Function> {
    return this.functionsRepository.manager.transaction(async (manager) => {
      await lockAccount(manager, function_.accountId);
      if (await nameInUse(manager, function_.accountId, function_.name)) throw nameTaken(function_.name);
      const count = await manager.countBy(Function, { accountId: function_.accountId });
      if (count >= plan.limits.functions) {
        const allowed = plan.limits.functions === 1 ? '1 function' : `${plan.limits.functions} functions`;
        throw new BadRequestException(`The ${plan.name} plan allows ${allowed} per account: delete one first`);
      }
      const saved = await manager.save(Function, function_);
      if (!isEmpty(environment)) await this.environments.save(saved, environment, manager);
      // Recorded with the row: a function whose deploy fails later still says who created it. Variables and secrets by name only.
      const variables = Object.keys(environment.variables).sort();
      const secrets = Object.keys(environment.secrets).sort();
      await this.audit.record(
        {
          accountId: saved.accountId,
          action: 'function.create',
          resource: `function:${saved.id}`,
          details: {
            name: saved.name,
            runtime: saved.runtime,
            memory: saved.memory,
            timeout: saved.timeout,
            ...(variables.length ? { environment: variables } : {}),
            ...(secrets.length ? { secrets } : {}),
          },
        },
        manager,
      );
      return saved;
    });
  }

  /**
   * The fields an update changes, for the audit log: their names, and the new
   * values but the code's; the variables and the secrets by name only, never
   * their values.
   */
  private recordUpdate(function_: Function, changed: string[], outcome: string, environment?: EnvironmentChange): Promise<void> {
    const values = Object.fromEntries(
      changed
        .filter((field) => !['code', 'environment', 'secrets'].includes(field))
        .map((field) => [field, function_[field as keyof Function]]),
    );
    const names = {
      ...(environment && changed.includes('environment') ? { environment: variableChanges(environment.before.variables, environment.after.variables) } : {}),
      ...(environment && changed.includes('secrets') ? { secrets: variableChanges(valuesOf(environment.before.secrets), valuesOf(environment.after.secrets)) } : {}),
    };
    return this.audit.record({
      accountId: function_.accountId,
      action: 'function.update',
      resource: `function:${function_.id}`,
      details: { changed, ...values, ...names, outcome },
    });
  }

  async findAll(accountId: string): Promise<Function[]> {
    return this.functionsRepository.find({
      where: { accountId },
      order: { createdAt: 'DESC' },
    });
  }

  /** The account's function as GET /functions/:id answers it: with its variables, never its secrets' values. */
  async describe(accountId: string, id: string): Promise<FunctionView> {
    const function_ = await this.findOne(accountId, id);
    return viewOf(function_, await this.environments.load(id));
  }

  /** The account's function; another account's is not found, exactly like one that doesn't exist (D4). */
  async findOne(accountId: string, id: string): Promise<Function> {
    const function_ = await this.functionsRepository.findOne({ where: { id, accountId } });
    if (!function_) {
      throw new NotFoundException(`Function with ID ${id} not found`);
    }
    return function_;
  }

  async update(accountId: string, id: string, updateFunctionDto: UpdateFunctionDto): Promise<FunctionView> {
    const function_ = await this.findOne(accountId, id);
    const plan = await this.plans.forAccount(accountId);
    refuseOverPlan(plan, updateFunctionDto, function_);
    const { environment: variables, ...changes } = updateFunctionDto;
    const newName = changes.name !== undefined && changes.name !== function_.name ? changes.name : undefined;
    // Refused before anything changes. The save claims the name again, under the account's lock:
    // another request may take it during a rollout.
    if (newName !== undefined && (await nameInUse(this.functionsRepository.manager, accountId, newName, id))) throw nameTaken(newName);
    // The variables sent replace them all, as on AWS Lambda; a change is a new version, as the code's is.
    const before = await this.environments.load(id);
    const environmentChanges = variables !== undefined && !sameVariables(variables, before.variables);
    const after = environmentChanges ? withVariables(before, variables) : before;
    if (environmentChanges) refuseCombined(after);
    const changed: string[] = (Object.keys(changes) as Array<keyof FieldChanges>).filter(
      (field) => changes[field] !== undefined && changes[field] !== function_[field],
    );
    if (environmentChanges) changed.push('environment');
    const { saved, environment } = await this.change(function_, changes, { before, after }, changed);
    return viewOf(saved, environment);
  }

  /** The function's secrets: each one's name and when it was set, never a value. */
  async listSecrets(accountId: string, id: string): Promise<SecretsView> {
    await this.findOne(accountId, id);
    return secretsView(await this.environments.load(id));
  }

  /**
   * Sets and removes secrets (null removes one), rolled out as a new version
   * like a change of variables; the answer comes once it is live. Values
   * already there, and names already gone, change nothing, and roll nothing out.
   */
  async updateSecrets(accountId: string, id: string, changes: Record<string, string | null>): Promise<SecretsView> {
    const function_ = await this.findOne(accountId, id);
    const before = await this.environments.load(id);
    const { secrets, changed } = changedSecrets(before.secrets, changes, new Date());
    if (!changed) return secretsView(before);
    const after = withSecrets(before, secrets);
    refuseCombined(after);
    const { environment } = await this.change(function_, {}, { before, after }, ['secrets']);
    return secretsView(environment);
  }

  /**
   * Applies a change: saved at once when it needs no new version (a new name),
   * else rolled out and waited for, then saved, with the environment that went
   * live. A failure rolls back to the working version, or keeps the attempt of
   * a function that had none, as the lifecycle above describes.
   */
  private async change(
    function_: Function,
    changes: FieldChanges,
    environment: EnvironmentChange,
    changed: string[],
  ): Promise<{ saved: Function; environment: FunctionEnvironmentValues }> {
    const previousName = function_.name;
    const newName = changes.name !== undefined && changes.name !== previousName ? changes.name : undefined;
    const environmentChanges = environment.after !== environment.before;
    const updated = { ...function_, ...changes };
    const changesVersion = environmentChanges || ROLLOUT_FIELDS.some((field) => changes[field] !== undefined && changes[field] !== function_[field]);
    // A function that isn't ACTIVE always rolls out, even unchanged, so the same code
    // can be retried after a passing failure (a full quota, a missing image).
    const repairing = function_.status !== FunctionStatus.ACTIVE;

    if (!changesVersion && !repairing) {
      Object.assign(function_, changes);
      const saved = await this.saveClaimingName(function_, previousName, 'refuse');
      if (changed.length) await this.recordUpdate(saved, changed, 'saved');
      return { saved, environment: environment.before };
    }

    try {
      await this.plans.withTenant(function_.accountId, (tenant) => this.orchestrator.update(workloadOf(updated, environment.after), tenant));
      // The old version keeps serving during the rollout; record the change only once it's live.
      await this.orchestrator.waitUntilReady(updated, this.readyTimeoutMs());
    } catch (error) {
      if (error instanceof CodeTooLargeError) throw new BadRequestException(error.message); // nothing was applied
      if (repairing) return this.keepFailedAttempt(function_, changes, changed, error, environmentChanges ? environment : undefined);
      return this.rollBack(function_, environment.before, error, changed);
    }

    const previousCodePath = this.codePath(function_);
    Object.assign(function_, changes, { status: FunctionStatus.ACTIVE, error: null });
    // The new version is live, and the record says so even when the new name went to another function meanwhile.
    const saved = await this.saveClaimingName(function_, previousName, 'keepOldName', environmentChanges ? environment.after : undefined);
    const nameLost = newName !== undefined && saved.name !== newName;
    await this.recordUpdate(saved, nameLost ? changed.filter((field) => field !== 'name') : changed, 'live', environment);
    await this.archiveCode(saved, previousCodePath);
    if (nameLost) {
      throw new ConflictException(
        `The new version is live, but the function keeps its name "${previousName}": another function was given the name "${newName}" meanwhile`,
      );
    }
    return { saved, environment: environment.after };
  }

  /**
   * Saves the function, and its new environment in the same transaction when
   * it has one. A new name is claimed with the account's row locked, as creates
   * do, so that two of its functions never share one. When another has it by
   * now, `refuse` saves nothing and answers 409, and `keepOldName` saves the
   * rest under the old name: a version already rolled out, which the record must
   * describe.
   */
  private saveClaimingName(function_: Function, previousName: string, whenTaken: WhenNameTaken, environment?: FunctionEnvironmentValues): Promise<Function> {
    if (function_.name === previousName && !environment) return this.functionsRepository.save(function_);
    return this.functionsRepository.manager.transaction(async (manager) => {
      if (function_.name !== previousName) {
        await lockAccount(manager, function_.accountId);
        if (await nameInUse(manager, function_.accountId, function_.name, function_.id)) {
          if (whenTaken === 'refuse') throw nameTaken(function_.name);
          function_.name = previousName;
        }
      }
      const saved = await manager.save(Function, function_);
      if (environment) await this.environments.save(saved, environment, manager);
      return saved;
    });
  }

  /**
   * A failed update of a working function: apply the previous version again,
   * with its environment, so the Deployment matches the record, and answer with
   * the diagnosis. If that fails too, the function is ERROR, with both messages.
   */
  private async rollBack(previous: Function, previousEnvironment: FunctionEnvironmentValues, error: unknown, changed: string[]): Promise<never> {
    const failure = callersFailure(error) ?? platformFailure(this.logger, 'Updating the function', error);
    this.logger.warn(`Update of function ${previous.id} failed, rolling back: ${describeError(error)}`);
    try {
      await this.plans.withTenant(previous.accountId, (tenant) => this.orchestrator.update(workloadOf(previous, previousEnvironment), tenant));
      await this.orchestrator.waitUntilReady(previous, this.readyTimeoutMs());
    } catch (rollbackError) {
      previous.status = FunctionStatus.ERROR;
      previous.error = `The update failed: ${clause(failure)}. ${platformFailure(this.logger, 'Rolling back to the previous version', rollbackError)}`;
      await this.functionsRepository.save(previous);
      await this.recordUpdate(previous, changed, 'failed, and so did the rollback: ERROR');
      await this.releaseInstances(previous);
      throw new InternalServerErrorException(previous.error);
    }
    throw failureResponse(error, `${clause(failure)}. The update was rolled back: the previous version is still live.`);
  }

  /**
   * A failed update of a function that wasn't ACTIVE: there is no working version
   * to go back to. Keep the attempt and its diagnosis, so the record shows the
   * code that failed and why, and release its instance, as a failed create does.
   * A new environment is kept with it: the Deployment holds that too.
   */
  private async keepFailedAttempt(
    function_: Function,
    changes: FieldChanges,
    changed: string[],
    error: unknown,
    environment?: EnvironmentChange,
  ): Promise<never> {
    const previousCodePath = this.codePath(function_);
    const previousName = function_.name;
    const failure = callersFailure(error) ?? platformFailure(this.logger, 'Updating the function', error);
    Object.assign(function_, changes, { status: FunctionStatus.ERROR, error: failure });
    // The attempt is what the Deployment holds: kept, under the old name if the new one went to another function meanwhile.
    const saved = await this.saveClaimingName(function_, previousName, 'keepOldName', environment?.after);
    const nameLost = changes.name !== undefined && changes.name !== previousName && saved.name === previousName;
    await this.recordUpdate(saved, nameLost ? changed.filter((field) => field !== 'name') : changed, 'failed, kept: ERROR', environment);
    await this.releaseInstances(saved);
    await this.archiveCode(saved, previousCodePath);
    const keptName = ` The function keeps its name "${previousName}": another function was given the name "${changes.name}" meanwhile.`;
    throw failureResponse(error, nameLost ? `${clause(failure)}.${keptName}` : failure);
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
    await this.audit.record({ accountId, action: 'function.delete', resource: `function:${id}`, details: { name: function_.name } });
  }

  /** Calls the function with `input` as its event, any JSON value, as AWS Lambda's Invoke does; {} when there is none. */
  async invoke(accountId: string, id: string, input?: unknown): Promise<FunctionInvocation> {
    const function_ = await this.findOne(accountId, id);
    if (function_.status !== FunctionStatus.ACTIVE) {
      throw new BadRequestException('Function is not active');
    }
    // D9: 402 once the balance has been below the buffer for the grace period. A refused call leaves no record.
    await this.credit.admit(accountId);

    const payload = input === undefined ? {} : input;
    // The history keeps a capped copy of the input, output and error (P-45); the caller gets them whole.
    const keptInput = keptJson(payload);
    const invocation = this.invocationsRepository.create({
      functionId: id,
      input: keptInput.value,
      inputTruncated: keptInput.truncated,
      status: InvocationStatus.RUNNING,
    });

    await this.invocationsRepository.save(invocation);

    // Counted while it runs: concurrency is the scaling signal, and a burst scales up at once (D14).
    this.metricsService.invocationStarted(function_);
    const startTime = Date.now();
    try {
      // The invocation's ID is the request's: the runtime logs it, and the usage record is keyed by it (D6).
      const result = await this.orchestrator.invoke(function_, payload, invocation.id);
      const duration = Date.now() - startTime;

      // Record metrics (end-to-end latency, as seen by callers)
      this.metricsService.recordMetric(id, duration, result.memoryUsedMb || 0, false);

      // Update invocation with results and metrics. Duration is the execution
      // time reported by the runtime (the basis for metering), else end-to-end
      // without the cold start, which isn't billed (D7).
      const keptOutput = keptJson(result.output);
      invocation.output = keptOutput.value;
      invocation.outputTruncated = keptOutput.truncated;
      invocation.duration = result.durationMs ?? Math.max(0, duration - (result.initMs ?? 0));
      invocation.memoryUsed = result.memoryUsedMb;
      invocation.status = InvocationStatus.COMPLETED;
      // Should this fail, the catch below ends the call as a platform failure, unbilled: its outcome couldn't be kept.
      await this.finish(function_, invocation, UsageStatus.SUCCESS, result.initMs);

      // The answer: the invocation as kept, with the input and output whole.
      return Object.assign(invocation, { input: payload, output: result.output });
    } catch (error) {
      const duration = Date.now() - startTime;
      this.metricsService.recordMetric(id, duration, 0, true);

      // The runtime measures a call that failed too; without its measure, end-to-end without the cold start.
      const measured = error instanceof FunctionRuntimeError ? error : undefined;
      invocation.duration = measured?.durationMs ?? Math.max(0, duration - (initMsOf(error) ?? 0));
      invocation.memoryUsed = measured?.memoryUsedMb;
      invocation.status =
        error instanceof FunctionTimeoutError
          ? InvocationStatus.TIMEOUT
          : error instanceof FunctionThrottledError
            ? InvocationStatus.THROTTLED // no instance could take it: not billed (D7)
            : InvocationStatus.ERROR;
      // The history is the account's to read: a platform failure is generic there too (D4).
      const visible = callersFailure(error) ?? platformFailure(this.logger, 'The invocation', error);
      const keptError = keptText(visible);
      invocation.error = keptError.value;
      invocation.errorTruncated = keptError.truncated;
      await this.finish(function_, invocation, failureStatus(error), initMsOf(error));
      throw failureResponse(error, visible);
    } finally {
      this.metricsService.invocationFinished(function_);
    }
  }

  /**
   * The invocation's final state and its usage record, in one transaction:
   * neither is written without the other (D6). The row is locked first, as
   * the reaper locks it: a call it already marked LOST (the backend was
   * stopped past the call's deadline) stays LOST, with the record it got.
   */
  private finish(function_: Function, invocation: FunctionInvocation, status: UsageStatus, initMs: number | undefined): Promise<void> {
    return this.invocationsRepository.manager.transaction(async (manager) => {
      const current = await manager.findOne(FunctionInvocation, { where: { id: invocation.id }, lock: { mode: 'pessimistic_write' } });
      if (current && current.status !== InvocationStatus.RUNNING) {
        this.logger.warn(`Invocation ${invocation.id} ended after it was marked ${current.status}, which stands`);
        return;
      }
      // Deleting the function during the call took its history along; the call ran all the same, and is billed.
      const endedAt = current ? (await manager.save(FunctionInvocation, invocation)).updatedAt : new Date();
      await this.usage.record(
        usageRecord(function_, {
          requestId: invocation.id,
          startedAt: invocation.createdAt,
          endedAt,
          status,
          durationMs: invocation.duration ?? 0,
          initMs,
        }),
        manager,
      );
    });
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
    refuseOverPlan(await this.plans.forAccount(accountId), changes, function_);
    const minInstances = changes.minInstances ?? function_.minInstances;
    const maxInstances = changes.maxInstances ?? function_.maxInstances;
    if (minInstances > maxInstances) {
      throw new BadRequestException(`minInstances (${minInstances}) can't be more than maxInstances (${maxInstances})`);
    }
    Object.assign(function_, { minInstances, maxInstances });
    const saved = await this.functionsRepository.save(function_);
    await this.audit.record({ accountId, action: 'function.scaling', resource: `function:${id}`, details: { minInstances, maxInstances } });
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

  /**
   * GET /functions/:id/logs (P-40): the account's function's newest lines,
   * read from its running instances. Another account's function is not found.
   * An instance's lines go with it, at scale to zero too, until the log store
   * keeps them (P-42), when `next` pages back through them (P-43).
   */
  /** A page of the function's log lines, from the log store, within its account's plan's retention (P-43). */
  async logs(accountId: string, id: string, request: FunctionLogsQuery): Promise<FunctionLogsView> {
    const function_ = await this.findOne(accountId, id);
    const plan = await this.plans.forAccount(accountId);
    const query = logsQuery(request, plan.limits.logRetentionDays, new Date());
    if (!query) return { lines: [], next: null };
    try {
      return await this.orchestrator.logs(function_, query);
    } catch (error) {
      if (error instanceof InvalidLogCursorError) throw new BadRequestException(error.message);
      if (error instanceof LogStoreUnavailableError) {
        // A platform failure: its details are for the server log only (D4).
        this.logger.error(`The logs of function ${id} could not be read: ${error.message}`);
        throw new ServiceUnavailableException('Logs are unavailable right now. Try again in a minute.');
      }
      throw error;
    }
  }

  /**
   * The function's live tail, as Server-Sent Events (P-43), until the client
   * goes, which aborts `signal`, or 30 minutes pass. Another account's function
   * answers 404, before any event. The stream starts at once: a store that can't
   * start the tail, or fails later, ends it with an `unavailable` event.
   */
  async liveLogs(accountId: string, id: string, request: FunctionLogsStreamQuery, signal: AbortSignal): Promise<Observable<MessageEvent>> {
    const function_ = await this.findOne(accountId, id);
    const lines = this.orchestrator.tailLogs(function_, { q: request.q, requestId: request.requestId }, signal);
    return liveTail(lines, (error) => this.logger.error(`The live tail of function ${id} stopped: ${describeError(error)}`));
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

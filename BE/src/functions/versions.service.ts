import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  PreconditionFailedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { describeError } from '../common/describe-error';
import { ORCHESTRATOR, Orchestrator } from '../orchestrator/orchestrator.types';
import { PackagesService } from '../packages/packages.service';
import { functionArn } from './arns';
import { FunctionVersionView, PublishVersionDto } from './dto/versions.dto';
import { Function, FunctionStatus, PackageType } from './entities/function.entity';
import { FunctionAlias } from './entities/function-alias.entity';
import { FunctionVersion } from './entities/function-version.entity';
import { EnvironmentDocument, sameVariables } from './environment';
import { EnvironmentStore } from './environment.store';
import { platformFailure } from './failures';
import { noSuchVersion } from './function-not-found';
import { FunctionsService } from './functions.service';
import { inlinePackage } from './inline-package';
import { lockedFunction } from './locked-function';

/** What a version freezes of its function, but its description and its environment. */
type Release = Pick<FunctionVersion, 'runtime' | 'handler' | 'packageType' | 'codeSha256' | 'memory' | 'timeout' | 'eventFormat' | 'awsEndpoints'>;

const secretValues = (environment: EnvironmentDocument): Record<string, string> =>
  Object.fromEntries(Object.entries(environment.secrets).map(([name, secret]) => [name, secret.value]));

/**
 * Whether a version holds what the function holds now: its code, its settings
 * and its environment, its secrets' values included. Its description doesn't
 * count, as Lambda's doesn't: a publish with nothing else changed answers the
 * last version.
 */
export function sameRelease(version: Release, versionEnvironment: EnvironmentDocument, function_: Release, environment: EnvironmentDocument): boolean {
  const same = (field: keyof Release) => String(version[field]) === String(function_[field]);
  return (
    (['runtime', 'handler', 'packageType', 'codeSha256', 'memory', 'timeout', 'eventFormat'] as const).every(same) &&
    [...version.awsEndpoints].sort().join() === [...function_.awsEndpoints].sort().join() &&
    sameVariables(versionEnvironment.variables, environment.variables) &&
    sameVariables(secretValues(versionEnvironment), secretValues(environment))
  );
}

/**
 * Why a function can't be published as it is, as Lambda refuses it: its code
 * not working, or not what the caller read. Undefined when it can.
 */
export function publishRefusal(function_: Pick<Function, 'status' | 'codeSha256' | 'revisionId'>, sent: PublishVersionDto): Error | undefined {
  if (function_.status === FunctionStatus.CREATING) return new ConflictException('The function is still being deployed: publish it once it is ACTIVE');
  if (function_.status !== FunctionStatus.ACTIVE) {
    return new ConflictException(`The function is ${function_.status}: it has no working code to publish. Fix it with PUT /functions/{id} first`);
  }
  if (sent.codeSha256 !== undefined && sent.codeSha256 !== function_.codeSha256) {
    return new BadRequestException(`codeSha256 ${sent.codeSha256} isn't the function's code's, ${function_.codeSha256}: publish with the function's, or none`);
  }
  if (sent.revisionId !== undefined && sent.revisionId !== function_.revisionId) {
    return new PreconditionFailedException(
      `revisionId ${sent.revisionId} isn't the function's, ${function_.revisionId}: another change came between. Read the function again, then publish`,
    );
  }
  return undefined;
}

/**
 * A function's versions, as AWS Lambda's: published from the function as
 * it is, numbered 1, 2, 3… under the function's lock, never a number twice;
 * listed, read with their variables, and deleted, each publish and deletion in
 * the audit log. A version holds its package, which the purge of unused
 * packages keeps while it is there, and runs in pods of its own, which its
 * deletion deletes.
 */
@Injectable()
export class FunctionVersionsService {
  private readonly logger = new Logger(FunctionVersionsService.name);
  private readonly region: string;

  constructor(
    @InjectRepository(FunctionVersion) private readonly versions: Repository<FunctionVersion>,
    private readonly functions: FunctionsService,
    private readonly environments: EnvironmentStore,
    private readonly packages: PackagesService,
    private readonly audit: AuditService,
    @Inject(ORCHESTRATOR) private readonly orchestrator: Orchestrator,
    config: ConfigService,
  ) {
    this.region = config.getOrThrow<string>('schedules.region');
  }

  /**
   * As Lambda's PublishVersion: a version of the function as it is now, or the
   * last one when nothing but the description changed since it.
   */
  async publish(accountId: string, id: string, sent: PublishVersionDto): Promise<FunctionVersionView> {
    const { published, made } = await this.versions.manager.transaction(async (manager) => {
      const function_ = await lockedFunction(manager, accountId, id);
      const refusal = publishRefusal(function_, sent);
      if (refusal) throw refusal;
      const environment = await this.environments.load(id, manager);
      const last = await manager
        .createQueryBuilder(FunctionVersion, 'v')
        .addSelect('v.environment')
        .where('v.functionId = :id', { id })
        .orderBy('v.version', 'DESC')
        .getOne();
      if (last && sameRelease(last, this.environments.openVersion(id, last.version, last.environment), function_, environment)) {
        return { published: this.view(function_, last), made: false };
      }
      const version = (function_.lastVersion ?? 0) + 1;
      // Not through the record, whose save would change its updatedAt: a publish changes nothing of the function's own.
      await manager.query('UPDATE "functions" SET "last_version" = $2 WHERE "id" = $1', [id, version]);
      const saved = await manager.save(
        manager.create(FunctionVersion, {
          functionId: id,
          version,
          accountId,
          description: sent.description ?? '',
          runtime: function_.runtime,
          handler: function_.handler,
          packageType: function_.packageType,
          code: function_.packageType === PackageType.INLINE ? function_.code : '',
          codeSha256: function_.codeSha256,
          codeSize: function_.codeSize,
          packageSha256: await this.packageOf(function_),
          memory: function_.memory,
          timeout: function_.timeout,
          eventFormat: function_.eventFormat,
          awsEndpoints: function_.awsEndpoints,
          environment: this.environments.sealVersion(id, version, environment),
        }),
      );
      await this.audit.record(
        {
          accountId,
          action: 'function.publish',
          resource: `function:${id}`,
          details: { version, codeSha256: saved.codeSha256, ...(saved.description ? { description: saved.description } : {}) },
        },
        manager,
      );
      return { published: this.view(function_, saved), made: true };
    });
    if (made) await this.labelLatest(accountId, id);
    return published;
  }

  /**
   * Starts moving $LATEST's pods onto a label of their own, so that a version's first call seldom waits for that
   * rollout. A failure is only logged: that call moves them then, waiting for it.
   */
  private async labelLatest(accountId: string, id: string): Promise<void> {
    try {
      await this.orchestrator.labelLatest({ id, accountId });
    } catch (error) {
      this.logger.warn(`Could not label function ${id}'s $LATEST pods after a publish, which its version's first call will do: ${describeError(error)}`);
    }
  }

  /** The function's versions, oldest first, as Lambda's ListVersionsByFunction lists them after $LATEST. */
  async list(accountId: string, id: string): Promise<FunctionVersionView[]> {
    const function_ = await this.functions.findOne(accountId, id);
    const versions = await this.versions.find({ where: { functionId: id }, order: { version: 'ASC' } });
    return versions.map((version) => this.view(function_, version));
  }

  /** A version, with its variables as they were published, never its secrets. */
  async get(accountId: string, id: string, number: number): Promise<FunctionVersionView> {
    const function_ = await this.functions.findOne(accountId, id);
    const version = await this.versions
      .createQueryBuilder('v')
      .addSelect('v.environment')
      .where('v.functionId = :id AND v.version = :number', { id, number })
      .getOne();
    if (!version) throw noSuchVersion(function_, number);
    const { variables } = this.environments.openVersion(id, number, version.environment);
    return { ...this.view(function_, version), environment: { ...variables } };
  }

  /** As Lambda's DeleteFunction of a version: it goes, its number never given again; refused while an alias names it. */
  async remove(accountId: string, id: string, number: number): Promise<void> {
    await this.versions.manager.transaction(async (manager) => {
      const function_ = await lockedFunction(manager, accountId, id);
      const naming = await manager.find(FunctionAlias, {
        where: [
          { functionId: id, version: number },
          { functionId: id, additionalVersion: number },
        ],
        order: { name: 'ASC' },
      });
      if (naming.length) throw namedByAliases(function_, number, naming.map((alias) => alias.name));
      const { affected } = await manager.delete(FunctionVersion, { functionId: id, version: number });
      if (!affected) throw noSuchVersion(function_, number);
      // Before the record goes: a failure keeps the version, to be deleted again.
      try {
        await this.orchestrator.removeVersion({ id, accountId, version: number });
      } catch (error) {
        throw new InternalServerErrorException(platformFailure(this.logger, 'Deleting the version', error));
      }
      await this.audit.record({ accountId, action: 'version.delete', resource: `function:${id}`, details: { version: number } }, manager);
    });
  }

  /**
   * The package a version's pods will run: the one the function's run. A
   * function whose inline code wasn't rolled out since packages came has none
   * yet: its one-file package is made and kept now, as a rollout would.
   */
  private async packageOf(function_: Function): Promise<string> {
    if (function_.packageSha256) return function_.packageSha256;
    if (function_.packageType === PackageType.ZIP) return function_.codeSha256;
    const built = inlinePackage(function_.code, function_.runtime);
    await this.packages.storeInline(function_.accountId, built);
    return built.codeSha256;
  }

  private view(function_: Pick<Function, 'accountId' | 'name'>, version: FunctionVersion): FunctionVersionView {
    return {
      functionId: version.functionId,
      functionArn: `${functionArn(this.region, function_.accountId, function_.name)}:${version.version}`,
      version: String(version.version),
      description: version.description,
      runtime: version.runtime,
      handler: version.handler,
      packageType: version.packageType,
      codeSha256: version.codeSha256,
      codeSize: version.codeSize,
      memory: version.memory,
      timeout: version.timeout,
      eventFormat: version.eventFormat,
      awsEndpoints: version.awsEndpoints,
      revisionId: version.revisionId,
      createdAt: version.createdAt,
    };
  }
}

/** As Lambda refuses to delete a version an alias names, with the aliases' names. */
export function namedByAliases(function_: Pick<Function, 'name'>, number: number, aliases: string[]): ConflictException {
  const [them, s] = aliases.length > 1 ? ['them', 'es'] : ['it', ''];
  return new ConflictException(
    `Version ${number} of the function ${function_.name} is named by its alias${s} ${aliases.join(', ')}: point ${them} at another version, or delete ${them}, first`,
  );
}

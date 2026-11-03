import { ConflictException, Injectable, NotFoundException, PreconditionFailedException, ValidationPipe } from '@nestjs/common';
import { DTO_VALIDATION } from '../common/validation';
import { FunctionAliasesService } from '../functions/aliases.service';
import { functionArn } from '../functions/arns';
import { ChangeUnderWayException, revisionMoved } from '../functions/change-under-way';
import { ALIAS_NAME, CreateAliasDto, FUNCTION_VERSION, FunctionAliasView, UpdateAliasDto, isVersionWeights } from '../functions/dto/aliases.dto';
import { PublishVersionDto } from '../functions/dto/versions.dto';
import { Function, FunctionStatus } from '../functions/entities/function.entity';
import { FunctionsService } from '../functions/functions.service';
import { LATEST } from '../functions/qualifier';
import { FunctionVersionsService } from '../functions/versions.service';
import { invalidParameterValue, resourceConflict, resourceNotFound } from './lambda-error';
import { refuseUnknownFields } from './lambda-function-requests';
import { latestConfiguration, versionConfiguration } from './lambda-functions';
import { LambdaAnswer, LambdaCall, LambdaCaller, LambdaHandler, LambdaHandlers, namedFunction, ok } from './lambda-operations';
import { pageOf } from './lambda-pages';

const DESCRIPTION_MAX = 256;

/** The fields each operation takes. */
const TAKEN = {
  PublishVersion: new Set(['CodeSha256', 'Description', 'RevisionId']),
  CreateAlias: new Set(['Name', 'FunctionVersion', 'Description', 'RoutingConfig']),
  UpdateAlias: new Set(['FunctionVersion', 'Description', 'RoutingConfig', 'RevisionId']),
};

/** A field sent as a string, as Lambda's model types it; undefined when not sent. */
function text(input: Record<string, unknown>, field: string, max?: number): string | undefined {
  const sent = input[field];
  if (sent === undefined) return undefined;
  if (typeof sent !== 'string') throw invalidParameterValue(`${field} must be a string.`);
  if (max !== undefined && sent.length > max) throw invalidParameterValue(`${field} must be at most ${max} characters.`);
  return sent;
}

/** What an alias points at: $LATEST, or a version by its number. */
function functionVersion(input: Record<string, unknown>): string | undefined {
  const sent = text(input, 'FunctionVersion');
  if (sent !== undefined && !FUNCTION_VERSION.test(sent)) throw invalidParameterValue(`FunctionVersion must be $LATEST or a version's number, not ${sent}.`);
  return sent;
}

/** Lambda's RoutingConfig as FF's: at most one other version, by its number, and its share of the alias's calls. */
function routingConfig(input: Record<string, unknown>): { additionalVersionWeights: Record<string, number> } | undefined {
  const sent = input.RoutingConfig;
  if (sent === undefined) return undefined;
  const weights = typeof sent === 'object' && sent !== null && !Array.isArray(sent) ? (sent as Record<string, unknown>).AdditionalVersionWeights ?? {} : undefined;
  const only = typeof sent === 'object' && sent !== null && Object.keys(sent).every((key) => key === 'AdditionalVersionWeights');
  if (!only || !isVersionWeights(weights)) {
    throw invalidParameterValue('RoutingConfig.AdditionalVersionWeights names at most one version, by its number, with its share of the calls from 0 to 1.');
  }
  return { additionalVersionWeights: weights };
}

/** An alias, as Lambda's AliasConfiguration. */
export function aliasConfiguration(alias: FunctionAliasView): Record<string, unknown> {
  return {
    AliasArn: alias.aliasArn,
    Name: alias.name,
    FunctionVersion: alias.functionVersion,
    Description: alias.description,
    ...(alias.routingConfig ? { RoutingConfig: { AdditionalVersionWeights: alias.routingConfig.additionalVersionWeights } } : {}),
    RevisionId: alias.revisionId,
  };
}

/**
 * Lambda's versions and aliases over FF's (ADR 0015): PublishVersion and ListVersionsByFunction; CreateAlias, GetAlias,
 * UpdateAlias with another version's share of the calls, DeleteAlias and ListAliases. Each names the function alone,
 * without a version or an alias; a version or an alias it hasn't is refused as Lambda refuses it, with its ARN.
 */
@Injectable()
export class LambdaVersions implements LambdaHandlers {
  private readonly validation = new ValidationPipe(DTO_VALIDATION);

  constructor(
    private readonly functions: FunctionsService,
    private readonly versions: FunctionVersionsService,
    private readonly aliases: FunctionAliasesService,
  ) {}

  readonly handlers: Record<string, LambdaHandler> = {
    PublishVersion: (call, caller) => this.publishVersion(call, caller),
    ListVersionsByFunction: (call, caller) => this.listVersions(call, caller),
    CreateAlias: (call, caller) => this.createAlias(call, caller),
    GetAlias: async (call, caller) => ok(aliasConfiguration(await this.alias(call, caller))),
    UpdateAlias: (call, caller) => this.updateAlias(call, caller),
    DeleteAlias: (call, caller) => this.deleteAlias(call, caller),
    ListAliases: (call, caller) => this.listAliases(call, caller),
  };

  /**
   * A version of the function as it is now, or its last one when nothing but the description changed since, as
   * Lambda's; refused while the function is created or changed, as Lambda refuses it, which the tools wait out.
   */
  private async publishVersion({ input, operation }: LambdaCall, caller: LambdaCaller): Promise<LambdaAnswer> {
    const function_ = this.unqualified(operation.name, caller);
    refuseUnknownFields(input, operation.name, TAKEN.PublishVersion);
    const sent = { codeSha256: text(input, 'CodeSha256'), description: text(input, 'Description', DESCRIPTION_MAX), revisionId: text(input, 'RevisionId') };
    if (function_.status === FunctionStatus.CREATING || this.functions.isChanging(function_)) throw new ChangeUnderWayException(function_);
    if (function_.status !== FunctionStatus.ACTIVE) {
      throw resourceConflict('The operation cannot be performed at this time. The function is currently in the following state: Failed');
    }
    if (sent.codeSha256 !== undefined && sent.codeSha256 !== function_.codeSha256) {
      throw invalidParameterValue(`CodeSHA256 (${sent.codeSha256}) is different from current CodeSHA256 in $LATEST (${function_.codeSha256}). Please try again.`);
    }
    if (sent.revisionId !== undefined && sent.revisionId !== function_.revisionId) throw revisionMoved(sent.revisionId, function_);
    const dto = (await this.validation.transform(defined(sent), { type: 'body', metatype: PublishVersionDto })) as PublishVersionDto;
    const published = await this.versions.publish(caller.accountId, function_.id, dto);
    return { status: 201, document: versionConfiguration(function_, await this.versions.get(caller.accountId, function_.id, Number(published.version))) };
  }

  /** $LATEST, then each version, oldest first, a page at a time, as Lambda lists them. */
  private async listVersions({ query, operation }: LambdaCall, caller: LambdaCaller): Promise<LambdaAnswer> {
    const function_ = this.unqualified(operation.name, caller);
    const numbers: Array<number | null> = [null, ...(await this.versions.list(caller.accountId, function_.id)).map((version) => Number(version.version))];
    const { page, nextMarker } = pageOf(query, numbers, (version) => [version], operation.name);
    const configurations = [];
    for (const version of page) {
      configurations.push(
        version === null
          ? latestConfiguration(function_, caller.region, (await this.functions.describe(caller.accountId, function_.id)).environment)
          : versionConfiguration(function_, await this.versions.get(caller.accountId, function_.id, version)),
      );
    }
    return ok({ Versions: configurations, ...(nextMarker !== undefined ? { NextMarker: nextMarker } : {}) });
  }

  private async createAlias({ input, operation }: LambdaCall, caller: LambdaCaller): Promise<LambdaAnswer> {
    const function_ = this.unqualified(operation.name, caller);
    refuseUnknownFields(input, operation.name, TAKEN.CreateAlias);
    const name = text(input, 'Name');
    if (name === undefined || !ALIAS_NAME.test(name)) {
      throw invalidParameterValue('Name must be 1 to 128 letters, digits, - and _, not digits alone, which name a version.');
    }
    const version = functionVersion(input);
    if (version === undefined) throw invalidParameterValue("CreateAlias needs FunctionVersion: $LATEST or a version's number.");
    const sent = { name, functionVersion: version, description: text(input, 'Description', DESCRIPTION_MAX), routingConfig: routingConfig(input) };
    await this.refuseMissingVersions(function_, caller, sent);
    const dto = (await this.validation.transform(defined(sent), { type: 'body', metatype: CreateAliasDto })) as CreateAliasDto;
    try {
      return { status: 201, document: aliasConfiguration(await this.aliases.create(caller.accountId, function_.id, dto)) };
    } catch (error) {
      // The one conflict a create meets: the name taken.
      if (error instanceof ConflictException) throw resourceConflict(`Alias already exists: ${this.aliasArn(function_, caller, name)}`);
      throw error;
    }
  }

  /** What the request sends changes, the rest stays; with RevisionId, only if the alias is still at it. */
  private async updateAlias(call: LambdaCall, caller: LambdaCaller): Promise<LambdaAnswer> {
    const { input, operation } = call;
    const alias = await this.alias(call, caller);
    const function_ = namedFunction(caller);
    refuseUnknownFields(input, operation.name, TAKEN.UpdateAlias);
    const sent = {
      functionVersion: functionVersion(input),
      description: text(input, 'Description', DESCRIPTION_MAX),
      routingConfig: routingConfig(input),
      revisionId: text(input, 'RevisionId'),
    };
    // Before FF's checks, which take a revision of FF's alone: any other is one another change came after.
    if (sent.revisionId !== undefined && sent.revisionId !== alias.revisionId) {
      throw new PreconditionFailedException(`RevisionId ${sent.revisionId} isn't the alias ${alias.name}'s, ${alias.revisionId}: another change came since it was read. Read the alias again, then change it`);
    }
    await this.refuseMissingVersions(function_, caller, sent);
    const dto = (await this.validation.transform(defined(sent), { type: 'body', metatype: UpdateAliasDto })) as UpdateAliasDto;
    return ok(aliasConfiguration(await this.aliases.update(caller.accountId, function_.id, alias.name, dto)));
  }

  /** The alias goes; the versions it named stay, as Lambda's. */
  private async deleteAlias(call: LambdaCall, caller: LambdaCaller): Promise<LambdaAnswer> {
    const alias = await this.alias(call, caller);
    await this.aliases.remove(caller.accountId, namedFunction(caller).id, alias.name);
    return { status: 204 };
  }

  /** The function's aliases, by name, a page at a time; with FunctionVersion, those that point at it. */
  private async listAliases({ query, operation }: LambdaCall, caller: LambdaCaller): Promise<LambdaAnswer> {
    const function_ = this.unqualified(operation.name, caller);
    const version = query.get('FunctionVersion');
    if (version !== null && !FUNCTION_VERSION.test(version)) throw invalidParameterValue(`FunctionVersion must be $LATEST or a version's number, not ${version}.`);
    const aliases = (await this.aliases.list(caller.accountId, function_.id)).filter((alias) => version === null || alias.functionVersion === version);
    const { page, nextMarker } = pageOf(query, aliases, (alias) => [alias.name], operation.name);
    return ok({ Aliases: page.map(aliasConfiguration), ...(nextMarker !== undefined ? { NextMarker: nextMarker } : {}) });
  }

  /** The alias the path names, after the function's name; one the function hasn't, as Lambda says it. */
  private async alias({ groups, operation }: LambdaCall, caller: LambdaCaller): Promise<FunctionAliasView> {
    const function_ = this.unqualified(operation.name, caller);
    const name = groups[1];
    try {
      return await this.aliases.get(caller.accountId, function_.id, name);
    } catch (error) {
      if (error instanceof NotFoundException) throw resourceNotFound(`Alias not found: ${this.aliasArn(function_, caller, name)}`);
      throw error;
    }
  }

  /** The versions an alias would name, each one the function has; one it hasn't, as Lambda says it, with its ARN. */
  private async refuseMissingVersions(
    function_: Function,
    caller: LambdaCaller,
    sent: { functionVersion?: string; routingConfig?: { additionalVersionWeights: Record<string, number> } },
  ): Promise<void> {
    const named = [sent.functionVersion, ...Object.keys(sent.routingConfig?.additionalVersionWeights ?? {})].filter(
      (version): version is string => version !== undefined && version !== LATEST,
    );
    if (named.length === 0) return;
    const published = new Set((await this.versions.list(caller.accountId, function_.id)).map((version) => version.version));
    const missing = named.find((version) => !published.has(version));
    if (missing !== undefined) throw resourceNotFound(`Function not found: ${functionArn(caller.region, caller.accountId, function_.name)}:${missing}`);
  }

  /** The function the request names, which these operations name without a version or an alias. */
  private unqualified(operation: string, caller: LambdaCaller): Function {
    const function_ = namedFunction(caller);
    const qualifier = caller.named?.qualifier;
    if (qualifier !== undefined) throw invalidParameterValue(`${operation} names the function alone, not its version or alias ${qualifier}: send ${function_.name}.`);
    return function_;
  }

  private aliasArn(function_: Function, caller: LambdaCaller, name: string): string {
    return `${functionArn(caller.region, caller.accountId, function_.name)}:${name}`;
  }
}

/** The fields sent, without those that weren't, for FF's checks of what is sent. */
function defined<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;
}

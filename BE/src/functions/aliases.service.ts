import { BadRequestException, ConflictException, Injectable, PreconditionFailedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { EntityManager, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { functionArn } from './arns';
import { AliasRoutingConfigDto, CreateAliasDto, FunctionAliasView, UpdateAliasDto } from './dto/aliases.dto';
import { FunctionAlias } from './entities/function-alias.entity';
import { FunctionVersion } from './entities/function-version.entity';
import { Function } from './entities/function.entity';
import { noSuchAlias, noSuchVersion } from './function-not-found';
import { FunctionsService } from './functions.service';
import { lockedFunction } from './locked-function';

const LATEST = '$LATEST';

/** Where an alias's calls go, as its row keeps it: a version, or null for $LATEST, and at most one more version with its share. */
export type Route = Pick<FunctionAlias, 'version' | 'additionalVersion' | 'additionalWeight'>;

/** A version's number as the API names it, or null for $LATEST. */
export const versionNumber = (functionVersion: string): number | null => (functionVersion === LATEST ? null : Number(functionVersion));

/** Another version's share of the calls as a request gives it, as the row keeps it; none when it names none. */
export function routingOf(config: AliasRoutingConfigDto): Pick<Route, 'additionalVersion' | 'additionalWeight'> {
  const [entry] = Object.entries(config.additionalVersionWeights);
  return entry ? { additionalVersion: Number(entry[0]), additionalWeight: entry[1] } : { additionalVersion: null, additionalWeight: null };
}

/**
 * Why an alias can't go where it would, as Lambda refuses it: another
 * version's share beside $LATEST, or beside that same version. Undefined when
 * it can; whether the versions it names exist is checked under the function's
 * lock.
 */
export function routeRefusal(route: Route): BadRequestException | undefined {
  if (route.additionalVersion === null) return undefined;
  if (route.version === null) {
    return new BadRequestException("An alias of $LATEST can't share its calls with another version, as on Lambda: point it at a published version first");
  }
  if (route.additionalVersion === route.version) {
    return new BadRequestException(`routingConfig names version ${route.version}, the alias's own: name another version, or none`);
  }
  return undefined;
}

/** Where an alias's calls go, as the audit log says it. */
const routeOf = (route: Route) => ({
  version: route.version === null ? LATEST : String(route.version),
  ...(route.additionalVersion !== null ? { additionalVersion: String(route.additionalVersion), additionalWeight: route.additionalWeight } : {}),
});

/**
 * A function's aliases, as AWS Lambda's: made, changed and deleted under the
 * function's lock, as its versions are published and deleted, so that every
 * version an alias names is there; each change in the audit log. Calls don't
 * come through them yet: they name what will run.
 */
@Injectable()
export class FunctionAliasesService {
  private readonly region: string;

  constructor(
    @InjectRepository(FunctionAlias) private readonly aliases: Repository<FunctionAlias>,
    private readonly functions: FunctionsService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.region = config.getOrThrow<string>('schedules.region');
  }

  /** As Lambda's CreateAlias: a name the function hasn't yet. */
  async create(accountId: string, id: string, sent: CreateAliasDto): Promise<FunctionAliasView> {
    return this.aliases.manager.transaction(async (manager) => {
      const function_ = await lockedFunction(manager, accountId, id);
      const route: Route = { version: versionNumber(sent.functionVersion), ...(sent.routingConfig ? routingOf(sent.routingConfig) : { additionalVersion: null, additionalWeight: null }) };
      await refuseRoute(manager, function_, route);
      if (await manager.existsBy(FunctionAlias, { functionId: id, name: sent.name })) {
        throw new ConflictException(`The function ${function_.name} has an alias ${sent.name} already: PUT /functions/{id}/aliases/${sent.name} changes it`);
      }
      const saved = await manager.save(manager.create(FunctionAlias, { functionId: id, name: sent.name, accountId, ...route, description: sent.description ?? '' }));
      await this.audit.record({ accountId, action: 'alias.create', resource: `function:${id}`, details: { name: saved.name, ...routeOf(saved) } }, manager);
      return this.view(function_, saved);
    });
  }

  /** The function's aliases, by name. */
  async list(accountId: string, id: string): Promise<FunctionAliasView[]> {
    const function_ = await this.functions.findOne(accountId, id);
    const aliases = await this.aliases.find({ where: { functionId: id }, order: { name: 'ASC' } });
    return aliases.map((alias) => this.view(function_, alias));
  }

  async get(accountId: string, id: string, name: string): Promise<FunctionAliasView> {
    const function_ = await this.functions.findOne(accountId, id);
    const alias = await this.aliases.findOne({ where: { functionId: id, name } });
    if (!alias) throw noSuchAlias(function_, name);
    return this.view(function_, alias);
  }

  /**
   * As Lambda's UpdateAlias: what the request names changes, the rest stays;
   * a new revision when anything did.
   */
  async update(accountId: string, id: string, name: string, sent: UpdateAliasDto): Promise<FunctionAliasView> {
    return this.aliases.manager.transaction(async (manager) => {
      const function_ = await lockedFunction(manager, accountId, id);
      const alias = await manager.findOne(FunctionAlias, { where: { functionId: id, name } });
      if (!alias) throw noSuchAlias(function_, name);
      if (sent.revisionId !== undefined && sent.revisionId !== alias.revisionId) {
        throw new PreconditionFailedException(
          `revisionId ${sent.revisionId} isn't the alias's, ${alias.revisionId}: another change came between. Read the alias again, then change it`,
        );
      }
      const route: Route = {
        version: sent.functionVersion !== undefined ? versionNumber(sent.functionVersion) : alias.version,
        ...(sent.routingConfig ? routingOf(sent.routingConfig) : { additionalVersion: alias.additionalVersion, additionalWeight: alias.additionalWeight }),
      };
      await refuseRoute(manager, function_, route);
      const description = sent.description ?? alias.description;
      const before = routeOf(alias);
      const unchanged = (['version', 'additionalVersion', 'additionalWeight'] as const).every((field) => route[field] === alias[field]) && description === alias.description;
      if (unchanged) return this.view(function_, alias);
      const saved = await manager.save(Object.assign(alias, route, { description, revisionId: randomUUID() }));
      await this.audit.record({ accountId, action: 'alias.update', resource: `function:${id}`, details: { name, before, after: routeOf(saved) } }, manager);
      return this.view(function_, saved);
    });
  }

  /** As Lambda's DeleteAlias: the versions it named stay. */
  async remove(accountId: string, id: string, name: string): Promise<void> {
    await this.aliases.manager.transaction(async (manager) => {
      const function_ = await lockedFunction(manager, accountId, id);
      const { affected } = await manager.delete(FunctionAlias, { functionId: id, name });
      if (!affected) throw noSuchAlias(function_, name);
      await this.audit.record({ accountId, action: 'alias.delete', resource: `function:${id}`, details: { name } }, manager);
    });
  }

  private view(function_: Pick<Function, 'accountId' | 'name'>, alias: FunctionAlias): FunctionAliasView {
    return {
      aliasArn: `${functionArn(this.region, function_.accountId, function_.name)}:${alias.name}`,
      name: alias.name,
      functionVersion: alias.version === null ? LATEST : String(alias.version),
      description: alias.description,
      ...(alias.additionalVersion !== null ? { routingConfig: { additionalVersionWeights: { [String(alias.additionalVersion)]: alias.additionalWeight as number } } } : {}),
      revisionId: alias.revisionId,
      createdAt: alias.createdAt,
      updatedAt: alias.updatedAt,
    };
  }
}

/** Refuses a route Lambda refuses, or one naming a version the function hasn't; the function's lock keeps the versions as they are. */
async function refuseRoute(manager: EntityManager, function_: Function, route: Route): Promise<void> {
  const refusal = routeRefusal(route);
  if (refusal) throw refusal;
  for (const version of [route.version, route.additionalVersion]) {
    if (version !== null && !(await manager.existsBy(FunctionVersion, { functionId: function_.id, version }))) throw noSuchVersion(function_, version);
  }
}

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, QueryDeepPartialEntity, QueryFailedError, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { wrappedIn } from '../functions/aliases.service';
import { FunctionAlias } from '../functions/entities/function-alias.entity';
import { EventFormat, Function } from '../functions/entities/function.entity';
import { FunctionUrl, UrlCors, UrlInvokeMode } from '../functions/entities/function-url.entity';
import { noSuchAlias } from '../functions/function-not-found';
import { FunctionsService } from '../functions/functions.service';
import { CreateFunctionUrlDto, FunctionUrlView, UpdateFunctionUrlDto } from './dto/function-url.dto';
import { newUrlId, urlAddress } from './url-address';

/** PostgreSQL's unique_violation: another request gave the function its URL first. */
const UNIQUE_VIOLATION = '23505';

/** A URL sends AWS Lambda's events, which a function that takes FF's original wrapped event can't read. */
export const WRAPPED_FUNCTION_REFUSAL =
  "A function URL sends AWS Lambda's events, and this function takes FF's original wrapped event: switch its eventFormat to lambda " +
  '(PUT /functions/{id} with {"eventFormat": "lambda"}), and read the event as AWS Lambda passes it, then create its URL';

/** What an alias's URL would call takes FF's original wrapped event: one of the versions its calls go to, or $LATEST. */
const wrappedAliasRefusal = (alias: string, ran: string) =>
  `A function URL sends AWS Lambda's events, and the alias ${alias} names ${ran}, which takes FF's original wrapped event: ` +
  'point the alias at a version published with eventFormat lambda, then create its URL';

/** The CORS fields given, and only those: a configuration without any is still one, which allows no origin. */
function corsOf(cors: UrlCors | null | undefined): UrlCors | null {
  if (!cors) return null;
  const fields = ['allowCredentials', 'allowHeaders', 'allowMethods', 'allowOrigins', 'exposeHeaders', 'maxAge'] as const;
  return Object.fromEntries(fields.filter((field) => cors[field] !== undefined).map((field) => [field, cors[field]]));
}

/**
 * Functions' URLs, as AWS Lambda's function URL configurations: one for
 * $LATEST and one for each alias, as Lambda's Qualifier names it, created,
 * read, changed and deleted by its account, the changes in its audit log.
 * Another account's function is not found, as everywhere.
 */
@Injectable()
export class FunctionUrlsService {
  constructor(
    @InjectRepository(FunctionUrl) private readonly urls: Repository<FunctionUrl>,
    private readonly functions: FunctionsService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  /** The URL as the API answers it. */
  view(url: FunctionUrl): FunctionUrlView {
    return {
      functionUrl: urlAddress(this.config.getOrThrow<string>('functionUrls.base'), url.urlId),
      functionId: url.functionId,
      alias: url.alias,
      authType: url.authType,
      cors: url.cors,
      invokeMode: url.invokeMode,
      createdAt: url.createdAt,
      updatedAt: url.updatedAt,
    };
  }

  /** The URL a request's host names, for the gateway; null when none has the ID. */
  forUrlId(urlId: string): Promise<FunctionUrl | null> {
    return this.urls.findOne({ where: { urlId } });
  }

  /** The function's $LATEST URL, if it has one, for pages that show it. */
  async find(functionId: string): Promise<FunctionUrlView | null> {
    const url = await this.urls.findOne({ where: { functionId, alias: IsNull() } });
    return url ? this.view(url) : null;
  }

  async get(accountId: string, functionId: string, alias?: string): Promise<FunctionUrlView> {
    return this.view(await this.urlOf(accountId, functionId, alias));
  }

  /** As Lambda's ListFunctionUrlConfigs: the function's URLs, $LATEST's first, then its aliases' by name. */
  async list(accountId: string, functionId: string): Promise<FunctionUrlView[]> {
    await this.functions.findOne(accountId, functionId);
    const urls = await this.urls.find({ where: { functionId, accountId } });
    return urls.sort((a, b) => (a.alias === null ? -1 : b.alias === null ? 1 : a.alias.localeCompare(b.alias))).map((url) => this.view(url));
  }

  /** Gives the function, or its alias, its URL, at a new random address. */
  async create(accountId: string, functionId: string, dto: CreateFunctionUrlDto, alias?: string): Promise<FunctionUrlView> {
    const function_ = await this.functions.findOne(accountId, functionId);
    await this.refuseWrapped(function_, alias);
    if (await this.urls.existsBy({ functionId, alias: alias ?? IsNull() })) throw alreadyHasOne(alias);
    const url = this.urls.create({
      functionId,
      alias: alias ?? null,
      accountId,
      urlId: newUrlId(),
      authType: dto.authType,
      cors: corsOf(dto.cors),
      invokeMode: dto.invokeMode ?? UrlInvokeMode.BUFFERED,
    });
    try {
      await this.urls.insert(url as QueryDeepPartialEntity<FunctionUrl>);
    } catch (error) {
      // Two requests at once: a function's or an alias's URL is its own once by the table's unique indexes, so the second one fails here.
      if (error instanceof QueryFailedError && (error.driverError as { code?: string })?.code === UNIQUE_VIOLATION) throw alreadyHasOne(alias);
      throw error;
    }
    await this.audit.record({
      accountId,
      action: 'function_url.create',
      resource: `function:${functionId}`,
      details: { ...aliasDetail(url), authType: url.authType, cors: url.cors !== null },
    });
    return this.view(url);
  }

  /** Changes what is given: what is left out stays, and cors null removes it. The address stays. */
  async update(accountId: string, functionId: string, dto: UpdateFunctionUrlDto, alias?: string): Promise<FunctionUrlView> {
    const url = await this.urlOf(accountId, functionId, alias);
    const changed: string[] = [];
    if (dto.authType !== undefined && dto.authType !== url.authType) changed.push('authType');
    if (dto.cors !== undefined && JSON.stringify(corsOf(dto.cors)) !== JSON.stringify(url.cors)) changed.push('cors');
    if (dto.invokeMode !== undefined && dto.invokeMode !== url.invokeMode) changed.push('invokeMode');
    if (changed.length === 0) return this.view(url);
    Object.assign(url, {
      authType: dto.authType ?? url.authType,
      cors: dto.cors === undefined ? url.cors : corsOf(dto.cors),
      invokeMode: dto.invokeMode ?? url.invokeMode,
    });
    const saved = await this.urls.save(url);
    await this.audit.record({
      accountId,
      action: 'function_url.update',
      resource: `function:${functionId}`,
      details: { ...aliasDetail(saved), changed, authType: saved.authType, cors: saved.cors !== null },
    });
    return this.view(saved);
  }

  /** Deletes the URL: its address answers 404 at once, and a new URL gets another. */
  async remove(accountId: string, functionId: string, alias?: string): Promise<void> {
    const url = await this.urlOf(accountId, functionId, alias);
    await this.urls.delete({ urlId: url.urlId });
    await this.audit.record({
      accountId,
      action: 'function_url.delete',
      resource: `function:${functionId}`,
      details: { ...aliasDetail(url), functionUrl: this.view(url).functionUrl },
    });
  }

  /**
   * The account's function's URL, $LATEST's or its alias's; 404 for another account's function, for an alias it
   * hasn't, and for a function or an alias without one.
   */
  async urlOf(accountId: string, functionId: string, alias?: string): Promise<FunctionUrl> {
    const function_ = await this.functions.findOne(accountId, functionId);
    const url = await this.urls.findOne({ where: { functionId, accountId, alias: alias ?? IsNull() } });
    if (url) return url;
    if (alias === undefined) throw new NotFoundException(`Function ${functionId} has no URL: create one with POST /functions/${functionId}/url`);
    if (!(await this.urls.manager.existsBy(FunctionAlias, { functionId, name: alias }))) throw noSuchAlias(function_, alias);
    throw new NotFoundException(`The alias ${alias} has no URL: create one with POST /functions/${functionId}/url?qualifier=${alias}`);
  }

  /**
   * Refuses a URL to what takes FF's original wrapped event, which a URL can't send: the function, for $LATEST's URL;
   * for an alias's, each version its calls go to, or $LATEST when it names it. 404 for an alias the function hasn't.
   */
  private async refuseWrapped(function_: Function, alias: string | undefined): Promise<void> {
    if (alias === undefined) {
      if (function_.eventFormat === EventFormat.WRAPPED) throw new BadRequestException(WRAPPED_FUNCTION_REFUSAL);
      return;
    }
    const named = await this.urls.manager.findOne(FunctionAlias, { where: { functionId: function_.id, name: alias } });
    if (!named) throw noSuchAlias(function_, alias);
    const wrapped = await wrappedIn(this.urls.manager, function_, named);
    if (wrapped) throw new BadRequestException(wrappedAliasRefusal(alias, wrapped));
  }
}

/** What the audit log says of whose URL it is: its alias, when it is one's. */
const aliasDetail = (url: FunctionUrl) => (url.alias === null ? {} : { alias: url.alias });

function alreadyHasOne(alias: string | undefined): ConflictException {
  return new ConflictException(
    alias === undefined
      ? 'The function already has a URL, and a function has one at most for $LATEST: change it with PUT, or delete it first'
      : `The alias ${alias} already has a URL, and an alias has one at most: change it with PUT, or delete it first`,
  );
}

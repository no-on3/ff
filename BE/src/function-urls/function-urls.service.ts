import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryDeepPartialEntity, QueryFailedError, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { EventFormat } from '../functions/entities/function.entity';
import { FunctionUrl, UrlCors, UrlInvokeMode } from '../functions/entities/function-url.entity';
import { FunctionsService } from '../functions/functions.service';
import { CreateFunctionUrlDto, FunctionUrlView, UpdateFunctionUrlDto } from './dto/function-url.dto';
import { newUrlId, urlAddress } from './url-address';

/** PostgreSQL's unique_violation: another request gave the function its URL first. */
const UNIQUE_VIOLATION = '23505';

/** A URL sends AWS Lambda's events, which a function that takes FF's original wrapped event can't read. */
export const WRAPPED_FUNCTION_REFUSAL =
  "A function URL sends AWS Lambda's events, and this function takes FF's original wrapped event: switch its eventFormat to lambda " +
  '(PUT /functions/{id} with {"eventFormat": "lambda"}), and read the event as AWS Lambda passes it, then create its URL';

/** The CORS fields given, and only those: a configuration without any is still one, which allows no origin. */
function corsOf(cors: UrlCors | null | undefined): UrlCors | null {
  if (!cors) return null;
  const fields = ['allowCredentials', 'allowHeaders', 'allowMethods', 'allowOrigins', 'exposeHeaders', 'maxAge'] as const;
  return Object.fromEntries(fields.filter((field) => cors[field] !== undefined).map((field) => [field, cors[field]]));
}

/**
 * Functions' URLs, as AWS Lambda's function URL configurations: one per
 * function, created, read, changed and deleted by its account, the changes in
 * its audit log. Another account's function is not found, as everywhere.
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

  /** The function's URL, if it has one, for pages that show it. */
  async find(functionId: string): Promise<FunctionUrlView | null> {
    const url = await this.urls.findOne({ where: { functionId } });
    return url ? this.view(url) : null;
  }

  async get(accountId: string, functionId: string): Promise<FunctionUrlView> {
    return this.view(await this.urlOf(accountId, functionId));
  }

  /** Gives the function its URL, at a new random address. */
  async create(accountId: string, functionId: string, dto: CreateFunctionUrlDto): Promise<FunctionUrlView> {
    const function_ = await this.functions.findOne(accountId, functionId);
    if (function_.eventFormat === EventFormat.WRAPPED) throw new BadRequestException(WRAPPED_FUNCTION_REFUSAL);
    if (await this.urls.existsBy({ functionId })) throw alreadyHasOne();
    const url = this.urls.create({
      functionId,
      accountId,
      urlId: newUrlId(),
      authType: dto.authType,
      cors: corsOf(dto.cors),
      invokeMode: dto.invokeMode ?? UrlInvokeMode.BUFFERED,
    });
    try {
      await this.urls.insert(url as QueryDeepPartialEntity<FunctionUrl>);
    } catch (error) {
      // Two requests at once: the function's ID is the table's key, so the second one fails here.
      if (error instanceof QueryFailedError && (error.driverError as { code?: string })?.code === UNIQUE_VIOLATION) throw alreadyHasOne();
      throw error;
    }
    await this.audit.record({
      accountId,
      action: 'function_url.create',
      resource: `function:${functionId}`,
      details: { authType: url.authType, cors: url.cors !== null },
    });
    return this.view(url);
  }

  /** Changes what is given: what is left out stays, and cors null removes it. The address stays. */
  async update(accountId: string, functionId: string, dto: UpdateFunctionUrlDto): Promise<FunctionUrlView> {
    const url = await this.urlOf(accountId, functionId);
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
      details: { changed, authType: saved.authType, cors: saved.cors !== null },
    });
    return this.view(saved);
  }

  /** Deletes the URL: its address answers 404 at once, and a new URL gets another. */
  async remove(accountId: string, functionId: string): Promise<void> {
    const url = await this.urlOf(accountId, functionId);
    await this.urls.delete({ functionId });
    await this.audit.record({
      accountId,
      action: 'function_url.delete',
      resource: `function:${functionId}`,
      details: { functionUrl: this.view(url).functionUrl },
    });
  }

  private async urlOf(accountId: string, functionId: string): Promise<FunctionUrl> {
    await this.functions.findOne(accountId, functionId);
    const url = await this.urls.findOne({ where: { functionId, accountId } });
    if (!url) throw new NotFoundException(`Function ${functionId} has no URL: create one with POST /functions/${functionId}/url`);
    return url;
  }
}

function alreadyHasOne(): ConflictException {
  return new ConflictException('The function already has a URL, and a function has one at most: change it with PUT, or delete it first');
}

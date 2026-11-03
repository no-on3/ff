import { ConflictException, Injectable, NotFoundException, ValidationPipe } from '@nestjs/common';
import { DTO_VALIDATION } from '../common/validation';
import { FunctionAliasesService } from '../functions/aliases.service';
import { qualifiedFunctionArn } from '../functions/arns';
import { ALIAS_NAME } from '../functions/dto/aliases.dto';
import { UrlAuthType, UrlCors, UrlInvokeMode } from '../functions/entities/function-url.entity';
import { CreateFunctionUrlDto, FunctionUrlView, UpdateFunctionUrlDto } from '../function-urls/dto/function-url.dto';
import { FunctionUrlsService } from '../function-urls/function-urls.service';
import { invalidParameterValue, resourceConflict, resourceNotFound } from './lambda-error';
import { defined, isObject, oneOf, refuseUnknownFields } from './lambda-fields';
import { LambdaAnswer, LambdaCall, LambdaCaller, LambdaHandler, LambdaHandlers, namedFunction, ok, unqualifiedFunction } from './lambda-operations';
import { pageOf } from './lambda-pages';

/** The fields CreateFunctionUrlConfig and UpdateFunctionUrlConfig take. */
const TAKEN = new Set(['AuthType', 'Cors', 'InvokeMode']);

/** Lambda's Cors fields, and FF's name for each. */
const CORS_FIELDS: Record<string, keyof UrlCors> = {
  AllowCredentials: 'allowCredentials',
  AllowHeaders: 'allowHeaders',
  AllowMethods: 'allowMethods',
  AllowOrigins: 'allowOrigins',
  ExposeHeaders: 'exposeHeaders',
  MaxAge: 'maxAge',
};

/** The most ListFunctionUrlConfigs gives at once, as Lambda's. */
const URL_PAGE_MAX = 50;

/** What Lambda answers for a function, or an alias, without a URL. */
const NO_URL = 'The resource you requested does not exist.';

/** Lambda's Cors as FF's: its fields renamed, any other refused; FF's checks of each follow. */
function corsOf(input: Record<string, unknown>): UrlCors | undefined {
  const sent = input.Cors;
  if (sent === undefined) return undefined;
  if (!isObject(sent)) throw invalidParameterValue('Cors must be an object.');
  const unknown = Object.keys(sent).filter((field) => !(field in CORS_FIELDS));
  if (unknown.length > 0) throw invalidParameterValue(`Cors takes ${Object.keys(CORS_FIELDS).join(', ')}, not ${unknown.join(', ')}.`);
  return Object.fromEntries(Object.entries(sent).map(([field, value]) => [CORS_FIELDS[field], value]));
}

/** A URL's configuration, as Lambda's FunctionUrlConfig; LastModifiedTime but at its creation, as Lambda's. */
function urlConfiguration(url: FunctionUrlView, functionArn: string, created = false): Record<string, unknown> {
  const cors = url.cors
    ? Object.fromEntries(Object.entries(CORS_FIELDS).flatMap(([lambdas, ffs]) => (url.cors?.[ffs] === undefined ? [] : [[lambdas, url.cors[ffs]]])))
    : undefined;
  return {
    FunctionUrl: url.functionUrl,
    FunctionArn: functionArn,
    AuthType: url.authType,
    ...(cors ? { Cors: cors } : {}),
    CreationTime: new Date(url.createdAt).toISOString(),
    ...(created ? {} : { LastModifiedTime: new Date(url.updatedAt).toISOString() }),
    InvokeMode: url.invokeMode,
  };
}

/**
 * Lambda's function URLs over FF's (ADR 0014): CreateFunctionUrlConfig, GetFunctionUrlConfig,
 * UpdateFunctionUrlConfig and DeleteFunctionUrlConfig, $LATEST's URL or an alias's, as Qualifier names it;
 * ListFunctionUrlConfigs, the function's. A version has no URL of its own, as on Lambda: an alias names it.
 */
@Injectable()
export class LambdaUrls implements LambdaHandlers {
  private readonly validation = new ValidationPipe(DTO_VALIDATION);

  constructor(
    private readonly urls: FunctionUrlsService,
    private readonly aliases: FunctionAliasesService,
  ) {}

  readonly handlers: Record<string, LambdaHandler> = {
    CreateFunctionUrlConfig: (call, caller) => this.create(call, caller),
    GetFunctionUrlConfig: async (call, caller) => {
      const alias = await this.aliasOf(caller);
      return ok(urlConfiguration(await this.withUrl(() => this.urls.get(caller.accountId, namedFunction(caller).id, alias)), this.arnOf(caller, alias)));
    },
    UpdateFunctionUrlConfig: (call, caller) => this.update(call, caller),
    DeleteFunctionUrlConfig: async (call, caller) => {
      const alias = await this.aliasOf(caller);
      await this.withUrl(() => this.urls.remove(caller.accountId, namedFunction(caller).id, alias));
      return { status: 204 };
    },
    ListFunctionUrlConfigs: (call, caller) => this.list(call, caller),
  };

  /** A new URL, at a random address; one the function, or the alias, has already refused as Lambda refuses it. */
  private async create({ input, operation }: LambdaCall, caller: LambdaCaller): Promise<LambdaAnswer> {
    const alias = await this.aliasOf(caller);
    refuseUnknownFields(input, operation.name, TAKEN);
    const authType = this.authType(input);
    if (authType === undefined) throw invalidParameterValue('CreateFunctionUrlConfig needs AuthType: NONE or AWS_IAM.');
    const sent = { authType, cors: corsOf(input), invokeMode: this.invokeMode(input) };
    const dto = (await this.validation.transform(defined(sent), { type: 'body', metatype: CreateFunctionUrlDto })) as CreateFunctionUrlDto;
    const arn = this.arnOf(caller, alias);
    try {
      return { status: 201, document: urlConfiguration(await this.urls.create(caller.accountId, namedFunction(caller).id, dto, alias), arn, true) };
    } catch (error) {
      // The one conflict a create meets: the URL there already.
      if (error instanceof ConflictException) throw resourceConflict(`Failed to create function url config for [functionArn = ${arn}]. Error message: FunctionUrlConfig exists for this Lambda function`);
      throw error;
    }
  }

  /** What the request sends changes, the rest stays; the address stays. */
  private async update({ input, operation }: LambdaCall, caller: LambdaCaller): Promise<LambdaAnswer> {
    const alias = await this.aliasOf(caller);
    refuseUnknownFields(input, operation.name, TAKEN);
    const sent = { authType: this.authType(input), cors: corsOf(input), invokeMode: this.invokeMode(input) };
    const dto = (await this.validation.transform(defined(sent), { type: 'body', metatype: UpdateFunctionUrlDto })) as UpdateFunctionUrlDto;
    const updated = await this.withUrl(() => this.urls.update(caller.accountId, namedFunction(caller).id, dto, alias));
    return ok(urlConfiguration(updated, this.arnOf(caller, alias)));
  }

  /** The function's URLs, $LATEST's first, then its aliases' by name, a page at a time; named without a qualifier. */
  private async list({ query, operation }: LambdaCall, caller: LambdaCaller): Promise<LambdaAnswer> {
    const function_ = unqualifiedFunction(caller, operation.name);
    const urls = await this.urls.list(caller.accountId, function_.id);
    const { page, nextMarker } = pageOf(query, urls, (url) => [url.alias], operation.name, URL_PAGE_MAX);
    return ok({
      FunctionUrlConfigs: page.map((url) => urlConfiguration(url, this.arnOf(caller, url.alias ?? undefined))),
      ...(nextMarker !== undefined ? { NextMarker: nextMarker } : {}),
    });
  }

  private authType(input: Record<string, unknown>): UrlAuthType | undefined {
    return oneOf(input, 'AuthType', Object.values(UrlAuthType));
  }

  private invokeMode(input: Record<string, unknown>): UrlInvokeMode | undefined {
    return oneOf(input, 'InvokeMode', Object.values(UrlInvokeMode), ": FF doesn't stream answers");
  }

  /**
   * The alias whose URL the request means, as its Qualifier or its name's names it; undefined for $LATEST's. A
   * version, which has no URL, and an alias the function hasn't, refused as Lambda refuses them.
   */
  private async aliasOf(caller: LambdaCaller): Promise<string | undefined> {
    const function_ = namedFunction(caller);
    const qualifier = caller.named?.qualifier;
    if (qualifier === undefined) return undefined;
    if (!ALIAS_NAME.test(qualifier)) {
      throw invalidParameterValue(`A function URL is $LATEST's or an alias's, and ${qualifier} is a version's number: name the version through an alias.`);
    }
    try {
      await this.aliases.get(caller.accountId, function_.id, qualifier);
    } catch (error) {
      if (error instanceof NotFoundException) throw resourceNotFound(`Function not found: ${this.arnOf(caller, qualifier)}`);
      throw error;
    }
    return qualifier;
  }

  /** What `act` gives, the URL it needs missing as Lambda says it. */
  private async withUrl<T>(act: () => Promise<T>): Promise<T> {
    try {
      return await act();
    } catch (error) {
      // The function and the alias were found: what is missing is the URL.
      if (error instanceof NotFoundException) throw resourceNotFound(NO_URL);
      throw error;
    }
  }

  private arnOf(caller: LambdaCaller, alias: string | undefined): string {
    return qualifiedFunctionArn(caller.region, caller.accountId, namedFunction(caller).name, alias);
  }
}

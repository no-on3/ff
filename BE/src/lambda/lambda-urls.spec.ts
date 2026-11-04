/**
 * L1: Lambda's function URLs over FF's: CreateFunctionUrlConfig,
 * GetFunctionUrlConfig, UpdateFunctionUrlConfig, DeleteFunctionUrlConfig for
 * $LATEST's URL or an alias's, as Qualifier names it, and
 * ListFunctionUrlConfigs, in Lambda's shape; what they send checked under
 * Lambda's names, and refused as Lambda refuses.
 */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { FunctionAliasesService } from '../functions/aliases.service';
import { Function } from '../functions/entities/function.entity';
import { UrlAuthType, UrlInvokeMode } from '../functions/entities/function-url.entity';
import { FunctionUrlView } from '../function-urls/dto/function-url.dto';
import { FunctionUrlsService } from '../function-urls/function-urls.service';
import { LambdaUrls } from './lambda-urls';
import { ACCOUNT, REGION, lambdaCall, lambdaCaller, refused } from './test-fixtures';

const ARN = `arn:aws:lambda:${REGION}:${ACCOUNT}:function:orders`;
const URL = '/2021-10-31/functions/orders/url';
const CREATED = new Date('2026-11-01T08:00:00.000Z');
const CHANGED = new Date('2026-11-02T09:30:00.000Z');

/** What a DTO sets, as FF's service reads it: the fields left out stay as they were. */
const set = (dto: object): Partial<FunctionUrlView> => Object.fromEntries(Object.entries(dto).filter(([, value]) => value !== undefined));

const urlOf = (alias: string | null, more: Partial<FunctionUrlView> = {}): FunctionUrlView => ({
  functionUrl: `https://${(alias ?? 'latest').padEnd(32, '0')}.fn.example.tn/`,
  functionId: 'f-orders',
  alias,
  authType: UrlAuthType.NONE,
  cors: null,
  invokeMode: UrlInvokeMode.BUFFERED,
  createdAt: CREATED,
  updatedAt: CHANGED,
  ...more,
});

describe("Lambda's function URLs (L1)", () => {
  const function_ = Object.assign(new Function(), { id: 'f-orders', accountId: ACCOUNT, name: 'orders' });
  /** The function's URLs, by alias; null for $LATEST's. */
  let urls: Map<string | null, FunctionUrlView>;
  let service: { create: jest.Mock; get: jest.Mock; update: jest.Mock; remove: jest.Mock; list: jest.Mock };
  let handlers: LambdaUrls;

  beforeEach(() => {
    urls = new Map([[null, urlOf(null)]]);
    const found = (alias?: string) => {
      const url = urls.get(alias ?? null);
      if (!url) throw new NotFoundException('no URL');
      return url;
    };
    service = {
      create: jest.fn(async (_account: string, _id: string, dto: Partial<FunctionUrlView>, alias?: string) => {
        if (urls.has(alias ?? null)) throw new ConflictException('The function already has a URL');
        const url = urlOf(alias ?? null, { ...set(dto), createdAt: CHANGED });
        urls.set(alias ?? null, url);
        return url;
      }),
      get: jest.fn(async (_account: string, _id: string, alias?: string) => found(alias)),
      update: jest.fn(async (_account: string, _id: string, dto: Partial<FunctionUrlView>, alias?: string) => ({ ...found(alias), ...set(dto) })),
      remove: jest.fn(async (_account: string, _id: string, alias?: string) => void found(alias)),
      list: jest.fn(async () => [...urls.values()]),
    };
    const aliases = {
      get: jest.fn(async (_account: string, _id: string, name: string) => {
        if (!['live', 'beta'].includes(name)) throw new NotFoundException('The function orders has no alias');
        return { name };
      }),
    };
    handlers = new LambdaUrls(service as unknown as FunctionUrlsService, aliases as unknown as FunctionAliasesService);
  });

  /** A request as the front door hands it on: the function its path names found, a qualifier from its name or its query. */
  async function ask(method: string, target: string, input: Record<string, unknown> = {}, qualifier?: string) {
    const call = lambdaCall(method, target, input);
    const answer = await handlers.handlers[call.operation.name](call, lambdaCaller({ function_, named: { name: 'orders', ...(qualifier ? { qualifier } : {}) } }));
    return { status: answer.status, document: answer.document as Record<string, unknown> };
  }

  describe('CreateFunctionUrlConfig', () => {
    it("gives the alias its URL, Lambda's Cors under FF's names, and answers 201 with its configuration, the alias's ARN, without LastModifiedTime", async () => {
      const answer = await ask('POST', `${URL}?Qualifier=live`, { AuthType: 'AWS_IAM', Cors: { AllowOrigins: ['https://shop.example.tn'], MaxAge: 60 } }, 'live');

      expect(service.create).toHaveBeenCalledWith(ACCOUNT, 'f-orders', { authType: 'AWS_IAM', cors: { allowOrigins: ['https://shop.example.tn'], maxAge: 60 } }, 'live');
      expect(answer).toEqual({
        status: 201,
        document: {
          FunctionUrl: `https://${'live'.padEnd(32, '0')}.fn.example.tn/`,
          FunctionArn: `${ARN}:live`,
          AuthType: 'AWS_IAM',
          Cors: { AllowOrigins: ['https://shop.example.tn'], MaxAge: 60 },
          CreationTime: CHANGED.toISOString(),
          InvokeMode: 'BUFFERED',
        },
      });
    });

    it("refuses a second URL in Lambda's words, with the function's ARN", async () => {
      expect(await refused(ask('POST', URL, { AuthType: 'NONE' }))).toEqual([
        409,
        'ResourceConflictException',
        `Failed to create function url config for [functionArn = ${ARN}]. Error message: FunctionUrlConfig exists for this Lambda function`,
      ]);
    });

    it("refuses what Lambda's model refuses, under Lambda's names: AuthType missing or another, InvokeMode streamed, a field of Cors or of the request it hasn't", async () => {
      expect(await refused(ask('POST', `${URL}?Qualifier=beta`, {}, 'beta'))).toEqual([400, 'InvalidParameterValueException', 'CreateFunctionUrlConfig needs AuthType: NONE or AWS_IAM.']);
      expect(await refused(ask('POST', `${URL}?Qualifier=beta`, { AuthType: 'IAM' }, 'beta'))).toEqual([400, 'InvalidParameterValueException', 'AuthType must be NONE or AWS_IAM, not IAM.']);
      expect(await refused(ask('POST', `${URL}?Qualifier=beta`, { AuthType: 'NONE', InvokeMode: 'RESPONSE_STREAM' }, 'beta'))).toEqual([
        400,
        'InvalidParameterValueException',
        "InvokeMode must be BUFFERED: FF doesn't stream answers, not RESPONSE_STREAM.",
      ]);
      expect(await refused(ask('POST', `${URL}?Qualifier=beta`, { AuthType: 'NONE', Cors: { AllowOrigin: ['*'] } }, 'beta'))).toEqual([
        400,
        'InvalidParameterValueException',
        'Cors takes AllowCredentials, AllowHeaders, AllowMethods, AllowOrigins, ExposeHeaders, MaxAge, not AllowOrigin.',
      ]);
      expect(await refused(ask('POST', `${URL}?Qualifier=beta`, { AuthType: 'NONE', Qualifier: 'beta' }, 'beta'))).toEqual([
        400,
        'InvalidParameterValueException',
        "FF doesn't take Qualifier in CreateFunctionUrlConfig.",
      ]);
      expect(service.create).not.toHaveBeenCalled();
    });

    it("checks Cors's values with FF's own checks, and passes FF's refusal of a function that takes FF's wrapped event on", async () => {
      const [status, type, message] = await refused(ask('POST', `${URL}?Qualifier=beta`, { AuthType: 'NONE', Cors: { AllowMethods: ['TRACE'] } }, 'beta'));
      expect([status, type, message]).toEqual([400, 'InvalidParameterValueException', expect.stringContaining('allowMethods must be one of GET')]);

      service.create.mockRejectedValueOnce(new BadRequestException("A function URL sends AWS Lambda's events"));
      expect(await refused(ask('POST', `${URL}?Qualifier=beta`, { AuthType: 'NONE' }, 'beta'))).toEqual([400, 'InvalidParameterValueException', "A function URL sends AWS Lambda's events"]);
    });
  });

  describe('GetFunctionUrlConfig, UpdateFunctionUrlConfig, DeleteFunctionUrlConfig', () => {
    it("reads $LATEST's URL with its LastModifiedTime, and an alias's by Qualifier", async () => {
      urls.set('live', urlOf('live', { cors: { allowCredentials: true } }));

      expect((await ask('GET', URL)).document).toEqual({
        FunctionUrl: `https://${'latest'.padEnd(32, '0')}.fn.example.tn/`,
        FunctionArn: ARN,
        AuthType: 'NONE',
        CreationTime: CREATED.toISOString(),
        LastModifiedTime: CHANGED.toISOString(),
        InvokeMode: 'BUFFERED',
      });
      expect((await ask('GET', `${URL}?Qualifier=live`, {}, 'live')).document).toMatchObject({ FunctionArn: `${ARN}:live`, Cors: { AllowCredentials: true } });
    });

    it('changes what is sent, the rest staying, and deletes the URL with 204', async () => {
      expect((await ask('PUT', URL, { Cors: { AllowHeaders: ['x-cart'] } })).document).toMatchObject({ AuthType: 'NONE', Cors: { AllowHeaders: ['x-cart'] } });
      expect(service.update).toHaveBeenCalledWith(ACCOUNT, 'f-orders', { cors: { allowHeaders: ['x-cart'] } }, undefined);

      expect(await ask('DELETE', URL)).toEqual({ status: 204, document: undefined });
      expect(service.remove).toHaveBeenCalledWith(ACCOUNT, 'f-orders', undefined);
    });

    it("refuses a URL the function hasn't, an alias it hasn't, and a version, which has no URL, as Lambda refuses them", async () => {
      expect(await refused(ask('GET', `${URL}?Qualifier=beta`, {}, 'beta'))).toEqual([404, 'ResourceNotFoundException', 'The resource you requested does not exist.']);
      expect(await refused(ask('PUT', `${URL}?Qualifier=beta`, { AuthType: 'NONE' }, 'beta'))).toEqual([404, 'ResourceNotFoundException', 'The resource you requested does not exist.']);
      expect(await refused(ask('DELETE', `${URL}?Qualifier=gone`, {}, 'gone'))).toEqual([404, 'ResourceNotFoundException', `Function not found: ${ARN}:gone`]);
      expect(await refused(ask('GET', `${URL}?Qualifier=3`, {}, '3'))).toEqual([
        400,
        'InvalidParameterValueException',
        "A function URL is $LATEST's or an alias's, and 3 is a version's number: name the version through an alias.",
      ]);
      expect(service.remove).not.toHaveBeenCalled();
    });
  });

  describe('ListFunctionUrlConfigs', () => {
    it("lists $LATEST's URL first, then the aliases' by name, 50 at most a page, as Lambda's", async () => {
      urls.set('live', urlOf('live'));
      urls.set('beta', urlOf('beta'));

      const first = await ask('GET', '/2021-10-31/functions/orders/urls?MaxItems=2');
      expect((first.document.FunctionUrlConfigs as Array<{ FunctionArn: string }>).map((url) => url.FunctionArn)).toEqual([ARN, `${ARN}:beta`]);
      const rest = await ask('GET', `/2021-10-31/functions/orders/urls?Marker=${String(first.document.NextMarker)}`);
      expect(rest.document).toEqual({ FunctionUrlConfigs: [expect.objectContaining({ FunctionArn: `${ARN}:live` })] });

      expect(await refused(ask('GET', '/2021-10-31/functions/orders/urls?MaxItems=51'))).toEqual([400, 'InvalidParameterValueException', 'MaxItems must be a whole number from 1 to 50, not 51.']);
      expect(await refused(ask('GET', '/2021-10-31/functions/orders/urls', {}, 'live'))).toEqual([
        400,
        'InvalidParameterValueException',
        'ListFunctionUrlConfigs names the function alone, not its version or alias live: send orders.',
      ]);
    });
  });
});

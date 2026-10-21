import { describe, expect, it } from 'vitest';
import corsSource from '../../BE/src/config/configuration.ts?raw';
import backendEnvExample from '../../BE/.env.example?raw';
import scopesSource from '../../BE/src/api-keys/api-key-format.ts?raw';
import planLimitsSource from '../../BE/src/plans/plan-limits.ts?raw';
import invocationSource from '../../BE/src/functions/entities/function-invocation.entity.ts?raw';
import usageDtoSource from '../../BE/src/usage/usage.dto.ts?raw';
import billingDtoSource from '../../BE/src/billing/billing.dto.ts?raw';
import paymentsDtoSource from '../../BE/src/billing/payments/payments.dto.ts?raw';
import proFormaSource from '../../BE/src/billing/payments/pro-forma.ts?raw';
import invoicesDtoSource from '../../BE/src/billing/invoices/invoices.dto.ts?raw';
import logsDtoSource from '../../BE/src/functions/dto/function-logs.dto.ts?raw';
import functionsServiceSource from '../../BE/src/functions/functions.service.ts?raw';
import functionEntitySource from '../../BE/src/functions/entities/function.entity.ts?raw';
import createFunctionDtoSource from '../../BE/src/functions/dto/create-function.dto.ts?raw';
import secretsDtoSource from '../../BE/src/functions/dto/secrets.dto.ts?raw';
import environmentSource from '../../BE/src/functions/environment.ts?raw';
import accountDtoSource from '../../BE/src/accounts/dto/account.dto.ts?raw';
import metricsDtoSource from '../../BE/src/metrics/dto/metrics-query.dto.ts?raw';
import languageSource from '../../BE/src/mail/language.ts?raw';
import notificationsDtoSource from '../../BE/src/notifications/notifications.dto.ts?raw';
import deliveryEntitySource from '../../BE/src/notifications/entities/notification-delivery.entity.ts?raw';
import retrySource from '../../BE/src/notifications/retry.ts?raw';
import alarmRulesSource from '../../BE/src/alarms/alarm-rules.ts?raw';
import alarmsDtoSource from '../../BE/src/alarms/alarms.dto.ts?raw';
import realmSource from '../../deploy/keycloak/ff-realm.json?raw';
import functionUrlDtoSource from '../../BE/src/function-urls/dto/function-url.dto.ts?raw';
import urlResponseSource from '../../BE/src/function-urls/url-response.ts?raw';
import functionUrlEntitySource from '../../BE/src/functions/entities/function-url.entity.ts?raw';
import customDomainDtoSource from '../../BE/src/function-urls/dto/custom-domain.dto.ts?raw';
import customDomainEntitySource from '../../BE/src/function-urls/custom-domain.entity.ts?raw';
import scheduleDtoSource from '../../BE/src/schedules/dto/schedule.dto.ts?raw';
import viteConfigSource from '../vite.config.ts?raw';
import { LOGGED_OUT_PATH, oidcSettings } from './auth/oidc';
import { CREDIT_LIMITS } from './lib/billing';
import { MAX_ATTEMPTS } from './lib/notifications';
import { COMPARISONS, MAX_EVALUATION_PERIODS, MAX_WEBHOOKS, MISSING_DATA, PERIODS, STATISTICS } from './lib/alarms';
import { PLAN_LIMIT_KEYS } from './lib/plans';
import { AUTH_TYPES, CORS_LIMITS, CORS_METHODS, FUNCTION_URL_FIELDS, HEADER_NAME, ORIGIN } from './lib/function-url';
import { CUSTOM_DOMAIN_FIELDS, DOMAIN_STATUSES } from './lib/custom-domains';
import { SCHEDULE_FIELDS, SCHEDULE_NAME } from './lib/schedules';
import { FUNCTION_NAME_PATTERN, MAX_FUNCTION_NAME_LENGTH, SAVED_FUNCTION_FIELD } from './lib/functions';
import { FF_RESERVED, LAMBDA_RESERVED, MAX_ENVIRONMENT_BYTES, VARIABLE_NAME } from './lib/environment';
import {
  ALARM_FIELDS,
  EVENT_FORMATS,
  PACKAGE_TYPES,
  SECRET_FIELDS,
  ALARM_STATES,
  BALANCE_FIELDS,
  CREDIT_STATE_FIELDS,
  DELIVERY_FIELDS,
  DELIVERY_STATUSES,
  EMAIL_LANGUAGES,
  WEBHOOK_SECRET_FIELDS,
  INVOCATION_FIELDS,
  INVOCATION_SOURCES,
  INVOCATION_STATUSES,
  ME_ACCOUNT_FIELDS,
  METRIC_NAMES,
  INVOICE_FIELDS,
  LOGS_PAGE_FIELDS,
  LOGS_QUERY_PARAMS,
  LOG_LINE_FIELDS,
  PRO_FORMAS_PAGE_FIELDS,
  PRO_FORMA_FIELDS,
  PRO_FORMA_PARTY_FIELDS,
  SCOPES,
  TRANSFER_FIELDS,
  USAGE_AMOUNTS,
  USAGE_ESTIMATE_FIELDS,
} from './services/api';

// What the console shares with the API and the development realm, read from
// their files: a console on another port than the realm and the API allow
// can't log in, and the browser blocks its calls (P-14).

const port = /const CONSOLE_PORT = (\d+)/.exec(viteConfigSource)?.[1];
const origin = `http://localhost:${port}`;

interface RealmClient {
  clientId: string;
  publicClient: boolean;
  standardFlowEnabled: boolean;
  redirectUris: string[];
  webOrigins: string[];
  attributes: Record<string, string>;
  protocolMappers: { protocolMapper: string; config: Record<string, string> }[];
}
const consoleClient = (JSON.parse(realmSource) as { clients: RealmClient[] }).clients.find((c) => c.clientId === 'ff-console')!;

/** Keycloak's rule: a registered URI ending in * allows every URI it starts. */
const allows = (registered: string[], uri: string) =>
  registered.some((pattern) => (pattern.endsWith('*') ? uri.startsWith(pattern.slice(0, -1)) : uri === pattern));

describe("the console's address", () => {
  it('is fixed in the Vite config', () => {
    expect(port).toBe('5199');
    expect(viteConfigSource).toContain('strictPort: true');
  });

  it('is where the development realm lets ff-console come back after login and logout', () => {
    const settings = oidcSettings({ authority: 'http://localhost:8180/realms/ff', clientId: 'ff-console' }, origin);

    expect(allows(consoleClient.redirectUris, settings.redirect_uri)).toBe(true);
    expect(allows(consoleClient.attributes['post.logout.redirect.uris'].split('##'), settings.post_logout_redirect_uri!)).toBe(true);
    expect(settings.post_logout_redirect_uri).toBe(`${origin}${LOGGED_OUT_PATH}`);
    expect(consoleClient.webOrigins).toContain(origin); // the token request is a cross-origin call
  });

  it("is one of the backend's CORS origins in development, by default and in BE/.env.example", () => {
    expect(corsSource).toContain(`const DEV_CORS_ORIGIN = '${origin}';`);
    // Next to the admin dashboard's (P-70).
    expect(backendEnvExample).toMatch(new RegExp(`^CORS_ORIGIN=(.*,)?${origin}(,.*)?$`, 'm'));
  });
});

describe("the development realm's ff-console client", () => {
  it('is a public client with the code flow and PKCE, as a browser app must be', () => {
    expect(consoleClient).toMatchObject({ publicClient: true, standardFlowEnabled: true });
    expect(consoleClient.attributes['pkce.code.challenge.method']).toBe('S256');
  });

  it('puts the API in its tokens\' audience, which the API checks', () => {
    expect(consoleClient.protocolMappers).toContainEqual(
      expect.objectContaining({ protocolMapper: 'oidc-audience-mapper', config: expect.objectContaining({ 'included.custom.audience': 'ff-api' }) }),
    );
  });
});

describe('API key scopes', () => {
  it("are the API's, so the form offers each one it accepts", () => {
    const backendScopes = /export const SCOPES = \[([^\]]*)\] as const/.exec(scopesSource)?.[1].match(/'[^']+'/g)?.map((s) => s.slice(1, -1));

    expect(backendScopes).toEqual([...SCOPES]);
  });
});

describe("an invocation's status", () => {
  it("is one of the API's, so the history has a style for each one it may show (P-20 added LOST)", () => {
    const enumBody = invocationSource.slice(invocationSource.indexOf('export enum InvocationStatus'));
    const backendStatuses = [...enumBody.slice(0, enumBody.indexOf('\n}')).matchAll(/^ {2}\w+ = '(\w+)',$/gm)].map((match) => match[1]);

    expect(backendStatuses).toContain('LOST');
    expect(backendStatuses).toEqual([...INVOCATION_STATUSES]);
  });
});

describe("what brought an invocation", () => {
  it("is one of the API's, so the history names each one it may show", () => {
    const enumBody = invocationSource.slice(invocationSource.indexOf('export enum InvocationSource'));
    const backendSources = [...enumBody.slice(0, enumBody.indexOf('\n}')).matchAll(/^ {2}\w+ = '(\w+)',$/gm)].map((match) => match[1]);

    expect(backendSources).toEqual([...INVOCATION_SOURCES]);
  });
});

describe('the metrics', () => {
  it("are the API's series, named as CloudWatch names Lambda's", () => {
    expect(dtoFields(metricsDtoSource, 'class MetricSeries {')).toEqual([...METRIC_NAMES]);
  });
});

describe('an account in GET /me', () => {
  it("has the API's fields, the dates a closed account's data is deleted among them, so the console reads each one there is", () => {
    expect(dtoFields(accountDtoSource, 'class MeAccount {')).toEqual([...ME_ACCOUNT_FIELDS]);
  });
});

describe('an invocation', () => {
  it("has the API's fields, so the history reads each one there is, the truncation flags among them", () => {
    const body = invocationSource.slice(invocationSource.indexOf('export class FunctionInvocation {'));
    const fields = [...body.slice(0, body.indexOf('\n}')).matchAll(/^ {2}(\w+)\??: /gm)].map((match) => match[1]);

    // `function` is the relation, which the API never loads into an invocation it returns.
    expect(fields.filter((field) => field !== 'function')).toEqual([...INVOCATION_FIELDS]);
    expect(INVOCATION_FIELDS).toEqual(expect.arrayContaining(['inputTruncated', 'outputTruncated', 'errorTruncated']));
  });
});

describe('the usage of a month (P-22)', () => {
  it("has the API's amounts, so the page shows each one and reads none that isn't there", () => {
    const body = usageDtoSource.slice(usageDtoSource.indexOf('export class UsageAmountsView {'));
    const backendAmounts = [...body.slice(0, body.indexOf('\n}')).matchAll(/^ {2}(\w+): /gm)].map((match) => match[1]);

    expect(backendAmounts).toEqual([...USAGE_AMOUNTS]);
  });
});

describe("the usage of a month's estimated cost (P-30)", () => {
  it("has the API's fields, and each function its cost", () => {
    const body = usageDtoSource.slice(usageDtoSource.indexOf('export class UsageEstimateView {'));
    const backendFields = [...body.slice(0, body.indexOf('\n}')).matchAll(/^ {2}(\w+): /gm)].map((match) => match[1]);
    const functionView = usageDtoSource.slice(usageDtoSource.indexOf('export class FunctionUsageView'));

    expect(backendFields).toEqual([...USAGE_ESTIMATE_FIELDS]);
    expect(functionView.slice(0, functionView.indexOf('\n}'))).toMatch(/^ {2}cost: string \| null;$/m);
  });
});

describe("the account's balance (P-32)", () => {
  it("has the API's fields, so the header reads each one that is there", () => {
    const body = billingDtoSource.slice(billingDtoSource.indexOf('export class BalanceView {'));
    const backendFields = [...body.slice(0, body.indexOf('\n}')).matchAll(/^ {2}@ApiProperty\(.*\) (\w+): |^ {2}(\w+): /gm)].map((match) => match[1] ?? match[2]);

    expect(backendFields).toEqual([...BALANCE_FIELDS]);
  });

  it("has the API's credit state (P-33), so the banner and the Billing page read each field there is", () => {
    const body = billingDtoSource.slice(billingDtoSource.indexOf('export class CreditStateView {'));
    const backendFields = [...body.slice(0, body.indexOf('\n}')).matchAll(/^ {2}@ApiProperty\(.*\) (\w+): |^ {2}(\w+): /gm)].map((match) => match[1] ?? match[2]);

    expect(backendFields).toEqual([...CREDIT_STATE_FIELDS]);
  });
});

/** The fields of a class in a DTO file, its own only: `  @ApiProperty(...) name:` or `  name:` lines. */
function dtoFields(source: string, start: string): string[] {
  const body = source.slice(source.indexOf(start));
  return [...body.slice(0, body.indexOf('\n}')).matchAll(/^ {2}@ApiProperty\(.*\) (\w+): |^ {2}(\w+): /gm)].map((match) => match[1] ?? match[2]);
}

describe('a pro-forma (P-35)', () => {
  it("has the API's fields, and its transfer too, so the Billing page and the printed pro-forma read each one there is", () => {
    expect(dtoFields(paymentsDtoSource, 'export class ProFormaView {')).toEqual([...PRO_FORMA_FIELDS]);
    expect(dtoFields(paymentsDtoSource, 'export class TransferView {')).toEqual([...TRANSFER_FIELDS]);
  });

  it("names the buyer, the seller and FF's bank as the API does", () => {
    const party = dtoFields(paymentsDtoSource, 'export class PartyView {');

    expect(party).toEqual([...PRO_FORMA_PARTY_FIELDS.buyer]);
    expect(paymentsDtoSource).toContain('export class SellerView extends PartyView {');
    expect([...party, ...dtoFields(paymentsDtoSource, 'export class SellerView extends PartyView {')]).toEqual([...PRO_FORMA_PARTY_FIELDS.seller]);
    expect(dtoFields(paymentsDtoSource, 'export class BankView {')).toEqual([...PRO_FORMA_PARTY_FIELDS.bank]);
  });

  it("quotes at the VAT rate the API gives with the list (P-36), and takes the API's credit limits, so the quote is the pro-forma's", () => {
    expect(dtoFields(paymentsDtoSource, 'export class ProFormasPage {')).toEqual([...PRO_FORMAS_PAGE_FIELDS]);
    const limits = /export const CREDIT_LIMITS = \{ min: ([\d_]+)n, max: ([\d_]+)n \};/.exec(proFormaSource);
    expect(limits?.slice(1).map((limit) => Number(limit.replace(/_/g, '')))).toEqual([CREDIT_LIMITS.min, CREDIT_LIMITS.max]);
  });
});

describe("a function's logs (P-43, P-44)", () => {
  it("have the API's fields, so the logs tab shows each one there is", () => {
    expect(dtoFields(logsDtoSource, 'export class FunctionLogLineView {')).toEqual([...LOG_LINE_FIELDS]);
    expect(dtoFields(logsDtoSource, 'export class FunctionLogsView {')).toEqual([...LOGS_PAGE_FIELDS]);
  });

  it('are asked for with parameters the API takes', () => {
    const query = logsDtoSource.slice(logsDtoSource.indexOf('export class FunctionLogsQuery {'));
    const params = [...query.slice(0, query.indexOf('\n}')).matchAll(/^ {2}(\w+)\?: /gm)].map((match) => match[1]);

    expect(params).toEqual(expect.arrayContaining([...LOGS_QUERY_PARAMS]));
  });
});

describe('an invoice (P-36)', () => {
  it("has the API's fields, so the Billing page lists each one there is", () => {
    expect(dtoFields(invoicesDtoSource, 'export class InvoiceView {')).toEqual([...INVOICE_FIELDS]);
  });
});

describe("a plan's limits", () => {
  it("have the API's names, so the console shows each one and reads none that isn't there", () => {
    const schema = planLimitsSource.slice(planLimitsSource.indexOf('export const planLimitsSchema'));
    const body = schema.slice(schema.indexOf('{') + 1, schema.indexOf('\n});'));
    const backendKeys = [...body.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1]);

    expect(backendKeys).toEqual([...PLAN_LIMIT_KEYS]);
  });
});

describe("the e-mails' languages", () => {
  it("are the ones PATCH /me takes, French first, as every user's is at first", () => {
    const backend = /export const LOCALES = \[([^\]]*)\] as const;/.exec(languageSource)?.[1];
    expect(backend?.split(',').map((locale) => locale.trim().replace(/'/g, ''))).toEqual(EMAIL_LANGUAGES.map((language) => language.locale));
    expect(accountDtoSource).toContain('@IsIn([...LOCALES]');
  });
});

describe('the notifications', () => {
  it("are read with the API's fields: a delivery's, and the signing secret's", () => {
    expect(dtoFields(notificationsDtoSource, 'export class DeliveryViewDto {')).toEqual([...DELIVERY_FIELDS]);
    expect(dtoFields(notificationsDtoSource, 'export class WebhookSecretView {')).toEqual([...WEBHOOK_SECRET_FIELDS]);
  });

  it("know each status a delivery has, and as many tries as the backend makes", () => {
    const statuses = deliveryEntitySource.slice(deliveryEntitySource.indexOf('export enum DeliveryStatus {'));
    expect([...statuses.slice(0, statuses.indexOf('}')).matchAll(/= '(\w+)'/g)].map((match) => match[1])).toEqual([...DELIVERY_STATUSES]);
    const minutes = /export const RETRY_MINUTES = \[([^\]]*)\]/.exec(retrySource)?.[1].split(',').length;
    expect(retrySource).toContain('export const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;');
    expect(MAX_ATTEMPTS).toBe((minutes ?? 0) + 1);
  });
});

describe('the alarms', () => {
  /** A literal list in the backend's source: \`export const NAME = [...]\`. */
  const listIn = (source: string, name: string) =>
    /export const \w+ = \[([^\]]*)\]/.exec(source.slice(source.indexOf(`export const ${name} =`)))?.[1].split(',').map((item) => item.trim().replace(/'/g, '')).filter(Boolean);

  it("offer the API's metrics, each with its statistics", () => {
    const block = alarmRulesSource.slice(alarmRulesSource.indexOf('export const STATISTICS = {'), alarmRulesSource.indexOf('} as const;'));
    const backend = Object.fromEntries([...block.matchAll(/^\s+(\w+): \[([^\]]*)\]/gm)].map(([, metric, list]) => [metric, list.split(',').map((s) => s.trim().replace(/'/g, ''))]));
    expect(backend).toEqual(Object.fromEntries(Object.entries(STATISTICS).map(([metric, list]) => [metric, [...list]])));
  });

  it("offer its comparisons, missing data treatments, periods and limits, and read an alarm's fields and states", () => {
    expect(listIn(alarmRulesSource, 'COMPARISONS')).toEqual(COMPARISONS.map((c) => c.value));
    expect(listIn(alarmRulesSource, 'MISSING_DATA')).toEqual(MISSING_DATA.map((m) => m.value));
    expect(listIn(alarmRulesSource, 'ALARM_PERIODS')?.map(Number)).toEqual(PERIODS.map((p) => p.value));
    expect(listIn(alarmRulesSource, 'STATES')).toEqual([...ALARM_STATES]);
    expect(alarmRulesSource).toContain(`export const MAX_EVALUATION_PERIODS = ${MAX_EVALUATION_PERIODS};`);
    expect(alarmRulesSource).toContain(`export const MAX_WEBHOOKS = ${MAX_WEBHOOKS};`);
    expect(dtoFields(alarmsDtoSource, 'export class AlarmView {')).toEqual([...ALARM_FIELDS]);
  });
});

describe('a failed create', () => {
  it("names the function the API saved anyway in the field the console reads, so the console opens it rather than create it twice", () => {
    expect(functionsServiceSource).toContain(`failureResponse(error, failure, { ${SAVED_FUNCTION_FIELD}: savedFunction.id })`);
  });
});

describe("a function's name", () => {
  it("is held in the forms to the rule the API applies, AWS Lambda's", () => {
    const api = new RegExp(/export const FUNCTION_NAME = \/(.+)\/;/.exec(createFunctionDtoSource)![1]);
    // As a browser compiles an input's pattern: anchored, with the v flag.
    const form = new RegExp(`^(?:${FUNCTION_NAME_PATTERN})$`, 'v');
    const names = ['hello', 'Hello_World-2', 'a', 'x'.repeat(MAX_FUNCTION_NAME_LENGTH), 'x'.repeat(MAX_FUNCTION_NAME_LENGTH + 1), '', 'my function', ' hello', 'a.b', 'a/b', 'é', 'a\nb'];
    expect(names.map((name) => form.test(name))).toEqual(names.map((name) => api.test(name)));
    expect(names.filter((name) => api.test(name))).toEqual(['hello', 'Hello_World-2', 'a', 'x'.repeat(64)]);
  });
});

describe("a function's environment variables", () => {
  /** The names of one of the API's lists, as written in its source. */
  const listed = (name: string) => [...new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(environmentSource)![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

  it('are held in the editor to the rules the API applies: the names, the reserved ones, the 4 KB', () => {
    expect(new RegExp(/export const VARIABLE_NAME = \/(.+)\/;/.exec(environmentSource)![1]).source).toBe(VARIABLE_NAME.source);
    expect(Number(/export const MAX_ENVIRONMENT_BYTES = (\d+);/.exec(environmentSource)![1])).toBe(MAX_ENVIRONMENT_BYTES);
    expect(LAMBDA_RESERVED).toEqual(listed('LAMBDA_RESERVED'));
    expect(FF_RESERVED).toEqual(listed('FF_RESERVED'));
    expect(environmentSource).toContain("name.startsWith('FF_')");
  });
});

describe("a function's secrets", () => {
  it('are read as the API says them: a name and when it was set, nothing else', () => {
    const view = /export class SecretView \{([\s\S]*?)\n\}/.exec(secretsDtoSource)![1];
    expect([...view.matchAll(/^ {2}(\w+): /gm)].map((m) => m[1])).toEqual([...SECRET_FIELDS]);
  });
});

describe('the event a function receives', () => {
  it("is one of the API's formats", () => {
    const body = /export enum EventFormat \{([\s\S]*?)\n\}/.exec(functionEntitySource)![1];
    expect([...body.matchAll(/= '(\w+)'/g)].map((m) => m[1])).toEqual([...EVENT_FORMATS]);
  });
});

describe("a function's code", () => {
  it("comes as one of the API's package types, with the handler, hash and size the page shows", () => {
    const types = /export enum PackageType \{([\s\S]*?)\n\}/.exec(functionEntitySource)![1];
    expect([...types.matchAll(/= '(\w+)'/g)].map((m) => m[1])).toEqual([...PACKAGE_TYPES]);
    for (const field of ['packageType', 'handler', 'codeSha256', 'codeSize']) expect(functionEntitySource).toMatch(new RegExp(`^  ${field}: `, 'm'));
  });
});

describe("a function's URL", () => {
  it("has the API's fields and auth types, so the tab reads each one there is", () => {
    const authTypes = functionUrlEntitySource.slice(functionUrlEntitySource.indexOf('export enum UrlAuthType'));

    expect(dtoFields(functionUrlDtoSource, 'export class FunctionUrlView {')).toEqual([...FUNCTION_URL_FIELDS]);
    expect([...authTypes.slice(0, authTypes.indexOf('\n}')).matchAll(/^ {2}\w+ = '(\w+)',$/gm)].map((match) => match[1])).toEqual([...AUTH_TYPES]);
  });

  it("checks CORS by the API's rules and limits, so the form refuses what the API would", () => {
    const methods = /export const CORS_METHODS = \[([^\]]*)\] as const/.exec(functionUrlDtoSource)?.[1].match(/'[^']+'/g)?.map((s) => s.slice(1, -1));

    expect(methods).toEqual([...CORS_METHODS]);
    expect(functionUrlDtoSource).toContain(`const ORIGIN = ${ORIGIN.toString()};`);
    expect(urlResponseSource).toContain(`export const TOKEN = ${HEADER_NAME.toString()};`);
    for (const rule of [
      `@ArrayMaxSize(${CORS_LIMITS.origins})`,
      `@MaxLength(${CORS_LIMITS.originLength}, { each: true })`,
      `@ArrayMaxSize(${CORS_LIMITS.headers})`,
      `@MaxLength(${CORS_LIMITS.headerLength}, { each: true })`,
      `@ArrayMaxSize(${CORS_LIMITS.methods})`,
      `@Max(${CORS_LIMITS.maxAge})`,
    ]) {
      expect(functionUrlDtoSource).toContain(rule);
    }
  });
});

describe("a function URL's own domain", () => {
  it("has the API's fields and statuses, so the card shows each one there is", () => {
    const statuses = customDomainEntitySource.slice(customDomainEntitySource.indexOf('export enum DomainStatus'));

    expect(dtoFields(customDomainDtoSource, 'export class CustomDomainView {')).toEqual([...CUSTOM_DOMAIN_FIELDS]);
    expect([...statuses.slice(0, statuses.indexOf('\n}')).matchAll(/^ {2}\w+ = '(\w+)',$/gm)].map((match) => match[1])).toEqual([...DOMAIN_STATUSES]);
    expect(dtoFields(customDomainDtoSource, 'export class DomainRecordsView {')).toEqual(['cname', 'txt']);
  });
});

describe("a function's schedule", () => {
  it("has the API's fields and name rule, so the tab reads each one there is and the form refuses what the API would", () => {
    expect(dtoFields(scheduleDtoSource, 'export class ScheduleView {')).toEqual([...SCHEDULE_FIELDS]);
    expect(scheduleDtoSource).toContain(`export const SCHEDULE_NAME = ${SCHEDULE_NAME.toString()};`);
  });
});

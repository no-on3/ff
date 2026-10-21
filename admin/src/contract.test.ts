import { describe, expect, it } from 'vitest';
import configurationSource from '../../BE/src/config/configuration.ts?raw';
import backendEnvExample from '../../BE/.env.example?raw';
import operatorSource from '../../BE/src/admin/operator.ts?raw';
import settingsSource from '../../BE/src/admin/platform-settings.ts?raw';
import auditSource from '../../BE/src/audit/audit.service.ts?raw';
import accountEntitySource from '../../BE/src/accounts/entities/account.entity.ts?raw';
import statusChangesSource from '../../BE/src/admin/account-status-changes.ts?raw';
import planLimitsSource from '../../BE/src/plans/plan-limits.ts?raw';
import priceBookSource from '../../BE/src/billing/price-book.ts?raw';
import priceBooksMigration from '../../BE/src/migrations/1792235773406-PriceBooks.ts?raw';
import paymentsDtoSource from '../../BE/src/billing/payments/payments.dto.ts?raw';
import paymentEntitySource from '../../BE/src/billing/payments/payment.entity.ts?raw';
import paymentsServiceSource from '../../BE/src/billing/payments/payments.service.ts?raw';
import invoicesDtoSource from '../../BE/src/billing/invoices/invoices.dto.ts?raw';
import invoiceEntitySource from '../../BE/src/billing/invoices/invoice.entity.ts?raw';
import adminAccountsDtoSource from '../../BE/src/admin/admin-accounts.dto.ts?raw';
import adminCreditsDtoSource from '../../BE/src/admin/admin-credits.dto.ts?raw';
import adminSupportDtoSource from '../../BE/src/admin/admin-support.dto.ts?raw';
import adminStatsDtoSource from '../../BE/src/admin/admin-stats.dto.ts?raw';
import creditGrantsSource from '../../BE/src/admin/credit-grants.ts?raw';
import ledgerTransactionSource from '../../BE/src/billing/ledger/ledger-transaction.entity.ts?raw';
import realmSource from '../../deploy/keycloak/ff-realm.json?raw';
import viteConfigSource from '../vite.config.ts?raw';
import { DEFAULT_OIDC_CLIENT_ID } from './config';
import { ACCOUNT_STATUSES, STATUS_CHANGES } from './lib/accounts';
import { FF_ACTIONS, OPERATOR_ACTIONS } from './lib/audit';
import { CALL_FIELDS, CALL_HIT_FIELDS, DOMAIN_FIELDS, FUNCTION_HIT_FIELDS, FUNCTION_PAGE_FIELDS, FUNCTION_URL_FIELDS } from './lib/support';
import { ADMIN_CREDIT_FIELDS, GRANT_FIELDS, GRANT_KINDS, GRANT_REQUEST_FIELDS } from './lib/credits';
import { ADMIN_INVOICE_FIELDS, INVOICE_KINDS } from './lib/invoices';
import { OVERVIEW_FIELDS } from './lib/overview';
import { ADMIN_PAYMENT_FIELDS, CERTIFICATE_MAX_MB, CERTIFICATE_TYPES, PAYMENT_STATUSES } from './lib/payments';
import { LIMIT_FIELDS } from './lib/plans';
import { SKUS, multiplyDecimals } from './lib/prices';
import { REASON_HEADER, REASON_LENGTH } from './lib/reason';
import { SETTINGS } from './lib/settings';

// What the admin dashboard shares with the API and the development realm, read from their files (P-70, D12).

const port = /const ADMIN_PORT = (\d+)/.exec(viteConfigSource)?.[1];
const origin = `http://localhost:${port}`;
const constant = (name: string) => new RegExp(`export const ${name} = '([^']+)'`).exec(operatorSource)?.[1];

interface Execution {
  authenticator?: string;
  requirement: string;
  flowAlias?: string;
  authenticatorConfig?: string;
}
const realm = JSON.parse(realmSource) as {
  browserFlow: string;
  roles: { realm: Array<{ name: string }> };
  clients: Array<{ clientId: string; publicClient: boolean; standardFlowEnabled: boolean; redirectUris: string[]; webOrigins: string[]; attributes: Record<string, string>; protocolMappers: Array<{ config: Record<string, string> }> }>;
  authenticationFlows: Array<{ alias: string; authenticationExecutions: Execution[] }>;
  authenticatorConfig: Array<{ alias: string; config: Record<string, string> }>;
};
const flow = (alias: string) => realm.authenticationFlows.find((f) => f.alias === alias)!;

/** The fields of a backend class, from its start: after @ApiProperty on their line, or on a line of their own after it. */
const fieldsOf = (source: string, start: string) => {
  const body = source.slice(source.indexOf(start));
  return [...body.slice(0, body.indexOf('\n}')).matchAll(/^ {2}(?:@ApiProperty(?:Optional)?\(.*\) )?(\w+)\??: /gm)].map((match) => match[1]);
};

describe("the admin dashboard's address", () => {
  it('is fixed at 5198, and the backend links to it and lets it call the API in development', () => {
    expect(port).toBe('5198');
    expect(viteConfigSource).toContain('strictPort: true');
    expect(configurationSource).toContain(`const DEV_ADMIN_URL = '${origin}';`);
    expect(configurationSource).toContain('[DEV_CORS_ORIGIN, DEV_ADMIN_URL]');
    expect(backendEnvExample).toMatch(new RegExp(`^FF_ADMIN_URL=${origin}$`, 'm'));
    expect(backendEnvExample).toMatch(new RegExp(`^CORS_ORIGIN=.*\\b${origin}\\b`, 'm'));
  });
});

describe("the development realm's ff-admin client and ff-operator role", () => {
  const admin = realm.clients.find((c) => c.clientId === DEFAULT_OIDC_CLIENT_ID)!;

  it('are the ones the backend checks', () => {
    expect(constant('ADMIN_CLIENT')).toBe(DEFAULT_OIDC_CLIENT_ID);
    expect(realm.roles.realm.map((r) => r.name)).toContain(constant('OPERATOR_ROLE'));
  });

  it('logs in a browser at the dashboard with the code flow and PKCE, and its tokens are for the API', () => {
    expect(admin).toMatchObject({ publicClient: true, standardFlowEnabled: true });
    expect(admin.attributes['pkce.code.challenge.method']).toBe('S256');
    expect(admin.redirectUris).toContain(`${origin}/*`);
    expect(admin.attributes['post.logout.redirect.uris']).toBe(`${origin}/*`);
    expect(admin.webOrigins).toContain(origin);
    expect(admin.protocolMappers.map((m) => m.config['included.custom.audience'])).toContain('ff-api');
  });

  it('asks operators, and only them, for a one-time password at login', () => {
    const top = flow(realm.browserFlow);
    const forms = flow(top.authenticationExecutions.find((e) => e.flowAlias)!.flowAlias!);
    const otp = forms.authenticationExecutions.find((e) => e.requirement === 'CONDITIONAL')!;
    const steps = flow(otp.flowAlias!).authenticationExecutions;
    const condition = realm.authenticatorConfig.find((c) => c.alias === steps[0].authenticatorConfig)!;

    expect(steps.map((s) => [s.authenticator, s.requirement])).toEqual([
      ['conditional-user-role', 'REQUIRED'],
      ['auth-otp-form', 'REQUIRED'],
    ]);
    expect(condition.config).toEqual({ condUserRole: constant('OPERATOR_ROLE'), negate: 'false' });
  });
});

describe('the operator actions the audit log page names (P-76)', () => {
  it("are actions the API records", () => {
    const union = auditSource.slice(auditSource.indexOf('export type AuditAction ='), auditSource.indexOf(';', auditSource.indexOf('export type AuditAction =')));
    const backendActions = [...union.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((match) => match[1]);

    expect(backendActions).toEqual(expect.arrayContaining(OPERATOR_ACTIONS.map((action) => action.value)));
  });

  it("and what FF does on its own, which an account's audit log shows, are actions the API records too", () => {
    const union = auditSource.slice(auditSource.indexOf('export type AuditAction ='), auditSource.indexOf(';', auditSource.indexOf('export type AuditAction =')));
    const backendActions = [...union.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((match) => match[1]);

    expect(backendActions).toEqual(expect.arrayContaining(FF_ACTIONS.map((action) => action.value)));
  });
});

describe('the account statuses and their changes (P-71)', () => {
  // The backend's enum, NAME → value, and its table of changes, in the enum's names.
  const enumBody = accountEntitySource.slice(accountEntitySource.indexOf('export enum AccountStatus'), accountEntitySource.indexOf('}', accountEntitySource.indexOf('export enum AccountStatus')));
  const statuses = new Map([...enumBody.matchAll(/(\w+) = '(\w+)'/g)].map(([, name, value]) => [name, value]));
  const value = (name: string) => statuses.get(name.trim().replace('AccountStatus.', ''));
  const backendChanges = Object.fromEntries(
    [...statusChangesSource.matchAll(/(\w+): \{ from: \[([^\]]*)\], to: (AccountStatus\.\w+) \}/g)].map(([, change, from, to]) => [
      change,
      { from: from.split(',').map(value), to: value(to) },
    ]),
  );

  it("are the backend's statuses", () => {
    expect(ACCOUNT_STATUSES.map((status) => status.value)).toEqual([...statuses.values()]);
  });

  it("are the backend's changes: each from the same statuses, to the same one", () => {
    const appChanges = Object.fromEntries(Object.entries(STATUS_CHANGES).map(([change, { from, to }]) => [change, { from, to }]));

    expect(Object.keys(backendChanges)).toHaveLength(5);
    expect(appChanges).toEqual(backendChanges);
  });
});

describe("the plans' limits and the price books' SKUs (P-73)", () => {
  /** The keys of a zod strictObject's body, two spaces in, from the backend's source. */
  const keysOf = (source: string, start: string, end: string) => {
    const body = source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
    return [...body.matchAll(/^ {2,4}(\w+): /gm)].map((match) => match[1]);
  };

  it("are the backend's limits, the quota's three included", () => {
    const limits = keysOf(planLimitsSource, 'export const planLimitsSchema', '\n});');
    const app = LIMIT_FIELDS.map(({ path }) => path[0]).filter((key, index, all) => all.indexOf(key) === index);
    const quota = /quota: z\.strictObject\(\{ (\w+): \w+, (\w+): \w+, (\w+): \w+ \}\)/.exec(planLimitsSource)?.slice(1);

    expect(app).toEqual(limits.filter((key) => key !== 'pods' && key !== 'cpu' && key !== 'memory'));
    expect(LIMIT_FIELDS.filter(({ path }) => path[0] === 'quota').map(({ path }) => path[1])).toEqual(quota);
  });

  it("are the backend's SKUs, in its order", () => {
    const prices = priceBookSource.slice(priceBookSource.indexOf('  prices: z.strictObject({'));
    const skus = [...prices.slice(0, prices.indexOf('\n  }),')).matchAll(/^ {4}(\w+): /gm)].map((match) => match[1]);

    expect(skus).toEqual([...SKUS]);
  });

  it("price the first book's TND as the migration has them: its US$ prices times its rate", () => {
    const usd = priceBooksMigration.slice(priceBooksMigration.indexOf('usdPrices: {'), priceBooksMigration.indexOf("usdRate: '"));
    const tnd = priceBooksMigration.slice(priceBooksMigration.indexOf('  prices: {'), priceBooksMigration.indexOf('minimumBilledMs'));
    const numbers = (text: string) => [...text.matchAll(/(?:price|requestsPerMillion|provisionedGbSecond|provisionedDurationGbSecond): '([\d.]+)'/g)].map((match) => match[1]);
    const rate = /usdRate: '([\d.]+)'/.exec(priceBooksMigration)?.[1] as string;

    expect(numbers(usd)).toHaveLength(6);
    expect(numbers(usd).map((price) => multiplyDecimals(price, rate))).toEqual(numbers(tnd));
  });
});

describe('payments (P-35)', () => {
  it("have the API's operator fields, after the pro-forma's", () => {
    expect(fieldsOf(paymentsDtoSource, 'export class AdminPaymentView extends ProFormaView {')).toEqual([...ADMIN_PAYMENT_FIELDS]);
  });

  it("have the API's statuses", () => {
    const body = paymentEntitySource.slice(paymentEntitySource.indexOf('export enum PaymentStatus'));
    const statuses = [...body.slice(0, body.indexOf('}')).matchAll(/= '(\w+)'/g)].map((match) => match[1]);

    expect(PAYMENT_STATUSES.map((status) => status.value)).toEqual(statuses);
  });

  it("send a certificate the API takes, its reason in the header the API reads", () => {
    expect(paymentsServiceSource).toContain(`export const CERTIFICATE_TYPES = [${CERTIFICATE_TYPES.map((type) => `'${type}'`).join(', ')}];`);
    expect(paymentsServiceSource).toContain(`export const CERTIFICATE_LIMIT = '${CERTIFICATE_MAX_MB}mb';`);
    expect(constant('REASON_HEADER')).toBe(REASON_HEADER.toLowerCase());
  });
});

describe('invoices (P-36)', () => {
  it("have the API's operator fields, after the customer's", () => {
    expect(fieldsOf(invoicesDtoSource, 'export class AdminInvoiceView extends InvoiceView {')).toEqual([...ADMIN_INVOICE_FIELDS]);
  });

  it("have the API's kinds", () => {
    const body = invoiceEntitySource.slice(invoiceEntitySource.indexOf('export enum InvoiceKind'));
    const kinds = [...body.slice(0, body.indexOf('\n}')).matchAll(/= '(\w+)'/g)].map((match) => match[1]);

    expect(INVOICE_KINDS.map((kind) => kind.value)).toEqual(kinds);
  });
});

describe('credit grants and the account page\'s credit (P-74)', () => {
  /** The fields of a DTO whose decorators sit on their own lines. */
  const dtoFieldsOf = (source: string, start: string) => {
    const body = source.slice(source.indexOf(start));
    return [...body.slice(0, body.indexOf('\n}')).matchAll(/^ {2}(\w+)\??: /gm)].map((match) => match[1]);
  };

  it("have the API's overview fields, the accounts' statuses among them", () => {
    expect(fieldsOf(adminStatsDtoSource, 'export class OverviewView {')).toEqual([...OVERVIEW_FIELDS]);
    expect(fieldsOf(adminStatsDtoSource, 'export class OverviewCapacityDay {')).toEqual(['day', 'reservedGbS', 'provisionedGbS', 'billedGbS', 'requests']);
    expect(adminStatsDtoSource).toContain('byStatus: Record<AccountStatus, number>;');
  });

  it("have the API's credit fields on the account page", () => {
    expect(fieldsOf(adminAccountsDtoSource, 'export class AdminCreditView {')).toEqual([...ADMIN_CREDIT_FIELDS]);
    expect(adminAccountsDtoSource).toContain('@ApiProperty({ type: AdminCreditView }) credit: AdminCreditView;');
  });

  it("have the API's grant fields, and send the fields the API takes", () => {
    expect(fieldsOf(adminCreditsDtoSource, 'export class AdminGrantView {')).toEqual([...GRANT_FIELDS]);
    expect(dtoFieldsOf(adminCreditsDtoSource, 'export class AdminGrantDto extends AdminChange {')).toEqual([...GRANT_REQUEST_FIELDS]);
  });

  it("have the API's kinds, each the ledger's, and their audit actions among the operator's", () => {
    const enumBody = ledgerTransactionSource.slice(ledgerTransactionSource.indexOf('export enum LedgerTransactionKind'));
    const kinds = new Map([...enumBody.slice(0, enumBody.indexOf('}')).matchAll(/(\w+) = '(\w+)'/g)].map(([, name, value]) => [name, value]));
    const listed = /export const GRANT_KINDS: GrantKind\[\] = \[([^\]]+)\];/.exec(creditGrantsSource)?.[1] ?? '';
    const backend = listed.split(',').map((name) => kinds.get(name.trim().replace('LedgerTransactionKind.', '')));
    const actions = /export const GRANT_ACTIONS = \{ promo: '([\w.]+)', adjustment: '([\w.]+)' \} as const;/.exec(creditGrantsSource)?.slice(1);

    expect(GRANT_KINDS.map((kind) => kind.value)).toEqual(backend);
    expect(actions).toEqual(['credit.promo', 'credit.adjustment']);
    expect(OPERATOR_ACTIONS.map((action) => action.value)).toEqual(expect.arrayContaining(actions ?? ['none']));
  });
});

describe('the platform settings and the reason', () => {
  it("are the API's: the same settings, and the same rule for a reason", () => {
    const defaults = settingsSource.slice(settingsSource.indexOf('export const DEFAULT_SETTINGS'));
    const keys = [...defaults.slice(0, defaults.indexOf('\n};')).matchAll(/^ {2}(\w+):/gm)].map((match) => match[1]);

    expect(SETTINGS.map((s) => s.key)).toEqual(keys);
    expect(operatorSource).toContain(`export const REASON_LENGTH = { min: ${REASON_LENGTH.min}, max: ${REASON_LENGTH.max} } as const;`);
  });
});

describe('support', () => {
  it("has the API's fields: a function and a call found, and a call without its data", () => {
    expect(fieldsOf(adminSupportDtoSource, 'export class AdminFunctionHitView {')).toEqual([...FUNCTION_HIT_FIELDS]);
    expect(fieldsOf(adminSupportDtoSource, 'export class AdminCallHitView {')).toEqual([...CALL_HIT_FIELDS]);
    expect(fieldsOf(adminSupportDtoSource, 'export class AdminCallView {')).toEqual([...CALL_FIELDS]);
  });

  it("has the API's fields for a function's page and its URL", () => {
    expect(fieldsOf(adminSupportDtoSource, 'export class AdminFunctionPageView {')).toEqual([...FUNCTION_PAGE_FIELDS]);
    expect(fieldsOf(adminSupportDtoSource, 'export class AdminFunctionUrlView {')).toEqual([...FUNCTION_URL_FIELDS]);
    expect(fieldsOf(adminSupportDtoSource, 'export class AdminDomainView {')).toEqual([...DOMAIN_FIELDS]);
  });
});

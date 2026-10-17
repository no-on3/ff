/**
 * L1: the OpenAPI document says what the API answers. Generated clients and
 * the L5 suite read it, so a route that answers another status than its
 * document says breaks them (client-readiness plan, P-08).
 */
import { INestApplication } from '@nestjs/common';
import { OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { AccountStatus } from './accounts/entities/account.entity';
import { AccountsController } from './accounts/accounts.controller';
import { AccountsService } from './accounts/accounts.service';
import { ApiKeysController } from './api-keys/api-keys.controller';
import { ApiKeysService } from './api-keys/api-keys.service';
import { apiDocument } from './api-document';
import { Principal } from './auth/principal';
import { FunctionsController } from './functions/functions.controller';
import { FunctionsService } from './functions/functions.service';
import { HealthController } from './health/health.controller';
import { MetricsController } from './metrics/metrics.controller';
import { MetricsService } from './metrics/metrics.service';
import { AdminAccountsController } from './admin/admin-accounts.controller';
import { AdminPlansController } from './admin/admin-plans.controller';
import { AdminPricesController } from './admin/admin-prices.controller';
import { AdminPricesService } from './admin/admin-prices.service';
import { AdminAccountsService } from './admin/admin-accounts.service';
import { AdminCreditsService } from './admin/admin-credits.service';
import { AdminAuditController } from './admin/admin-audit.controller';
import { AdminSettingsController } from './admin/admin-settings.controller';
import { AuditService } from './audit/audit.service';
import { PlatformSettingsService } from './admin/platform-settings.service';
import { UsageController } from './usage/usage.controller';
import { PlansService } from './plans/plans.service';
import { PricingService } from './billing/pricing.service';
import { BillingController } from './billing/billing.controller';
import { BillingService } from './billing/billing.service';
import { ProFormasController } from './billing/payments/pro-formas.controller';
import { PaymentsService } from './billing/payments/payments.service';
import { InvoicesController } from './billing/invoices/invoices.controller';
import { InvoicesService } from './billing/invoices/invoices.service';
import { AdminInvoicesController } from './admin/admin-invoices.controller';
import { AdminPaymentsController } from './admin/admin-payments.controller';
import { UsageService } from './usage/usage.service';

const ACCOUNT = '000000000001';
const ID = '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f';
const METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

/** Every method of the service succeeds, with an empty answer unless given one. */
function succeeding(service: { prototype: object }, methods: Record<string, unknown> = {}) {
  const names = Object.getOwnPropertyNames(service.prototype).filter((name) => name !== 'constructor');
  return Object.fromEntries(names.map((name) => [name, methods[name] ?? (async () => ({}))]));
}

describe('the OpenAPI document (L1, P-08)', () => {
  let app: INestApplication;
  let document: OpenAPIObject;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [
        FunctionsController,
        MetricsController,
        HealthController,
        AccountsController,
        ApiKeysController,
        UsageController,
        AdminSettingsController,
        AdminAuditController,
        AdminAccountsController,
        AdminPlansController,
        AdminPricesController,
        BillingController,
        ProFormasController,
        AdminPaymentsController,
        InvoicesController,
        AdminInvoicesController,
      ],
      providers: [
        // The caller owns the function, so the ownership checks pass.
        { provide: FunctionsService, useValue: succeeding(FunctionsService, { findOne: async () => ({ id: ID, accountId: ACCOUNT }) }) },
        { provide: MetricsService, useValue: succeeding(MetricsService) },
        { provide: AccountsService, useValue: succeeding(AccountsService) },
        { provide: ApiKeysService, useValue: succeeding(ApiKeysService) },
        {
          provide: UsageService,
          useValue: succeeding(UsageService, {
            monthly: async () => ({ month: '2026-10', functions: [], totals: { requests: 0, billedMs: 0, gbSeconds: '0', throttled: 0, platformErrors: 0, lost: 0 } }),
          }),
        },
        { provide: PricingService, useValue: succeeding(PricingService, { estimate: async () => null }) },
        { provide: PlatformSettingsService, useValue: succeeding(PlatformSettingsService) },
        { provide: AuditService, useValue: succeeding(AuditService, { operatorActions: async () => ({ entries: [], next: null }) }) },
        { provide: AdminAccountsService, useValue: succeeding(AdminAccountsService) },
        { provide: AdminCreditsService, useValue: succeeding(AdminCreditsService) },
        { provide: PlansService, useValue: succeeding(PlansService, { list: async () => [] }) },
        { provide: AdminPricesService, useValue: succeeding(AdminPricesService, { list: async () => [] }) },
        { provide: BillingService, useValue: succeeding(BillingService) },
        {
          provide: PaymentsService,
          useValue: succeeding(PaymentsService, { certificate: async () => ({ body: Buffer.from('%PDF-1.4'), contentType: 'application/pdf', reference: 'FF-ABCD-EFGH' }) }),
        },
        {
          provide: InvoicesService,
          useValue: succeeding(InvoicesService, {
            pdf: async () => ({ body: Buffer.from('%PDF-1.4'), number: 'FAC-2026-000001' }),
            statementPdf: async () => Buffer.from('%PDF-1.4'),
          }),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    // The caller, where the authentication guard (P-11) will put it.
    app.use((req: { principal?: Principal; user?: object; operator?: object }, _res: unknown, next: () => void) => {
      req.principal = { accountId: ACCOUNT, accountStatus: AccountStatus.ACTIVE, planId: 'beta', role: 'owner' };
      req.user = { id: 'u-1', email: 'amira@example.tn' };
      req.operator = { id: 'kc-op-1', email: 'operator@ff.test' }; // for the admin routes (P-70)
      next();
    });
    document = apiDocument(app);
    SwaggerModule.setup('api', app, document); // as main.ts serves it
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(() => app.close());

  it('documents, for every route, the success status the route answers', async () => {
    const routes = Object.entries(document.paths).flatMap(([path, item]) =>
      METHODS.filter((method) => item[method]).map((method) => ({ method, path, operation: item[method]! })),
    );

    const checked: Array<{ route: string; documented: string[]; answered: number }> = [];
    for (const { method, path, operation } of routes) {
      // Account routes take an account ID, key routes a key ID, and the others a function ID.
      const param = /^\/(admin\/)?accounts\//.test(path) ? ACCOUNT : path.startsWith('/api-keys/') ? '0123456789ab' : path.startsWith('/admin/plans/') ? 'beta' : ID;
      const res = await fetch(baseUrl + path.replace(/\{\w+\}/g, param), {
        method: method.toUpperCase(),
        headers: { 'content-type': 'application/json' },
        body: method === 'get' ? undefined : '{}', // an admin DELETE carries its reason in a body (P-73)
      });
      const documented = Object.keys(operation.responses).filter((status) => status.startsWith('2'));
      checked.push({ route: `${method.toUpperCase()} ${path}`, documented, answered: res.status });
    }

    expect(checked.map((r) => r.route)).toEqual(expect.arrayContaining(['POST /functions', 'POST /functions/{id}/invoke', 'GET /functions/{id}/logs', 'GET /healthz', 'GET /usage', 'PUT /admin/settings', 'GET /admin/audit-log', 'POST /admin/accounts/{id}/approve', 'POST /admin/accounts/{id}/credits', 'PUT /admin/accounts/{id}/plan', 'GET /admin/plans', 'PUT /admin/plans/{id}', 'POST /admin/price-books', 'POST /admin/price-books/preview', 'DELETE /admin/price-books/{id}', 'GET /billing/balance', 'GET /billing/transactions', 'POST /billing/pro-formas', 'GET /billing/pro-formas/{id}', 'POST /billing/pro-formas/{id}/cancel', 'POST /admin/bank-transfers', 'POST /admin/payments/{id}/cancel', 'PUT /admin/payments/{id}/withholding-certificate', 'GET /billing/invoices', 'GET /billing/invoices/{id}/pdf', 'GET /billing/statements/{month}/pdf', 'GET /admin/invoices/drafts', 'POST /admin/invoices/issue', 'GET /admin/invoices', 'GET /admin/invoices/{id}/pdf', 'POST /admin/invoices/{id}/credit-notes']));
    expect(checked.filter((r) => r.documented.join() !== String(r.answered))).toEqual([]);
  });

  it('serves the document at /api-json, and its viewer at /api', async () => {
    const json = await fetch(`${baseUrl}/api-json`);
    const viewer = await fetch(`${baseUrl}/api`);

    expect(json.status).toBe(200);
    expect(Object.keys((await json.json()).paths)).toEqual(Object.keys(document.paths));
    expect(viewer.status).toBe(200);
    expect(await viewer.text()).toContain('swagger-ui');
  });

  it('documents invoke as 201 Created, which hack/e2e.sh checks too', () => {
    expect(Object.keys(document.paths['/functions/{id}/invoke'].post!.responses)).toEqual(['201']);
  });
});

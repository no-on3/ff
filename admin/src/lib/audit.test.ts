import { describe, expect, it } from 'vitest';
import { OperatorAction, actionLabel, auditCsvName, auditParams, describeAction, exportParams } from './audit';

const entry = (overrides: Partial<OperatorAction> = {}): OperatorAction => ({
  id: '42',
  at: '2026-10-17T10:00:00.000Z',
  operator: { id: 'kc-op-1', email: 'operator@ff.test' },
  action: 'settings.update',
  accountId: null,
  resource: 'settings',
  reason: 'Pilot customers asked for more time',
  details: null,
  ip: null,
  requestId: null,
  ...overrides,
});

describe('auditParams', () => {
  it('sends the filters set, the days as UTC instants with "to" included, and the page', () => {
    const query = { search: '', filters: { operator: ' amira ', accountId: '', action: 'settings.update', from: '2026-10-01', to: '2026-10-31' } };

    expect(auditParams(query, '41')).toEqual({
      limit: '50',
      operator: 'amira',
      action: 'settings.update',
      from: '2026-10-01T00:00:00Z',
      to: '2026-11-01T00:00:00Z',
      before: '41',
    });
  });

  it('crosses the end of a month and of a year for "to"', () => {
    expect(auditParams({ search: '', filters: { to: '2026-12-31' } }, null)).toEqual({ limit: '50', to: '2027-01-01T00:00:00Z' });
  });

  it('exports the same filters without the page: the newest of everything that matches', () => {
    expect(exportParams({ search: '', filters: { action: 'settings.update', from: '2026-10-01' } })).toEqual({
      action: 'settings.update',
      from: '2026-10-01T00:00:00Z',
    });
  });
});

describe('describeAction', () => {
  it("reads a settings change as the Settings page's dialog does: each setting's label, from → to", () => {
    const changes = {
      gracePeriodHours: { from: 24, to: 48 },
      lowBalancePercents: { from: [50, 20, 0], to: [30, 0] },
      billingShadowMode: { from: true, to: false },
    };

    expect(describeAction(entry({ details: { reason: 'r', changes } }))).toBe(
      'Grace period: 24 → 48; Low-balance e-mails: 50, 20, 0 → 30, 0; Shadow billing: on → off',
    );
  });

  it("reads an account's status, plan and internet egress by name (P-71)", () => {
    const changes = {
      status: { from: 'pending', to: 'active' },
      planId: { from: 'beta', to: 'large' },
      internetEgress: { from: false, to: true },
    };

    expect(describeAction(entry({ action: 'account.approve', details: { changes } }))).toBe('Status: pending → active; Plan: beta → large; Internet egress: off → on');
  });

  it("reads a plan's change by each limit's name, its quota in one line (P-73)", () => {
    const changes = {
      name: { from: 'Team', to: 'Teams' },
      functions: { from: 25, to: 50 },
      quota: { from: { pods: 20, cpu: '8', memory: '8Gi' }, to: { pods: 40, cpu: '16', memory: '16Gi' } },
    };

    expect(describeAction(entry({ action: 'plan.update', details: { reason: 'r', changes } }))).toBe(
      'Name: Team → Teams; Functions per account: 25 → 50; Quota: 20 instances, 8 CPU, 8Gi → 40 instances, 16 CPU, 16Gi',
    );
  });

  it('reads a price book by when it starts (P-73)', () => {
    const created = entry({ action: 'price_book.create', resource: 'price_book:0c9e', details: { reason: 'r', validFrom: '2026-11-01T00:00:00.000Z' } });

    expect(describeAction(created)).toBe('Book from 2026-11-01 00:00:00 UTC');
  });

  it('names any other change as the API does: none for no value, JSON for one with parts', () => {
    const changes = {
      reviewer: { from: 'sami', to: 'amira' },
      taxId: { from: null, to: '1234567A' },
      window: { from: { days: 10, hours: 2 }, to: { days: 20, hours: 4 } },
    };

    expect(describeAction(entry({ action: 'invoice.update', details: { changes } }))).toBe(
      'reviewer: sami → amira; taxId: none → 1234567A; window: {"days":10,"hours":2} → {"days":20,"hours":4}',
    );
  });

  it('shows an old setting value of an unexpected shape as it is, rather than break the page', () => {
    const odd = entry({ details: { changes: { lowBalancePercents: { from: null, to: [50] } } } });

    expect(describeAction(odd)).toBe('Low-balance e-mails: none → 50');
  });

  it("names a payment's steps by its reference: the transfer, with any share withheld at source, the certificate, the pro-forma (P-35)", () => {
    const recorded = { reason: 'r', reference: 'FF-7KQ2-9MXA', currency: 'TND', received: '58.608', withheld: '0.892', receivedOn: '2026-10-20', bankReference: null };

    expect(describeAction(entry({ action: 'payment.record', resource: 'payment:1', details: recorded }))).toBe(
      'FF-7KQ2-9MXA: 58.608 TND received on 2026-10-20, 0.892 TND withheld at source',
    );
    expect(describeAction(entry({ action: 'payment.record', details: { ...recorded, received: '59.500', withheld: '0.000' } }))).toBe('FF-7KQ2-9MXA: 59.500 TND received on 2026-10-20');
    expect(
      describeAction(entry({ action: 'payment.withholding', details: { reason: 'r', reference: 'FF-7KQ2-9MXA', currency: 'TND', withheld: '0.892', certificate: { type: 'application/pdf', bytes: 9 } } })),
    ).toBe('FF-7KQ2-9MXA: certificate added, 0.892 TND credited');
    expect(describeAction(entry({ action: 'billing.pro_forma', details: { reference: 'FF-7KQ2-9MXA', credit: '50.000', total: '59.500', currency: 'TND' } }))).toBe(
      'FF-7KQ2-9MXA: pro-forma for 50.000 TND of credit, 59.500 TND with VAT',
    );
  });

  it("names an invoice by its number, month, total and stamp duty, and a credit note by the invoice it corrects (P-36)", () => {
    expect(
      describeAction(entry({ action: 'invoice.issue', details: { reason: 'r', number: 'FAC-2026-000001', month: '2026-10', currency: 'TND', total: '1250.500', stampDuty: '1.000' } })),
    ).toBe('FAC-2026-000001 for 2026-10: 1250.500 TND, with 1.000 TND of stamp duty');
    expect(describeAction(entry({ action: 'invoice.credit_note', details: { reason: 'r', number: 'AV-2026-000001', corrects: 'FAC-2026-000001', currency: 'TND', total: '23.800' } }))).toBe(
      'AV-2026-000001 for FAC-2026-000001: 23.800 TND',
    );
  });

  it('else names what the action was on', () => {
    expect(describeAction(entry({ action: 'account.suspend', resource: 'account:000000000001' }))).toBe('account:000000000001');
  });
});

describe('labels and names', () => {
  it('names a known action, and shows an unknown one as the API does', () => {
    expect([actionLabel('settings.update'), actionLabel('account.reopen')]).toEqual(['Settings changed', 'account.reopen']);
    expect([actionLabel('payment.record'), actionLabel('payment.withholding')]).toEqual(['Bank transfer recorded', 'Withholding certificate added']);
    expect([actionLabel('invoice.issue'), actionLabel('invoice.credit_note')]).toEqual(['Invoice issued', 'Credit note issued']);
  });

  it("names the CSV as the API's Content-Disposition does", () => {
    expect(auditCsvName(new Date('2026-10-17T23:00:00Z'))).toBe('ff-operator-audit-2026-10-17.csv');
  });
});

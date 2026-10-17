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

  it('names any other change as the API does: none for no value, JSON for one with parts', () => {
    const changes = {
      reviewer: { from: 'sami', to: 'amira' },
      taxId: { from: null, to: '1234567A' },
      quota: { from: { pods: 10, memory: '2Gi' }, to: { pods: 20, memory: '4Gi' } },
    };

    expect(describeAction(entry({ action: 'plan.update', details: { changes } }))).toBe(
      'reviewer: sami → amira; taxId: none → 1234567A; quota: {"pods":10,"memory":"2Gi"} → {"pods":20,"memory":"4Gi"}',
    );
  });

  it('shows an old setting value of an unexpected shape as it is, rather than break the page', () => {
    const odd = entry({ details: { changes: { lowBalancePercents: { from: null, to: [50] } } } });

    expect(describeAction(odd)).toBe('Low-balance e-mails: none → 50');
  });

  it('else names what the action was on', () => {
    expect(describeAction(entry({ action: 'account.suspend', resource: 'account:000000000001' }))).toBe('account:000000000001');
  });
});

describe('labels and names', () => {
  it('names a known action, and shows an unknown one as the API does', () => {
    expect([actionLabel('settings.update'), actionLabel('account.reopen')]).toEqual(['Settings changed', 'account.reopen']);
  });

  it("names the CSV as the API's Content-Disposition does", () => {
    expect(auditCsvName(new Date('2026-10-17T23:00:00Z'))).toBe('ff-operator-audit-2026-10-17.csv');
  });
});

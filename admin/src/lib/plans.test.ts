import { describe, expect, it } from 'vitest';
import { PlanLimits, formOfLimits, limitChanges, limitsOfForm, quotaLabel } from './plans';

const BETA: PlanLimits = {
  functions: 25,
  memoryMb: 1024,
  timeoutSeconds: 300,
  instancesPerFunction: 10,
  quota: { pods: 20, cpu: '8', memory: '8Gi' },
  writesPerMinute: 60,
  invokesPerSecond: 100,
  logRetentionDays: 14,
  historyRetentionDays: 30,
  idleSeconds: 900,
  internetEgress: false,
  customDomains: 5,
  schedules: 20,
  databases: 1,
  databaseStorageMb: 1024,
  databaseConnections: 10,
  buckets: 5,
  bucketStorageMb: 5120,
  storageRequestsPerSecond: 100,
  maxObjectMb: 5120,
};

describe("a plan's limits, in a form (P-73)", () => {
  it('give the same limits back, the quota included', () => {
    expect(limitsOfForm(formOfLimits(BETA))).toEqual({ limits: BETA });
  });

  it('read each field as its kind: whole numbers, Kubernetes quantities, on or off', () => {
    const form = { ...formOfLimits(BETA), functions: ' 50 ', 'quota.cpu': '500m', internetEgress: 'true' };

    expect(limitsOfForm(form)).toEqual({ limits: { ...BETA, functions: 50, quota: { ...BETA.quota, cpu: '500m' }, internetEgress: true } });
  });

  it('name each field that is not one', () => {
    const form = { ...formOfLimits(BETA), memoryMb: '1.5', 'quota.memory': '8 GB', idleSeconds: '0' };

    expect(limitsOfForm(form)).toEqual({
      problems: [
        'Memory per function: must be a whole number, 1 or more',
        'Quota: memory: must be a Kubernetes quantity, such as 8, 500m or 8Gi',
        'Idle time before scale to zero: must be a whole number, 1 or more',
      ],
    });
  });

  it('list what changes, from → to, and nothing for the rest', () => {
    const after = { ...BETA, functions: 50, quota: { ...BETA.quota, pods: 40 }, internetEgress: true };

    expect(limitChanges(BETA, after)).toEqual(['Functions per account: 25 → 50', 'Quota: instances: 20 → 40', 'Internet egress, by default: off → on']);
    expect(limitChanges(BETA, BETA)).toEqual([]);
  });

  it('read a quota in one line', () => {
    expect(quotaLabel(BETA.quota)).toBe('20 instances, 8 CPU, 8Gi');
  });
});

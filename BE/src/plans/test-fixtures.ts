// Plans for tests (not part of the build: tsconfig.build.json excludes test-fixtures.ts).
import { PlanLimits, PlanView } from './plan-limits';
import { PlansService, tenantLimits } from './plans.service';
import { TenantLimits } from '../orchestrator/orchestrator.types';

/** The beta plan's limits, as the migrations write them. */
export const BETA_LIMITS: PlanLimits = {
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

/** A plan: the beta plan, with the given limits changed. */
export const plan = (limits: Partial<PlanLimits> = {}, id = 'beta', name = 'Beta'): PlanView => ({
  id,
  name,
  limits: { ...BETA_LIMITS, ...limits },
});

/**
 * A PlansService that puts every account on one plan, internet egress off, for services that only read plans and
 * deploy with them.
 */
export const onePlan = (view: PlanView = plan()): PlansService =>
  ({
    get: async () => view,
    forAccount: async () => view,
    forAccounts: async (ids: string[]) => new Map(ids.map((id) => [id, view])),
    withTenant: async <T>(_accountId: string, write: (tenant: TenantLimits) => Promise<T>) => write(tenantLimits(view.limits, false)),
  }) as unknown as PlansService;

// Plans for tests (not part of the build: tsconfig.build.json excludes test-fixtures.ts).
import { PlanLimits, PlanView } from './plan-limits';
import { PlansService } from './plans.service';

/** The beta plan's limits, as P-15's migration writes them. */
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
};

/** A plan: the beta plan, with the given limits changed. */
export const plan = (limits: Partial<PlanLimits> = {}, id = 'beta', name = 'Beta'): PlanView => ({
  id,
  name,
  limits: { ...BETA_LIMITS, ...limits },
});

/** A PlansService that puts every account on one plan, for services that only read plans. */
export const onePlan = (view: PlanView = plan()): PlansService =>
  ({
    get: async () => view,
    forAccount: async () => view,
    forAccounts: async (ids: string[]) => new Map(ids.map((id) => [id, view])),
  }) as unknown as PlansService;

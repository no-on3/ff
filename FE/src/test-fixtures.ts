// Shared by the unit tests: nothing in the console imports it, so it never ships.
import type { Plan } from './services/api';

/** The beta plan, as GET /me shows it (P-15). */
export const BETA_PLAN: Plan = {
  id: 'beta',
  name: 'Beta',
  limits: {
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
  },
};

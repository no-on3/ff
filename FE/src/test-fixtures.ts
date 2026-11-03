// Shared by the unit tests: nothing in the console imports it, so it never ships.
import type { AwsEndpoints, Plan } from './services/api';

/** The beta plan, as GET /me shows it (P-15). */
export const BETA_PLAN: Plan = {
  id: 'beta',
  name: 'Beta',
  limits: {
    functions: 25,
    memoryMb: 1024,
    timeoutSeconds: 300,
    instancesPerFunction: 10,
    codeStorageMb: 5120,
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
    siteTransferGbPerMonth: 10,
    queues: 10,
    eventSourceMappingsPerFunction: 5,
    queueRequestsPerSecond: 100,
    queueStorageMb: 100,
    caches: 1,
    cacheMb: 64,
    emailIdentities: 2,
    emailsPerDay: 200,
    emailsPerSecond: 1,
    accessKeys: 10,
  },
};

/** FF's region and endpoints, as GET /me gives them with an account: each field the API's, as the contract test checks. */
export const AWS_ENDPOINTS: AwsEndpoints = {
  region: 'tn-tunis-1',
  s3Endpoint: 'https://s3.ffunc.cloud',
  sqsEndpoint: 'https://sqs.ffunc.cloud',
  sesEndpoint: 'https://email.ffunc.cloud',
  lambdaEndpoint: 'https://lambda.ffunc.cloud',
};

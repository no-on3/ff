/**
 * L3: the beta's scaling model (client-readiness plan, P-06 and D14) on the
 * live dev cluster: FunctionsService and MetricsService with the real
 * Kubernetes driver and the least-privilege ff-controller token. Records live
 * in memory: what is under test is how calls in flight drive Kubernetes.
 *   npm run test:it -- functions.scaling      (or hack/k8s/test-it.sh)
 */
import { ConfigService } from '@nestjs/config';
import { randomInt } from 'node:crypto';
import * as path from 'node:path';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { MetricsService } from '../metrics/metrics.service';
import { KubeClient, paths } from '../orchestrator/kubernetes/kube-client';
import { KubernetesOrchestrator } from '../orchestrator/kubernetes/kubernetes.orchestrator';
import { accountNamespace } from '../orchestrator/kubernetes/naming';
import { settings } from '../orchestrator/kubernetes/test-fixtures';
import { Function, FunctionStatus, Runtime } from './entities/function.entity';
import { FunctionsService } from './functions.service';
import { recordingAudit } from '../audit/test-fixtures';
import { recordingUsage } from '../usage/test-fixtures';
import { onePlan } from '../plans/test-fixtures';
import { FUNCTION_DEFAULTS, MemoryRepository, eventually } from './test-fixtures';

const run = process.env.K8S_IT === '1' ? describe : describe.skip;
const kubeDir = path.resolve(__dirname, '../../../hack/.kube');

// Sleeps, then says which instance served the call.
const sleeper = `
import * as os from 'node:os';
export async function handler(event: { body: { ms?: number } }) {
  await new Promise((resolve) => setTimeout(resolve, event.body.ms ?? 0));
  return { pod: os.hostname() };
}`;

run('scaling on concurrency against the dev cluster (L3, P-06)', () => {
  jest.setTimeout(300_000);

  const s = settings({
    apiUrl: process.env.K8S_API_URL ?? 'https://127.0.0.1:6550',
    tokenFile: process.env.K8S_TOKEN_FILE ?? path.join(kubeDir, 'ff-controller.token'),
    caFile: process.env.K8S_CA_FILE ?? path.join(kubeDir, 'ca.crt'),
    invokeMode: 'proxy',
    readyTimeoutSeconds: 90,
    ingressAllowCidrs: (process.env.K8S_INGRESS_ALLOW_CIDRS ?? '').split(',').filter(Boolean),
  });
  const client = new KubeClient({ server: s.apiUrl, tokenFile: s.tokenFile, caFile: s.caFile });
  const orchestrator = new KubernetesOrchestrator(s, client);
  const account = String(randomInt(1e12)).padStart(12, '0');
  const ns = accountNamespace(s.namespacePrefix, account);
  // Their account is active, as the database's relation would load it: the minute's tick scales only an active
  // account's functions (P-71), so without it the function never steps down.
  const functions = new MemoryRepository<Function>({
    ...FUNCTION_DEFAULTS,
    account: { id: account, status: AccountStatus.ACTIVE } as Account,
  });
  const config = { get: (_key: string, fallback?: unknown) => fallback } as unknown as ConfigService;
  const metrics = new MetricsService(new MemoryRepository() as never, functions as never, orchestrator, onePlan());
  const service = new FunctionsService(
    functions as never,
    new MemoryRepository() as never,
    { uploadCode: jest.fn(), deleteCode: jest.fn() } as never,
    orchestrator,
    config,
    metrics,
    onePlan(),
    recordingAudit().audit,
    recordingUsage().usage,
    { admit: async () => undefined } as never, // D9's balance check (P-33): every call admitted
  );

  afterAll(async () => {
    for (const fn of functions.rows.values()) await orchestrator.remove(fn).catch(() => undefined);
    await client.delete(paths.namespace(ns)).catch(() => undefined); // allowed: managed ff-t-* namespace
  });

  it('a burst of slow calls scales the function to two instances, and every call succeeds', async () => {
    const fn = await service.create(account, { name: 'it-burst', runtime: Runtime.NODEJS, code: sleeper, memory: 128, timeout: 15 });
    expect(fn.status).toBe(FunctionStatus.ACTIVE);
    await service.updateScalingConfig(account, fn.id, { maxInstances: 2 });
    const limited = functions.byName('it-burst');

    // Four 3 s calls at once. The first instance runs them in turn, the longest waiting
    // about 9 s, within one 15 s timeout; meanwhile the second instance starts.
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => service.invoke(account, fn.id, { ms: 3000 })));

    expect(results.map((r) => (r.status === 'fulfilled' ? 'ok' : String(r.reason)))).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(await orchestrator.desiredInstances(limited)).toBe(2);
    await eventually(async () => (await orchestrator.readyInstances(limited)) === 2, 90_000);

    // Later calls are spread over both instances.
    const pods = new Set<string>();
    for (let i = 0; i < 12; i++) pods.add(((await service.invoke(account, fn.id, {})).output as { pod: string }).pod);
    expect(pods.size).toBe(2);
  });

  it('steps back down to one instance once the calls are over, one per minute', async () => {
    const fn = functions.byName('it-burst');

    await metrics.aggregate(); // the minute of the burst: no change
    expect(await orchestrator.desiredInstances(fn)).toBe(2);
    await metrics.aggregate(); // a quiet minute
    expect(await orchestrator.desiredInstances(fn)).toBe(1);
    await eventually(async () => (await orchestrator.readyInstances(fn)) === 1, 90_000);
  });
});

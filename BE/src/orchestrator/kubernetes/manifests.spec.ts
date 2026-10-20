import { Runtime } from '../../functions/entities/function.entity';
import { CodeTooLargeError } from '../orchestrator.errors';
import {
  BLOCKED_EGRESS_CIDRS,
  MAX_CODE_BYTES,
  codeConfigMapManifest,
  cpuMillicores,
  deploymentManifest,
  namespaceManifest,
  networkPolicyManifest,
  resourceQuotaManifest,
  serviceManifest,
} from './manifests';
import { accountHash } from './naming';
import { settings, workload } from './test-fixtures';

/* eslint-disable @typescript-eslint/no-explicit-any */
const podSpec = (d: any) => d.spec.template.spec;
const container = (d: any) => podSpec(d).containers[0];

describe('Kubernetes manifests', () => {
  it.each([
    [128, 100],
    [512, 289],
    [1769, 1000],
    [10240, 5789],
  ])('gives %i MB of memory %i millicores of CPU (Lambda-proportional, min 100m)', (memory, millicores) => {
    expect(cpuMillicores(memory)).toBe(millicores);
  });

  describe('Namespace', () => {
    it('is marked as FF-managed, enforces Pod Security "restricted", and records its account (P-12)', () => {
      const ns: any = namespaceManifest('ff-t-abc', '123456789012');

      expect(ns.metadata.labels).toMatchObject({
        'app.kubernetes.io/managed-by': 'ff-controller',
        'ff.dev/account-hash': accountHash('123456789012'),
        'pod-security.kubernetes.io/enforce': 'restricted',
        'pod-security.kubernetes.io/warn': 'restricted',
        'pod-security.kubernetes.io/audit': 'restricted',
      });
      expect(ns.metadata.annotations['ff.dev/account-id']).toBe('123456789012');
    });
  });

  describe('Deployment', () => {
    const build = (overrides = {}, s = settings()) =>
      deploymentManifest(workload(overrides), 'ff-t-abc', 'fn-x-0123456789', 'hash', s, 1) as any;

    it('applies the pod security baseline', () => {
      const d = build();

      expect(podSpec(d)).toMatchObject({
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 10001,
          runAsGroup: 10001,
          fsGroup: 10001,
          seccompProfile: { type: 'RuntimeDefault' },
        },
      });
      expect(container(d).securityContext).toEqual({
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ['ALL'] },
      });
    });

    it('uses only volume types allowed by the restricted profile, with code mounted read-only', () => {
      const d = build();

      expect(podSpec(d).volumes).toEqual([
        { name: 'code', configMap: { name: 'fn-x-0123456789', defaultMode: 0o444 } },
        { name: 'tmp', emptyDir: { sizeLimit: '512Mi' } },
      ]);
      expect(container(d).volumeMounts).toEqual([
        { name: 'code', mountPath: '/var/task', readOnly: true },
        { name: 'tmp', mountPath: '/tmp' },
      ]);
    });

    it('sets equal requests and limits from the configured memory', () => {
      expect(container(build()).resources).toEqual({
        requests: { cpu: '289m', memory: '512Mi' },
        limits: { cpu: '289m', memory: '512Mi' },
      });
    });

    it('passes the runtime contract through the environment', () => {
      const env = Object.fromEntries(container(build()).env.map((e: any) => [e.name, e.value]));

      expect(env).toMatchObject({
        FUNCTION_NAME: 'hello',
        FUNCTION_TIMEOUT: '10000',
        // A call waits at most one timeout for a free instance, then gets 429 (D14).
        FF_MAX_QUEUE_WAIT_MS: '10000',
        FUNCTION_MEMORY_LIMIT: '512',
        LAMBDA_TASK_ROOT: '/var/task',
        FF_HANDLER: 'function.handler',
        PORT: '8080',
      });
    });

    it('probes readiness on /readyz and liveness on /healthz', () => {
      const c = container(build());

      expect(c.readinessProbe.httpGet).toEqual({ path: '/readyz', port: 'http' });
      expect(c.livenessProbe.httpGet).toEqual({ path: '/healthz', port: 'http' });
    });

    it('rolls out on code changes without losing availability', () => {
      const d = build();

      expect(d.spec.template.metadata.annotations['ff.dev/code-sha256']).toBe('hash');
      expect(d.spec.strategy.rollingUpdate).toEqual({ maxUnavailable: 0, maxSurge: 1 });
      expect(d.spec.selector.matchLabels).toEqual({ 'ff.dev/function-id': workload().id });
      expect(podSpec(d).terminationGracePeriodSeconds).toBe(15);
    });

    it('sets runtimeClassName only when configured', () => {
      expect(podSpec(build())).not.toHaveProperty('runtimeClassName');
      expect(podSpec(build({}, settings({ runtimeClass: 'gvisor' }))).runtimeClassName).toBe('gvisor');
    });

    it('picks the image for the runtime and rejects unconfigured runtimes', () => {
      expect(container(build({ runtime: Runtime.PYTHON })).image).toBe('ff-runtime-python:3.13-v2');
      expect(() => build({ runtime: 'cobol' })).toThrow('No runtime image configured for runtime "cobol"');
    });
  });

  describe('code ConfigMap', () => {
    it('is immutable and keyed by the runtime file name', () => {
      const cm: any = codeConfigMapManifest(workload(), 'ff-t-abc', 'fn-x-1', 'hash');
      const py: any = codeConfigMapManifest(workload({ runtime: Runtime.PYTHON }), 'ff-t-abc', 'fn-x-1', 'hash');

      expect(cm.immutable).toBe(true);
      expect(Object.keys(cm.data)).toEqual(['function.ts']);
      expect(Object.keys(py.data)).toEqual(['function.py']);
      expect(cm.metadata.labels['ff.dev/function-id']).toBe(workload().id);
    });

    it('accepts code up to the limit and rejects larger code with CodeTooLargeError', () => {
      expect(() => codeConfigMapManifest(workload({ code: 'x'.repeat(MAX_CODE_BYTES) }), 'n', 'c', 'h')).not.toThrow();
      expect(() => codeConfigMapManifest(workload({ code: 'x'.repeat(MAX_CODE_BYTES + 1) }), 'n', 'c', 'h')).toThrow(
        CodeTooLargeError,
      );
    });
  });

  describe('NetworkPolicy', () => {
    it("denies all ingress but the backend's pods, in ff-system: not the platform's other pods there", () => {
      const np: any = networkPolicyManifest('ff-t-abc', settings(), true);

      expect(np.spec.podSelector).toEqual({});
      expect(np.spec.policyTypes).toEqual(['Ingress', 'Egress']);
      expect(np.spec.ingress).toEqual([
        {
          from: [
            {
              namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'ff-system' } },
              podSelector: { matchLabels: { 'app.kubernetes.io/name': 'ff-backend' } },
            },
          ],
        },
      ]);
    });

    it('adds configured ingress CIDRs', () => {
      const np: any = networkPolicyManifest('ff-t-abc', settings({ ingressAllowCidrs: ['10.42.0.1/32'] }), false);

      expect(np.spec.ingress[0].from).toContainEqual({ ipBlock: { cidr: '10.42.0.1/32' } });
    });

    it('allows DNS and, for an account whose egress is on, the internet, but never private, link-local or loopback ranges', () => {
      const np: any = networkPolicyManifest('ff-t-abc', settings(), true);

      expect(np.spec.egress[0].ports).toEqual([
        { protocol: 'UDP', port: 53 },
        { protocol: 'TCP', port: 53 },
      ]);
      expect(np.spec.egress[1].to[0].ipBlock).toEqual({ cidr: '0.0.0.0/0', except: BLOCKED_EGRESS_CIDRS });
      expect(BLOCKED_EGRESS_CIDRS).toEqual(
        expect.arrayContaining(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '127.0.0.0/8']),
      );
    });

    // Each account's own setting, which the operator turns on; the platform's setting cuts every account off.
    it.each([
      ['the account egress off, as every account starts', true, false],
      ['the platform cutting every account off, whatever their setting', false, true],
      ['both', false, false],
    ])('allows only DNS with %s', (_label, platform, account) => {
      const np: any = networkPolicyManifest('ff-t-abc', settings({ egressInternet: platform }), account);

      expect(np.spec.egress).toEqual([expect.objectContaining({ ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] })]);
    });
  });

  it("sizes the tenant ResourceQuota from the account's plan, with pods as a quantity string", () => {
    const quota: any = resourceQuotaManifest('ff-t-abc', { pods: 5, cpu: '2', memory: '4Gi' });

    expect(quota.spec.hard).toMatchObject({
      pods: '5',
      'requests.cpu': '2',
      'limits.cpu': '2',
      'requests.memory': '4Gi',
      'limits.memory': '4Gi',
    });
  });

  it('exposes the runtime port through a ClusterIP Service selecting the function', () => {
    const svc: any = serviceManifest(workload(), 'ff-t-abc');

    expect(svc.spec).toEqual({
      type: 'ClusterIP',
      selector: { 'ff.dev/function-id': workload().id },
      ports: [{ name: 'http', port: 8080, targetPort: 'http', protocol: 'TCP' }],
    });
  });
});

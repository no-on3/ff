import { EventFormat, Runtime } from '../../functions/entities/function.entity';
import {
  BLOCKED_EGRESS_CIDRS,
  INTERNET_PORTS,
  DATA_DB_CA_DIR,
  DATA_DB_CA_SECRET,
  cpuMillicores,
  dataDbCaSecretManifest,
  deploymentManifest,
  environmentSecretManifest,
  namespaceManifest,
  networkPolicyManifest,
  resourceQuotaManifest,
  serviceManifest,
} from './manifests';
import { accountHash } from './naming';
import { CODE_IMAGE, settings, workload } from './test-fixtures';

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
      deploymentManifest(workload(overrides), 'ff-t-abc', 'hash', s, 1) as any;

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

    it("uses only volume types allowed by the restricted profile: the code's image at /var/task, read-only, and /tmp", () => {
      const d = build();

      expect(podSpec(d).volumes).toEqual([
        { name: 'code', image: { reference: CODE_IMAGE, pullPolicy: 'IfNotPresent' } },
        { name: 'tmp', emptyDir: { sizeLimit: '512Mi' } },
      ]);
      expect(container(d).volumeMounts).toEqual([
        { name: 'code', mountPath: '/var/task', readOnly: true },
        { name: 'tmp', mountPath: '/tmp' },
      ]);
    });

    it("names its version by its code's hash, and refuses a function without an image of its code", () => {
      expect(build().spec.template.metadata.annotations['ff.dev/code-sha256']).toBe('hash');
      expect(() => build({ codeImage: undefined })).toThrow(`Function ${workload().id} has no code image`);
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
        FF_EVENT_FORMAT: 'lambda',
        PORT: '8080',
      });
    });

    it('tells the runtime the handler the function names', () => {
      const env = Object.fromEntries(container(build({ handler: 'function.main' })).env.map((e: any) => [e.name, e.value]));

      expect(env.FF_HANDLER).toBe('function.main');
    });

    it("tells the runtime a function made before still gets FF's original event", () => {
      const env = Object.fromEntries(container(build({ eventFormat: EventFormat.WRAPPED })).env.map((e: any) => [e.name, e.value]));

      expect(env.FF_EVENT_FORMAT).toBe('wrapped');
    });

    describe("the function's own variables and secrets", () => {
      const environment = { revision: 'a1b2c3d4e5f60718', values: { DB_HOST: 'db.internal', DB_PASSWORD: 'hunter2' } };
      const withEnvironment = (values: Record<string, string> = environment.values) =>
        deploymentManifest(workload({ environment: { ...environment, values } }), 'ff-t-abc', 'hash', settings(), 1, 'fn-x-env-1') as any;

      it('come from their Secret through envFrom, and the template names their revision, so a change rolls out', () => {
        const d = withEnvironment();

        expect(container(d).envFrom).toEqual([{ secretRef: { name: 'fn-x-env-1' } }]);
        expect(d.spec.template.metadata.annotations).toEqual({ 'ff.dev/code-sha256': 'hash', 'ff.dev/environment-revision': 'a1b2c3d4e5f60718' });
      });

      it('never put a value in the Deployment, which the backend and the cluster read', () => {
        expect(JSON.stringify(withEnvironment())).not.toContain('hunter2');
        expect(JSON.stringify(withEnvironment())).not.toContain('db.internal');
      });

      it("give way to nothing of FF's, but FF's UTC gives way to the function's own TZ", () => {
        const names = (d: any) => container(d).env.map((e: any) => e.name);

        expect(names(withEnvironment())).toContain('TZ');
        expect(container(build()).env).toContainEqual({ name: 'TZ', value: 'UTC' });
        expect(names(withEnvironment({ TZ: 'Africa/Tunis' }))).not.toContain('TZ');
      });

      it('are left out entirely for a function without any, or without the Secret named', () => {
        const unnamed = deploymentManifest(workload({ environment }), 'ff-t-abc', 'hash', settings(), 1) as any;
        for (const d of [build(), withEnvironment({}), unnamed]) {
          expect(container(d).envFrom).toBeUndefined();
          expect(d.spec.template.metadata.annotations).toEqual({ 'ff.dev/code-sha256': 'hash' });
        }
      });
    });

    describe("the CA of customers' database server's certificate (ADR 0008)", () => {
      const withCa = settings({ dataDbCa: '-----BEGIN CERTIFICATE-----\n' });
      const caVolume = { name: 'data-db-ca', secret: { secretName: DATA_DB_CA_SECRET, optional: true } };

      it('is mounted read-only from the tenant\'s Secret, and Node.js trusts it through NODE_EXTRA_CA_CERTS', () => {
        const d: any = deploymentManifest(workload(), 'ff-t-abc', 'sha', withCa, 1);

        expect(podSpec(d).volumes).toContainEqual(caVolume);
        expect(container(d).volumeMounts).toContainEqual({ name: 'data-db-ca', mountPath: DATA_DB_CA_DIR, readOnly: true });
        expect(container(d).env).toContainEqual({ name: 'NODE_EXTRA_CA_CERTS', value: `${DATA_DB_CA_DIR}/ca.crt` });
      });

      it("gives way to a Node.js function's own NODE_EXTRA_CA_CERTS, and names nothing for Python, whose drivers read the file", () => {
        const own: any = deploymentManifest(workload({ environment: { revision: 'r1', values: { NODE_EXTRA_CA_CERTS: '/var/task/ca.pem' } } }), 'ff-t-abc', 'sha', withCa, 1, 'env-0');
        const python: any = deploymentManifest(workload({ runtime: Runtime.PYTHON }), 'ff-t-abc', 'sha', withCa, 1);

        expect(container(own).env.filter((e: any) => e.name === 'NODE_EXTRA_CA_CERTS')).toEqual([]);
        expect(container(python).env.filter((e: any) => e.name === 'NODE_EXTRA_CA_CERTS')).toEqual([]);
        expect(podSpec(python).volumes).toContainEqual(caVolume);
      });

      it('is left out when the certificate is a public one', () => {
        const d: any = deploymentManifest(workload(), 'ff-t-abc', 'sha', settings(), 1);

        expect(podSpec(d).volumes.map((v: any) => v.name)).toEqual(['code', 'tmp']);
        expect(container(d).env.map((e: any) => e.name)).not.toContain('NODE_EXTRA_CA_CERTS');
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
      expect(container(build({ runtime: Runtime.PYTHON })).image).toBe('ff-runtime-python:3.13-v3');
      expect(() => build({ runtime: 'cobol' })).toThrow('No runtime image configured for runtime "cobol"');
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

    it("lets functions reach the platform's services at their addresses, on their one port, whatever the account's internet access", () => {
      const np: any = networkPolicyManifest('ff-t-abc', settings({ platformEgress: [{ cidrs: ['10.199.0.10/32', '203.0.113.7/32'], port: 5432 }] }), false);

      expect(np.spec.egress).toEqual([
        expect.objectContaining({ ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] }),
        { to: [{ ipBlock: { cidr: '10.199.0.10/32' } }, { ipBlock: { cidr: '203.0.113.7/32' } }], ports: [{ protocol: 'TCP', port: 5432 }] },
      ]);
    });

    it("lets functions reach buckets' S3 front door at the backend's own pods, on its port, when no address is named", () => {
      const np: any = networkPolicyManifest('ff-t-abc', settings({ platformEgress: [{ cidrs: ['10.199.0.10/32'], port: 5432 }, { cidrs: [], port: 3002 }] }), false);

      expect(np.spec.egress.slice(1)).toEqual([
        { to: [{ ipBlock: { cidr: '10.199.0.10/32' } }], ports: [{ protocol: 'TCP', port: 5432 }] },
        {
          to: [
            {
              namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'ff-system' } },
              podSelector: { matchLabels: { 'app.kubernetes.io/name': 'ff-backend' } },
            },
          ],
          ports: [{ protocol: 'TCP', port: 3002 }],
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

    it("never opens the internet's port 25, so that mail goes through the SES endpoint alone; every other port, TCP and UDP", () => {
      const ports: Array<{ protocol: string; port: number; endPort: number }> = (networkPolicyManifest('ff-t-abc', settings(), true) as any).spec.egress[1].ports;
      const open = (protocol: string, port: number) => ports.some((rule) => rule.protocol === protocol && rule.port <= port && port <= rule.endPort);

      expect(ports).toBe(INTERNET_PORTS);
      expect([open('TCP', 25), open('TCP', 24), open('TCP', 26), open('TCP', 1), open('TCP', 65535)]).toEqual([false, true, true, true, true]);
      expect([open('TCP', 443), open('TCP', 465), open('TCP', 587), open('UDP', 25), open('UDP', 443)]).toEqual([true, true, true, true, true]);
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

  it("puts the CA of customers' database server's certificate in a Secret of the tenant's, labelled as FF's", () => {
    const secret: any = dataDbCaSecretManifest('ff-t-abc', '-----BEGIN CERTIFICATE-----\nMIIB\n');

    expect(secret).toMatchObject({ kind: 'Secret', metadata: { name: DATA_DB_CA_SECRET, namespace: 'ff-t-abc', labels: { 'app.kubernetes.io/managed-by': 'ff-controller' } } });
    expect(Buffer.from(secret.data['ca.crt'], 'base64').toString()).toBe('-----BEGIN CERTIFICATE-----\nMIIB\n');
  });

  it("puts a function's variables and secrets in a Secret: base64, labelled as the function's, naming only the revision", () => {
    const fn = workload({ environment: { revision: 'a1b2c3d4e5f60718', values: { DB_PASSWORD: 'hunter2', GREETING: 'Ahlan é' } } });
    const secret: any = environmentSecretManifest(fn as any, 'ff-t-abc', 'fn-x-env-0');

    expect(secret).toMatchObject({
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'Opaque',
      metadata: {
        name: 'fn-x-env-0',
        namespace: 'ff-t-abc',
        labels: { 'ff.dev/function-id': fn.id, 'app.kubernetes.io/managed-by': 'ff-controller' },
        annotations: { 'ff.dev/environment-revision': 'a1b2c3d4e5f60718' },
      },
    });
    expect(Object.fromEntries(Object.entries(secret.data).map(([k, v]) => [k, Buffer.from(v as string, 'base64').toString('utf8')]))).toEqual({
      DB_PASSWORD: 'hunter2',
      GREETING: 'Ahlan é',
    });
    expect(JSON.stringify(secret.metadata)).not.toContain('hunter2');
  });

  it("sizes the tenant ResourceQuota from the account's plan, with pods as a quantity string", () => {
    const quota: any = resourceQuotaManifest('ff-t-abc', { pods: 5, cpu: '2', memory: '4Gi' });

    expect(quota.spec.hard).toMatchObject({
      pods: '5',
      'requests.cpu': '2',
      'limits.cpu': '2',
      'requests.memory': '4Gi',
      'limits.memory': '4Gi',
      // Two a function, for its environment, and one each version called, which holds a pod.
      secrets: '65',
      // One a function, and one each version called.
      services: '35',
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

  describe("a version's objects, beside its function's $LATEST (ADR 0015)", () => {
    const id = workload().id;

    it("are its own: named by its number, its pods selected by it, told it as FUNCTION_VERSION", () => {
      const version = workload({ version: 3, lastVersion: 4 });
      const svc: any = serviceManifest(version, 'ff-t-abc');
      const d: any = deploymentManifest(version, 'ff-t-abc', 'hash', settings(), 1);

      expect([svc.metadata.name, d.metadata.name]).toEqual([`fn-${id}-v3`, `fn-${id}-v3`]);
      expect(svc.spec.selector).toEqual({ 'ff.dev/function-id': id, 'ff.dev/version': '3' });
      expect(d.spec.selector.matchLabels).toEqual({ 'ff.dev/function-id': id, 'ff.dev/version': '3' });
      expect(d.spec.template.metadata.labels).toMatchObject({ 'ff.dev/function-id': id, 'ff.dev/version': '3' });
      expect(container(d).env).toContainEqual({ name: 'FUNCTION_VERSION', value: '3' });
    });

    it("give $LATEST's pods a label of their own once the function has a version, and nothing else: its selectors stay", () => {
      const latest: any = deploymentManifest(workload({ lastVersion: 1 }), 'ff-t-abc', 'hash', settings(), 1);
      const never: any = deploymentManifest(workload(), 'ff-t-abc', 'hash', settings(), 1);

      expect(latest.spec.template.metadata.labels['ff.dev/version']).toBe('latest');
      expect(never.spec.template.metadata.labels).not.toHaveProperty('ff.dev/version');
      for (const d of [latest, never]) {
        expect(d.metadata.name).toBe(`fn-${id}`);
        expect(d.spec.selector.matchLabels).toEqual({ 'ff.dev/function-id': id });
        expect(container(d).env).toContainEqual({ name: 'FUNCTION_VERSION', value: '$LATEST' });
      }
      // The Service's selector takes the label once the pods all carry it: the orchestrator's move, not the manifest.
      expect((serviceManifest(workload({ lastVersion: 1 }), 'ff-t-abc') as any).spec.selector).toEqual({ 'ff.dev/function-id': id });
    });
  });
});

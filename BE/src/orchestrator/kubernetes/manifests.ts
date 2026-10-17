/**
 * Pure builders for every Kubernetes object FF creates. Conventions are
 * documented in docs/kubernetes-migration-plan.md §4.
 */
import { Runtime } from '../../functions/entities/function.entity';
import { CodeTooLargeError } from '../orchestrator.errors';
import { FunctionWorkload } from '../orchestrator.types';
import { KubernetesSettings } from './kubernetes.settings';
import { ANNOTATIONS, LABELS, MANAGED_BY, functionResourceName, tenantHash } from './naming';

export interface K8sObject {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export const RUNTIME_PORT = 8080;
/** A ConfigMap holds at most 1 MiB; keep a margin for keys and metadata. */
export const MAX_CODE_BYTES = 900 * 1024;
export const TENANT_QUOTA_NAME = 'ff-tenant-quota';
export const TENANT_LIMITS_NAME = 'ff-tenant-limits';
export const TENANT_NETWORK_POLICY_NAME = 'ff-default-deny';
/** Never reachable from functions: pod/service CIDRs, node IPs, API server, metadata endpoints. */
export const BLOCKED_EGRESS_CIDRS = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '100.64.0.0/10',
  '127.0.0.0/8',
];
const RUNTIME_UID = 10001;

/**
 * How long a call may wait for a free instance before the runtime answers 429:
 * one function timeout. The backend waits this long plus the timeout (P-06, D14).
 */
export function maxQueueWaitMs(fn: Pick<FunctionWorkload, 'timeout'>): number {
  return fn.timeout * 1000;
}

/** Lambda-like proportional CPU: 1,769 MB ≈ 1 vCPU, never below 100m. */
export function cpuMillicores(memoryMb: number): number {
  return Math.max(100, Math.round((memoryMb / 1769) * 1000));
}

export function codeFileName(runtime: Runtime): string {
  return runtime === Runtime.PYTHON ? 'function.py' : 'function.ts';
}

function managedLabels(extra: Record<string, string> = {}): Record<string, string> {
  return { [LABELS.managedBy]: MANAGED_BY, ...extra };
}

function functionLabels(fn: FunctionWorkload): Record<string, string> {
  return managedLabels({
    [LABELS.name]: 'ff-function',
    [LABELS.functionId]: fn.id,
    [LABELS.runtime]: fn.runtime,
  });
}

export function namespaceManifest(name: string, userId: string): K8sObject {
  return {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name,
      labels: managedLabels({
        [LABELS.tenantHash]: tenantHash(userId),
        'pod-security.kubernetes.io/enforce': 'restricted',
        'pod-security.kubernetes.io/enforce-version': 'latest',
        'pod-security.kubernetes.io/warn': 'restricted',
        'pod-security.kubernetes.io/audit': 'restricted',
      }),
      annotations: { [ANNOTATIONS.tenantId]: userId },
    },
  };
}

export function resourceQuotaManifest(namespace: string, settings: KubernetesSettings): K8sObject {
  const { pods, cpu, memory } = settings.tenantQuota;
  return {
    apiVersion: 'v1',
    kind: 'ResourceQuota',
    metadata: { name: TENANT_QUOTA_NAME, namespace, labels: managedLabels() },
    spec: {
      hard: {
        pods,
        'requests.cpu': cpu,
        'limits.cpu': cpu,
        'requests.memory': memory,
        'limits.memory': memory,
        configmaps: '60',
        services: '30',
      },
    },
  };
}

export function limitRangeManifest(namespace: string): K8sObject {
  return {
    apiVersion: 'v1',
    kind: 'LimitRange',
    metadata: { name: TENANT_LIMITS_NAME, namespace, labels: managedLabels() },
    spec: {
      limits: [
        {
          type: 'Container',
          default: { cpu: '100m', memory: '128Mi' },
          defaultRequest: { cpu: '100m', memory: '128Mi' },
          max: { cpu: '6', memory: '10240Mi' },
        },
      ],
    },
  };
}

export function networkPolicyManifest(namespace: string, settings: KubernetesSettings): K8sObject {
  const ingressFrom: unknown[] = [
    { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'ff-system' } } },
    ...settings.ingressAllowCidrs.map((cidr) => ({ ipBlock: { cidr } })),
  ];
  const egress: unknown[] = [
    {
      to: [
        {
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
          podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
        },
      ],
      ports: [
        { protocol: 'UDP', port: 53 },
        { protocol: 'TCP', port: 53 },
      ],
    },
  ];
  if (settings.egressInternet) {
    egress.push({ to: [{ ipBlock: { cidr: '0.0.0.0/0', except: BLOCKED_EGRESS_CIDRS } }] });
  }
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: TENANT_NETWORK_POLICY_NAME, namespace, labels: managedLabels() },
    spec: {
      podSelector: {},
      policyTypes: ['Ingress', 'Egress'],
      ingress: [{ from: ingressFrom }],
      egress,
    },
  };
}

export function codeConfigMapManifest(fn: FunctionWorkload, namespace: string, name: string, hash: string): K8sObject {
  const bytes = Buffer.byteLength(fn.code, 'utf8');
  if (bytes > MAX_CODE_BYTES) throw new CodeTooLargeError(bytes, MAX_CODE_BYTES);
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name,
      namespace,
      labels: functionLabels(fn),
      annotations: { [ANNOTATIONS.codeSha256]: hash },
    },
    immutable: true,
    data: { [codeFileName(fn.runtime)]: fn.code },
  };
}

export function serviceManifest(fn: FunctionWorkload, namespace: string): K8sObject {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: functionResourceName(fn.id), namespace, labels: functionLabels(fn) },
    spec: {
      type: 'ClusterIP',
      selector: { [LABELS.functionId]: fn.id },
      ports: [{ name: 'http', port: RUNTIME_PORT, targetPort: 'http', protocol: 'TCP' }],
    },
  };
}

export function deploymentManifest(
  fn: FunctionWorkload,
  namespace: string,
  configMapName: string,
  hash: string,
  settings: KubernetesSettings,
  replicas: number,
): K8sObject {
  const image = settings.runtimeImages[fn.runtime];
  if (!image) throw new Error(`No runtime image configured for runtime "${fn.runtime}"`);
  const memory = `${fn.memory}Mi`;
  const cpu = `${cpuMillicores(fn.memory)}m`;
  const labels = functionLabels(fn);
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: functionResourceName(fn.id), namespace, labels },
    spec: {
      replicas,
      revisionHistoryLimit: 2,
      progressDeadlineSeconds: 120,
      selector: { matchLabels: { [LABELS.functionId]: fn.id } },
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
      template: {
        metadata: { labels, annotations: { [ANNOTATIONS.codeSha256]: hash } },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          terminationGracePeriodSeconds: fn.timeout + 5,
          ...(settings.runtimeClass ? { runtimeClassName: settings.runtimeClass } : {}),
          securityContext: {
            runAsNonRoot: true,
            runAsUser: RUNTIME_UID,
            runAsGroup: RUNTIME_UID,
            fsGroup: RUNTIME_UID,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: 'function',
              image,
              imagePullPolicy: settings.imagePullPolicy,
              ports: [{ name: 'http', containerPort: RUNTIME_PORT, protocol: 'TCP' }],
              env: [
                { name: 'FUNCTION_NAME', value: fn.name },
                { name: 'FUNCTION_VERSION', value: '$LATEST' },
                { name: 'FUNCTION_MEMORY_LIMIT', value: String(fn.memory) },
                { name: 'FUNCTION_TIMEOUT', value: String(fn.timeout * 1000) },
                { name: 'FF_MAX_QUEUE_WAIT_MS', value: String(maxQueueWaitMs(fn)) },
                { name: 'LAMBDA_TASK_ROOT', value: '/var/task' },
                { name: 'FF_HANDLER', value: 'function.handler' },
                { name: 'PORT', value: String(RUNTIME_PORT) },
                { name: 'TZ', value: 'UTC' },
              ],
              resources: { requests: { cpu, memory }, limits: { cpu, memory } },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              readinessProbe: {
                httpGet: { path: '/readyz', port: 'http' },
                periodSeconds: 2,
                failureThreshold: 3,
              },
              livenessProbe: {
                httpGet: { path: '/healthz', port: 'http' },
                periodSeconds: 10,
                failureThreshold: 3,
              },
              volumeMounts: [
                { name: 'code', mountPath: '/var/task', readOnly: true },
                { name: 'tmp', mountPath: '/tmp' },
              ],
            },
          ],
          volumes: [
            { name: 'code', configMap: { name: configMapName, defaultMode: 0o444 } },
            { name: 'tmp', emptyDir: { sizeLimit: '512Mi' } },
          ],
        },
      },
    },
  };
}

/**
 * Pure builders for every Kubernetes object FF creates. Conventions are
 * documented in docs/kubernetes-migration-plan.md §4.
 */
import { Runtime } from '../../functions/entities/function.entity';
import { FunctionWorkload, TenantLimits, WorkloadEnvironment } from '../orchestrator.types';
import { KubernetesSettings } from './kubernetes.settings';
import { ANNOTATIONS, LABELS, MANAGED_BY, accountHash, functionResourceName } from './naming';

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
export const TENANT_QUOTA_NAME = 'ff-tenant-quota';
export const TENANT_LIMITS_NAME = 'ff-tenant-limits';
export const TENANT_NETWORK_POLICY_NAME = 'ff-default-deny';
/** The Secret, in each tenant namespace, with the CA of customers' database server's certificate (ADR 0008). */
export const DATA_DB_CA_SECRET = 'ff-data-db-ca';
/** Where functions' pods find that CA, and what NODE_EXTRA_CA_CERTS names for Node.js functions. */
export const DATA_DB_CA_DIR = '/etc/ff/data-db';
export const DATA_DB_CA_FILE = `${DATA_DB_CA_DIR}/ca.crt`;
/** Never reachable from functions: pod/service CIDRs, node IPs, API server, metadata endpoints. */
export const BLOCKED_EGRESS_CIDRS = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '100.64.0.0/10',
  '127.0.0.0/8',
];
/**
 * The internet's ports a function reaches, when its account's egress is on: all of them but SMTP's, 25, so that no code
 * sends mail around the SES endpoint's checks and quotas (ADR 0012). Submission's ports, 465 and 587, stay open, as on
 * AWS: a provider's own server checks who sends there.
 */
export const INTERNET_PORTS = [
  { protocol: 'TCP', port: 1, endPort: 24 },
  { protocol: 'TCP', port: 26, endPort: 65535 },
  { protocol: 'UDP', port: 1, endPort: 65535 },
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

export function namespaceManifest(name: string, accountId: string): K8sObject {
  return {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name,
      labels: managedLabels({
        [LABELS.accountHash]: accountHash(accountId),
        'pod-security.kubernetes.io/enforce': 'restricted',
        'pod-security.kubernetes.io/enforce-version': 'latest',
        'pod-security.kubernetes.io/warn': 'restricted',
        'pod-security.kubernetes.io/audit': 'restricted',
      }),
      annotations: { [ANNOTATIONS.accountId]: accountId },
    },
  };
}

/** The account's quota: its plan's, for all its functions together (D5). */
export function resourceQuotaManifest(namespace: string, quota: TenantLimits['quota']): K8sObject {
  const { pods, cpu, memory } = quota;
  return {
    apiVersion: 'v1',
    kind: 'ResourceQuota',
    metadata: { name: TENANT_QUOTA_NAME, namespace, labels: managedLabels() },
    spec: {
      hard: {
        pods: String(pods),
        'requests.cpu': cpu,
        'limits.cpu': cpu,
        'requests.memory': memory,
        'limits.memory': memory,
        configmaps: '60',
        // Two a function at most: its environment's (environmentSecretManifest).
        secrets: '60',
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

/**
 * The account's NetworkPolicy. Its functions resolve names, and reach the internet only when the account's own
 * setting allows it (the operator turns it on) and the platform's K8S_EGRESS_INTERNET doesn't forbid it for
 * every account, never on port 25 (INTERNET_PORTS). Never FF's own network, nor the cloud's metadata addresses (BLOCKED_EGRESS_CIDRS), but for the
 * platform's services that functions use, each at its addresses on its port or ports, whatever the account's internet
 * access: customers' database server, customers' cache server, buckets' S3 front door and queues' SQS endpoint. NetworkPolicy rules add up, so
 * the ranges the internet rule leaves out don't cancel them.
 */
/** The backend's pods, in ff-system, as a NetworkPolicy's peer. */
const BACKEND_PODS = {
  namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'ff-system' } },
  podSelector: { matchLabels: { 'app.kubernetes.io/name': 'ff-backend' } },
};

export function networkPolicyManifest(namespace: string, settings: KubernetesSettings, internetEgress: boolean): K8sObject {
  // Only the backend calls a function: never the other platform pods in ff-system (Keycloak, the console, the
  // admin app, the log store). A backend outside the cluster calls through the API server's proxy, which comes
  // from the node, as k3s lets through.
  const ingressFrom: unknown[] = [
    BACKEND_PODS,
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
  // Customers' database server, the caches' ports of customers' cache server, buckets' S3 front door and queues' SQS
  // endpoint: at their addresses, or the backend's own pods for an endpoint of a backend in the cluster, which its
  // NetworkPolicy lets functions reach on that port.
  for (const service of settings.platformEgress) {
    const to = service.cidrs.length > 0 ? service.cidrs.map((cidr) => ({ ipBlock: { cidr } })) : [BACKEND_PODS];
    egress.push({ to, ports: [{ protocol: 'TCP', port: service.port, ...(service.endPort ? { endPort: service.endPort } : {}) }] });
  }
  if (settings.egressInternet && internetEgress) {
    egress.push({ to: [{ ipBlock: { cidr: '0.0.0.0/0', except: BLOCKED_EGRESS_CIDRS } }], ports: INTERNET_PORTS });
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

/** Whether the function has variables or secrets to be given. */
export function hasEnvironment(fn: FunctionWorkload): fn is FunctionWorkload & { environment: WorkloadEnvironment } {
  return fn.environment !== undefined && Object.keys(fn.environment.values).length > 0;
}

/**
 * The Secret that gives the function's process its variables and secrets,
 * through envFrom. The backend writes it and never reads it back: a pod spec, a
 * Deployment or a ConfigMap never holds a value. It names the environment's
 * revision, never anything derived from the values.
 */
export function environmentSecretManifest(fn: FunctionWorkload & { environment: WorkloadEnvironment }, namespace: string, name: string): K8sObject {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name,
      namespace,
      labels: functionLabels(fn),
      annotations: { [ANNOTATIONS.environmentRevision]: fn.environment.revision },
    },
    type: 'Opaque',
    data: Object.fromEntries(Object.entries(fn.environment.values).map(([key, value]) => [key, Buffer.from(value, 'utf8').toString('base64')])),
  };
}

/**
 * The CAs of customers' database and cache servers' certificates, in the tenant namespace, for the functions' pods to
 * mount: each server's certificate comes from its own when it isn't a public one, as in development (ADR 0008, 0013).
 */
export function dataDbCaSecretManifest(namespace: string, ca: string): K8sObject {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: DATA_DB_CA_SECRET, namespace, labels: managedLabels() },
    type: 'Opaque',
    data: { 'ca.crt': Buffer.from(ca, 'utf8').toString('base64') },
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
  /** The version's code (codeHash): a new one rolls the pods out. */
  hash: string,
  settings: KubernetesSettings,
  replicas: number,
  /** The Secret that holds the function's environment (environmentSecretManifest); none without one. */
  environmentSecret?: string,
): K8sObject {
  const image = settings.runtimeImages[fn.runtime];
  if (!image) throw new Error(`No runtime image configured for runtime "${fn.runtime}"`);
  const codeImage = fn.codeImage;
  if (!codeImage) throw new Error(`Function ${fn.id} has no code image: its code reaches its pods as one (ADR 0003)`);
  const memory = `${fn.memory}Mi`;
  const cpu = `${cpuMillicores(fn.memory)}m`;
  const labels = functionLabels(fn);
  const environment = environmentSecret && hasEnvironment(fn) ? fn.environment : undefined;
  // FF's runtimes run in UTC, unless the function sets TZ itself, as AWS Lambda lets it: its envFrom would lose to env.
  const own = (name: string) => environment !== undefined && Object.prototype.hasOwnProperty.call(environment.values, name);
  const timeZone = own('TZ') ? [] : [{ name: 'TZ', value: 'UTC' }];
  // Node.js trusts the CA of customers' database server, as AWS Lambda's Node.js runtime keeps RDS's for this variable,
  // unless the function names CAs of its own. A Python driver reads the file where the guide says.
  const dataDbCa = settings.dataDbCa !== '';
  const extraCas = dataDbCa && fn.runtime === Runtime.NODEJS && !own('NODE_EXTRA_CA_CERTS') ? [{ name: 'NODE_EXTRA_CA_CERTS', value: DATA_DB_CA_FILE }] : [];
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
        metadata: {
          labels,
          annotations: {
            [ANNOTATIONS.codeSha256]: hash,
            // A new environment is a new version: changing it rolls out, as changing the code does.
            ...(environment ? { [ANNOTATIONS.environmentRevision]: environment.revision } : {}),
          },
        },
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
                { name: 'FF_HANDLER', value: fn.handler },
                // The payload as the event, as on AWS Lambda, or FF's original wrapper for a function made before.
                { name: 'FF_EVENT_FORMAT', value: fn.eventFormat },
                { name: 'PORT', value: String(RUNTIME_PORT) },
                ...timeZone,
                ...extraCas,
              ],
              // The function's own variables and secrets. FF's names above are reserved, so none of them is overridden.
              ...(environment ? { envFrom: [{ secretRef: { name: environmentSecret } }] } : {}),
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
                ...(dataDbCa ? [{ name: 'data-db-ca', mountPath: DATA_DB_CA_DIR, readOnly: true }] : []),
              ],
            },
          ],
          volumes: [
            // The code's image, read-only, pulled by the node like the runtime's (ADR 0003).
            { name: 'code', image: { reference: codeImage, pullPolicy: 'IfNotPresent' } },
            { name: 'tmp', emptyDir: { sizeLimit: '512Mi' } },
            // The tenant's copy, which every deploy writes first (dataDbCaSecretManifest).
            ...(dataDbCa ? [{ name: 'data-db-ca', secret: { secretName: DATA_DB_CA_SECRET, optional: true } }] : []),
          ],
        },
      },
    },
  };
}

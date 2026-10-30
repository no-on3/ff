import { ConfigService } from '@nestjs/config';

export type InvokeMode = 'direct' | 'proxy';

export interface KubernetesSettings {
  apiUrl: string;
  tokenFile: string;
  caFile: string;
  invokeMode: InvokeMode;
  namespacePrefix: string;
  runtimeImages: Record<string, string>;
  imagePullPolicy: string;
  runtimeClass: string;
  readyTimeoutSeconds: number;
  egressInternet: boolean;
  ingressAllowCidrs: string[];
  /** The file holding the log store's delete key (P-45): the Secret victoria-logs-delete-key, mounted. */
  logStoreDeleteKeyFile: string;
  /** What functions reach of the platform whatever their account's internet access: customers' database server, buckets' S3 front door, queues' SQS endpoint. */
  platformEgress: PlatformEgress[];
  /**
   * The CAs of customers' database and cache servers' certificates (PEM, one after the other) when they aren't public
   * ones, which functions' pods get; '' for none.
   */
  dataDbCa: string;
}

/**
 * A platform service functions reach, on one TCP port, or a range of them up to `endPort`: at its addresses, or, with
 * none, at the backend's own pods in ff-system.
 */
export interface PlatformEgress {
  cidrs: string[];
  port: number;
  endPort?: number;
}

/**
 * Resolves the `kubernetes` config block. Inside a cluster (KUBERNETES_SERVICE_HOST
 * set) the API URL defaults to the in-cluster service and functions are called
 * directly; outside, calls go through the API server proxy.
 */
export function resolveKubernetesSettings(
  config: ConfigService,
  env: NodeJS.ProcessEnv = process.env,
): KubernetesSettings {
  const raw = config.get<Omit<KubernetesSettings, 'invokeMode'> & { invokeMode: string }>('kubernetes');
  if (!raw) throw new Error('Missing "kubernetes" configuration');

  const inCluster = Boolean(env.KUBERNETES_SERVICE_HOST);
  const apiUrl =
    raw.apiUrl ||
    (inCluster ? `https://${env.KUBERNETES_SERVICE_HOST}:${env.KUBERNETES_SERVICE_PORT || '443'}` : '');
  if (!apiUrl) {
    throw new Error('K8S_API_URL is not set and the backend is not running inside a Kubernetes cluster');
  }

  const invokeMode = (raw.invokeMode || (inCluster ? 'direct' : 'proxy')) as InvokeMode;
  if (invokeMode !== 'direct' && invokeMode !== 'proxy') {
    throw new Error(`K8S_INVOKE_MODE must be "direct" or "proxy", got "${raw.invokeMode}"`);
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9-])?$/.test(raw.namespacePrefix) || raw.namespacePrefix.length > 40) {
    throw new Error(`Invalid K8S_NAMESPACE_PREFIX "${raw.namespacePrefix}"`);
  }
  return { ...raw, apiUrl, invokeMode };
}

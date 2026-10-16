import { ConfigService } from '@nestjs/config';
import configuration from '../../config/configuration';
import { resolveKubernetesSettings } from './kubernetes.settings';

function settingsFor(env: Record<string, string>) {
  const original = process.env;
  process.env = { ...env };
  try {
    return resolveKubernetesSettings(new ConfigService(configuration()), process.env);
  } finally {
    process.env = original;
  }
}

describe('resolveKubernetesSettings', () => {
  it('outside a cluster: uses K8S_API_URL and invokes through the API server proxy', () => {
    const s = settingsFor({ K8S_API_URL: 'https://127.0.0.1:6550', K8S_TOKEN_FILE: '/t', K8S_CA_FILE: '/c' });

    expect(s).toMatchObject({ apiUrl: 'https://127.0.0.1:6550', invokeMode: 'proxy', tokenFile: '/t', caFile: '/c' });
  });

  it('inside a cluster: defaults to the in-cluster API server and direct calls', () => {
    const s = settingsFor({ KUBERNETES_SERVICE_HOST: '10.43.0.1', KUBERNETES_SERVICE_PORT: '443' });

    expect(s).toMatchObject({
      apiUrl: 'https://10.43.0.1:443',
      invokeMode: 'direct',
      tokenFile: '/var/run/secrets/kubernetes.io/serviceaccount/token',
      caFile: '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
    });
  });

  it('honours an explicit invoke mode', () => {
    expect(settingsFor({ K8S_API_URL: 'https://x', K8S_INVOKE_MODE: 'direct' }).invokeMode).toBe('direct');
  });

  it('parses quotas, ingress CIDRs, egress and runtime images', () => {
    const s = settingsFor({
      K8S_API_URL: 'https://x',
      K8S_INGRESS_ALLOW_CIDRS: '10.42.0.1/32, 172.18.0.0/16',
      K8S_EGRESS_INTERNET: 'false',
      K8S_TENANT_QUOTA_PODS: '5',
      K8S_RUNTIME_IMAGE_NODEJS: 'registry.local/ff-runtime-nodejs:24-v1',
    });

    expect(s.ingressAllowCidrs).toEqual(['10.42.0.1/32', '172.18.0.0/16']);
    expect(s.egressInternet).toBe(false);
    expect(s.tenantQuota.pods).toBe('5');
    expect(s.runtimeImages.nodejs).toBe('registry.local/ff-runtime-nodejs:24-v1');
  });

  it.each([
    [{}, 'K8S_API_URL is not set'],
    [{ K8S_API_URL: 'https://x', K8S_INVOKE_MODE: 'teleport' }, 'K8S_INVOKE_MODE must be'],
    [{ K8S_API_URL: 'https://x', K8S_NAMESPACE_PREFIX: 'Bad_Prefix' }, 'Invalid K8S_NAMESPACE_PREFIX'],
  ])('rejects invalid configuration %p', (env, message) => {
    expect(() => settingsFor(env)).toThrow(message);
  });
});

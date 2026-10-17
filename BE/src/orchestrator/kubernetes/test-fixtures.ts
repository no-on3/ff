// Shared fixtures for the Kubernetes driver specs (not part of the build output's runtime paths).
import { Runtime } from '../../functions/entities/function.entity';
import { FunctionWorkload, TenantLimits } from '../orchestrator.types';
import { KubernetesSettings } from './kubernetes.settings';

export const settings = (overrides: Partial<KubernetesSettings> = {}): KubernetesSettings => ({
  apiUrl: 'http://127.0.0.1:1',
  tokenFile: '',
  caFile: '',
  invokeMode: 'proxy',
  namespacePrefix: 'ff-t-',
  runtimeImages: { nodejs: 'ff-runtime-nodejs:24-v2', python: 'ff-runtime-python:3.13-v2' },
  imagePullPolicy: 'IfNotPresent',
  runtimeClass: '',
  readyTimeoutSeconds: 5,
  egressInternet: true,
  ingressAllowCidrs: [],
  ...overrides,
});

/** An account's limits as the beta plan sets them (D5). */
export const tenant = (quota: Partial<TenantLimits['quota']> = {}): TenantLimits => ({
  quota: { pods: 20, cpu: '8', memory: '8Gi', ...quota },
});

export const workload = (overrides: Partial<FunctionWorkload> = {}): FunctionWorkload => ({
  id: '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f',
  name: 'hello',
  accountId: '123456789012',
  runtime: Runtime.NODEJS,
  code: 'export const handler = async () => 1;',
  memory: 512,
  timeout: 10,
  minInstances: 0,
  maxInstances: 3,
  ...overrides,
});

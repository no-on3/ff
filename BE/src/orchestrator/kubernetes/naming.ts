import { createHash } from 'node:crypto';

/** Every object FF creates carries this; the admission policy relies on it for namespaces. */
export const MANAGED_BY = 'ff-controller';

export const LABELS = {
  managedBy: 'app.kubernetes.io/managed-by',
  name: 'app.kubernetes.io/name',
  functionId: 'ff.dev/function-id',
  runtime: 'ff.dev/runtime',
  tenantHash: 'ff.dev/tenant-hash',
} as const;

export const ANNOTATIONS = {
  tenantId: 'ff.dev/tenant-id',
  codeSha256: 'ff.dev/code-sha256',
} as const;

const FUNCTION_ID = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 12 hex characters of sha256(tenant ID): deterministic, DNS-safe, and doesn't expose the ID. */
export function tenantHash(userId: string): string {
  return sha256(userId).slice(0, 12);
}

export function tenantNamespace(prefix: string, userId: string): string {
  return `${prefix}${tenantHash(userId)}`;
}

/** Deployment and Service name. Function IDs are lowercase UUIDs. */
export function functionResourceName(functionId: string): string {
  const id = functionId.toLowerCase();
  if (!FUNCTION_ID.test(id)) throw new Error(`Function ID "${functionId}" cannot be used in a Kubernetes name`);
  return `fn-${id}`;
}

/** Hash of everything the code ConfigMap contains. */
export function codeHash(runtime: string, code: string): string {
  return sha256(`${runtime}\n${code}`);
}

/** Immutable ConfigMap name: a new code version gets a new name. */
export function codeConfigMapName(functionId: string, hash: string): string {
  return `${functionResourceName(functionId)}-${hash.slice(0, 10)}`;
}

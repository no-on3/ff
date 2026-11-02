import { createHash } from 'node:crypto';

/** Every object FF creates carries this; the admission policy relies on it for namespaces. */
export const MANAGED_BY = 'ff-controller';

export const LABELS = {
  managedBy: 'app.kubernetes.io/managed-by',
  name: 'app.kubernetes.io/name',
  functionId: 'ff.dev/function-id',
  runtime: 'ff.dev/runtime',
  accountHash: 'ff.dev/account-hash',
  /** The version a function's pods run: its number, or LATEST_VERSION once the function has versions (ADR 0015). */
  version: 'ff.dev/version',
} as const;

/** The version label of $LATEST's pods once their function has a version: a label's value can't hold the "$" of $LATEST. */
export const LATEST_VERSION = 'latest';

export const ANNOTATIONS = {
  accountId: 'ff.dev/account-id',
  codeSha256: 'ff.dev/code-sha256',
  environmentRevision: 'ff.dev/environment-revision',
} as const;

const FUNCTION_ID = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 12 hex characters of sha256(account ID): deterministic, DNS-safe, and doesn't expose the ID. */
export function accountHash(accountId: string): string {
  return sha256(accountId).slice(0, 12);
}

/** The account's namespace (D1): ff-t-<accountHash>. */
export function accountNamespace(prefix: string, accountId: string): string {
  return `${prefix}${accountHash(accountId)}`;
}

/** Deployment and Service name. Function IDs are lowercase UUIDs. */
export function functionResourceName(functionId: string): string {
  const id = functionId.toLowerCase();
  if (!FUNCTION_ID.test(id)) throw new Error(`Function ID "${functionId}" cannot be used in a Kubernetes name`);
  return `fn-${id}`;
}

/** A version's Deployment and Service: its function's, then its number. */
export function versionResourceName(functionId: string, version: number): string {
  return `${functionResourceName(functionId)}-v${version}`;
}

/** The Deployment and Service of what a workload runs: a version's, or $LATEST's. */
export function workloadResourceName(fn: { id: string; version?: number }): string {
  return fn.version === undefined ? functionResourceName(fn.id) : versionResourceName(fn.id, fn.version);
}

/** The version label of a workload's pods: its number; for $LATEST, LATEST_VERSION once its function has a version, else none. */
export function versionLabel(fn: { version?: number; lastVersion?: number }): string | undefined {
  if (fn.version !== undefined) return String(fn.version);
  return (fn.lastVersion ?? 0) > 0 ? LATEST_VERSION : undefined;
}

/** Whether a pod or a Deployment of a function, by its labels, runs a published version, rather than $LATEST. */
export function isVersionLabelled(labels: Record<string, string> | undefined): boolean {
  const version = labels?.[LABELS.version];
  return version !== undefined && version !== LATEST_VERSION;
}

/** The Secret a version's environment is written to, once, as it was published: never one of $LATEST's two. */
export function versionEnvironmentSecretName(functionId: string, version: number): string {
  return `${versionResourceName(functionId, version)}-env`;
}

/** A version's code as its pods get it, its runtime and its image: a new one rolls the pods out. */
export function codeHash(runtime: string, codeImage: string): string {
  return sha256(`${runtime}\n${codeImage}`);
}

/** The two Secrets a function's environment is written to, in turn: 0 and 1. */
export type EnvironmentSlot = 0 | 1;

/**
 * A Secret that holds a function's environment. A new environment goes into
 * the one its running version doesn't read, so that the pods of that version
 * keep theirs during a rollout.
 */
export function environmentSecretName(functionId: string, slot: EnvironmentSlot): string {
  return `${functionResourceName(functionId)}-env-${slot}`;
}

/** Which slot an environment Secret's name is; undefined for any other name. */
export function environmentSlotOf(functionId: string, name: string): EnvironmentSlot | undefined {
  if (name === environmentSecretName(functionId, 0)) return 0;
  if (name === environmentSecretName(functionId, 1)) return 1;
  return undefined;
}

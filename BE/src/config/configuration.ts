/**
 * Every environment variable the backend reads, in one schema (client-readiness
 * plan, P-02). The backend checks them all at boot and refuses to start with a
 * message that names each bad variable. The TypeORM CLI and the drift check read
 * only the database part (`databaseConfiguration`), so a migration job needs no
 * Kubernetes or storage settings.
 *
 * "Production" means NODE_ENV=production. There the backend also refuses
 * development settings: FF_AUTH_MODE=dev, the default database and storage
 * credentials, and a missing Keycloak issuer or audience.
 */
import * as fs from 'node:fs';
import { isIP } from 'node:net';
import { z } from 'zod';

/** The configuration is invalid. The message lists each problem, naming its variable. */
export class ConfigurationError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `Invalid configuration (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n` +
        problems.map((problem) => `  - ${problem}`).join('\n'),
    );
    this.name = 'ConfigurationError';
  }
}

export type Env = Record<string, string | undefined>;

/** Development defaults that production refuses (docker-compose.yml, BE/.env.example, infrastructure/seaweedfs). */
export const DEVELOPMENT_CREDENTIALS = {
  DB_PASSWORD: ['postgres'],
  MINIO_ACCESS_KEY: ['minioadmin', 'ffdevaccesskey'],
  MINIO_SECRET_KEY: ['minioadmin', 'ffdevsecretkey-local-only'],
} as const;

const DEV_CORS_ORIGIN = 'http://localhost:5173';
const IN_CLUSTER_SECRETS = '/var/run/secrets/kubernetes.io/serviceaccount';

// ---------- one variable ----------

// A blank value counts as unset, so `NAME=` in an env file means "use the default".
const blankAsUnset = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;
const prepare = (fallback: string | undefined, trim = true) => (value: unknown) =>
  blankAsUnset(trim && typeof value === 'string' ? value.trim() : value) ?? fallback;
const got = (input: unknown): string => (input === undefined ? 'it is not set' : `got ${JSON.stringify(input)}`);

/** A string, with a default; required when there is none. */
function text(fallback?: string, rule?: { test: (value: string) => boolean; expected: string }) {
  const base = z.string({ error: 'is required' });
  return z.preprocess(
    prepare(fallback),
    rule
      ? base.refine(rule.test, { error: (issue) => `must be ${rule.expected}; ${got(issue.input)}` })
      : base,
  );
}

/** A string that may be unset. */
function optionalText(rule?: { test: (value: string) => boolean; expected: string }) {
  const base = z.string();
  return z.preprocess(
    prepare(undefined),
    (rule ? base.refine(rule.test, { error: (issue) => `must be ${rule.expected}; ${got(issue.input)}` }) : base).optional(),
  );
}

/** A credential: never trimmed, and never repeated in an error message. */
function secret(fallback?: string) {
  return z.preprocess(prepare(fallback, false), z.string({ error: 'is required' }));
}

function integer(fallback: number, min: number, max: number) {
  const expected = `a whole number from ${min} to ${max}`;
  return z.preprocess(
    prepare(String(fallback)),
    z
      .string()
      .regex(/^-?\d+$/, { error: (issue) => `must be ${expected}; ${got(issue.input)}` })
      .transform(Number)
      .pipe(
        z
          .number()
          .min(min, { error: (issue) => `must be ${expected}; ${got(String(issue.input))}` })
          .max(max, { error: (issue) => `must be ${expected}; ${got(String(issue.input))}` }),
      ),
  );
}

const port = (fallback: number) => integer(fallback, 1, 65535);

function flag(fallback: boolean) {
  return z.preprocess(
    prepare(String(fallback)),
    z
      .enum(['true', 'false'], { error: (issue) => `must be true or false; ${got(issue.input)}` })
      .transform((value) => value === 'true'),
  );
}

function oneOf<const T extends readonly [string, ...string[]]>(values: T, fallback?: T[number]) {
  return z.preprocess(
    prepare(fallback),
    z.enum(values, { error: (issue) => `must be one of ${values.join(', ')}; ${got(issue.input)}` }),
  );
}

/** A comma-separated list; each item is checked. */
function list(item: { test: (value: string) => boolean; expected: string }, fallback = '') {
  return z.preprocess(
    prepare(fallback),
    z.string().transform((value, ctx) => {
      const items = value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
      for (const bad of items.filter((part) => !item.test(part))) {
        ctx.issues.push({ code: 'custom', input: bad, message: `must be a comma-separated list of ${item.expected}; got ${JSON.stringify(bad)}` });
      }
      return items;
    }),
  );
}

// ---------- formats ----------

function isUrl(value: string, protocols: string[]): boolean {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

const httpUrl = { test: (v: string) => isUrl(v, ['http:', 'https:']), expected: 'an http:// or https:// URL' };
const origin = {
  test: (v: string) => isUrl(v, ['http:', 'https:']) && new URL(v).origin === v.replace(/\/$/, ''),
  expected: 'origins such as https://console.example.com (scheme, host and port only)',
};
const cidr = {
  test: (v: string) => {
    const [address, prefix, extra] = v.split('/');
    const family = isIP(address ?? '');
    const bits = Number(prefix);
    return extra === undefined && family !== 0 && /^\d+$/.test(prefix ?? '') && bits <= (family === 4 ? 32 : 128);
  },
  expected: 'CIDR blocks such as 10.42.0.0/16',
};
const quantity = {
  test: (v: string) => /^\d+(\.\d+)?(m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/.test(v),
  expected: 'a Kubernetes quantity such as 8, 500m or 8Gi',
};
const wholeNumber = { test: (v: string) => /^[1-9]\d*$/.test(v), expected: 'a whole number above 0' };
const dnsSubdomain = {
  test: (v: string) => v.length <= 253 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/.test(v),
  expected: 'a Kubernetes object name (lowercase letters, digits, "-" and ".")',
};
const namespacePrefix = {
  test: (v: string) => v.length <= 40 && /^[a-z0-9]([a-z0-9-]*[a-z0-9-])?$/.test(v),
  expected: 'lowercase letters, digits and "-", at most 40 characters',
};
const imageReference = { test: (v: string) => /^\S+$/.test(v), expected: 'a container image reference' };
const bucketName = {
  test: (v: string) => /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(v),
  expected: 'an S3 bucket name (3 to 63 lowercase letters, digits, "." and "-")',
};
const accountId = { test: (v: string) => /^\d{12}$/.test(v), expected: 'an account ID: 12 digits' };

// ---------- the schema ----------

const nodeEnv = { NODE_ENV: oneOf(['development', 'production', 'test'], 'development') };

const databaseShape = {
  ...nodeEnv,
  DB_HOST: text('localhost'),
  DB_PORT: port(5432),
  DB_USERNAME: text('postgres'),
  DB_PASSWORD: secret('postgres'),
  DB_NAME: text('postgres'),
  DB_SSL: flag(false),
  DB_SSL_CA: optionalText(),
};

const appShape = {
  ...databaseShape,
  PORT: port(3000),
  CORS_ORIGIN: list(origin),

  FF_AUTH_MODE: oneOf(['oidc', 'dev'], 'oidc'),
  FF_DEV_ACCOUNT_ID: optionalText(accountId),
  FF_OIDC_ISSUER: optionalText(httpUrl),
  FF_OIDC_AUDIENCE: optionalText(),
  FF_DEV_USER_ID: optionalText(),

  MINIO_ENDPOINT: text('localhost'),
  MINIO_PORT: port(9003),
  MINIO_USE_SSL: flag(false),
  MINIO_ACCESS_KEY: secret('minioadmin'),
  MINIO_SECRET_KEY: secret('minioadmin'),
  MINIO_BUCKET_NAME: text('functions', bucketName),

  ORCHESTRATOR: oneOf(['kubernetes'], 'kubernetes'),
  FF_READY_TIMEOUT_SECONDS: integer(90, 1, 3600),
  FF_SCALE_TO_ZERO_IDLE_SECONDS: integer(900, 1, 7 * 24 * 3600),

  K8S_API_URL: optionalText(httpUrl),
  K8S_TOKEN_FILE: text(`${IN_CLUSTER_SECRETS}/token`),
  K8S_CA_FILE: text(`${IN_CLUSTER_SECRETS}/ca.crt`),
  K8S_INVOKE_MODE: z.preprocess(prepare(undefined), oneOf(['direct', 'proxy']).optional()),
  K8S_NAMESPACE_PREFIX: text('ff-t-', namespacePrefix),
  K8S_RUNTIME_IMAGE_NODEJS: text('ff-runtime-nodejs:24-v2', imageReference),
  K8S_RUNTIME_IMAGE_PYTHON: text('ff-runtime-python:3.13-v2', imageReference),
  K8S_IMAGE_PULL_POLICY: oneOf(['IfNotPresent', 'Always', 'Never'], 'IfNotPresent'),
  K8S_RUNTIME_CLASS: optionalText(dnsSubdomain),
  K8S_READY_TIMEOUT_SECONDS: integer(90, 1, 3600),
  K8S_EGRESS_INTERNET: flag(true),
  K8S_INGRESS_ALLOW_CIDRS: list(cidr),
  K8S_TENANT_QUOTA_PODS: text('20', wholeNumber),
  K8S_TENANT_QUOTA_CPU: text('8', quantity),
  K8S_TENANT_QUOTA_MEMORY: text('8Gi', quantity),
};

const databaseSchema = z.object(databaseShape);
const appSchema = z.object(appShape);

/** Variables that are still recognized only to explain what replaced them. */
export const OBSOLETE_VARIABLES = ['FF_DEV_USER_ID'];
/** Every variable the backend reads. */
export const VARIABLES = Object.keys(appShape).filter((name) => !OBSOLETE_VARIABLES.includes(name));
type DatabaseEnv = z.infer<typeof databaseSchema>;
type AppEnv = z.infer<typeof appSchema>;

// ---------- rules across variables ----------

function databaseRules(env: DatabaseEnv): string[] {
  const problems: string[] = [];
  if (env.NODE_ENV === 'production' && (DEVELOPMENT_CREDENTIALS.DB_PASSWORD as readonly string[]).includes(env.DB_PASSWORD)) {
    problems.push('DB_PASSWORD must be set, and not to the development default, when NODE_ENV=production');
  }
  if (env.DB_SSL_CA && !env.DB_SSL) problems.push('DB_SSL_CA is set, but DB_SSL is not true');
  return problems;
}

function appRules(env: AppEnv): string[] {
  const problems = databaseRules(env);
  const production = env.NODE_ENV === 'production';

  if (env.FF_DEV_USER_ID !== undefined) {
    problems.push(
      'FF_DEV_USER_ID is no longer read: set FF_AUTH_MODE=dev and FF_DEV_ACCOUNT_ID (12 digits) instead, as in BE/.env.example',
    );
  }
  if (env.FF_AUTH_MODE === 'dev') {
    if (production) problems.push('FF_AUTH_MODE=dev is for development only, and is refused when NODE_ENV=production');
    if (!env.FF_DEV_ACCOUNT_ID) problems.push('FF_DEV_ACCOUNT_ID is required when FF_AUTH_MODE=dev');
  } else {
    const hint = production ? '' : ' (for development without Keycloak, set FF_AUTH_MODE=dev)';
    if (!env.FF_OIDC_ISSUER) problems.push(`FF_OIDC_ISSUER is required when FF_AUTH_MODE is oidc, the default${hint}`);
    if (!env.FF_OIDC_AUDIENCE) problems.push(`FF_OIDC_AUDIENCE is required when FF_AUTH_MODE is oidc, the default${hint}`);
    if (production && env.FF_OIDC_ISSUER && !env.FF_OIDC_ISSUER.startsWith('https://')) {
      problems.push('FF_OIDC_ISSUER must be an https:// URL when NODE_ENV=production');
    }
  }

  if (production) {
    for (const name of ['MINIO_ACCESS_KEY', 'MINIO_SECRET_KEY'] as const) {
      if ((DEVELOPMENT_CREDENTIALS[name] as readonly string[]).includes(env[name])) {
        problems.push(`${name} must be set, and not to a development default, when NODE_ENV=production`);
      }
    }
    if (env.CORS_ORIGIN.length === 0) {
      problems.push("CORS_ORIGIN must be set to the console's origin when NODE_ENV=production");
    }
  }
  return problems;
}

// ---------- parsing ----------

function parse<S extends z.ZodType>(schema: S, env: Env): z.infer<S> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigurationError(
      result.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`),
    );
  }
  return result.data;
}

function readCertificate(name: string, path: string): string {
  let content: string;
  try {
    content = fs.readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigurationError([`${name} cannot be read: ${path} (${(error as NodeJS.ErrnoException).code ?? 'error'})`]);
  }
  if (!content.includes('-----BEGIN CERTIFICATE-----')) {
    throw new ConfigurationError([`${name} must be a PEM file with at least one certificate: ${path}`]);
  }
  return content;
}

/** The `database` block: the same for the backend, the TypeORM CLI and the drift check. */
export interface DatabaseSettings {
  host: string;
  port: number;
  username: string;
  password: string;
  name: string;
  logging: boolean;
  /** TLS to the server: off, or on and verified against `ca` (PEM), else the system's CAs. */
  ssl: false | { ca?: string };
}

function toDatabaseSettings(env: DatabaseEnv): DatabaseSettings {
  return {
    host: env.DB_HOST,
    port: env.DB_PORT,
    username: env.DB_USERNAME,
    password: env.DB_PASSWORD,
    name: env.DB_NAME,
    logging: env.NODE_ENV !== 'production',
    ssl: env.DB_SSL ? { ca: env.DB_SSL_CA ? readCertificate('DB_SSL_CA', env.DB_SSL_CA) : undefined } : false,
  };
}

/** Only the database variables (DB_*, NODE_ENV): for the TypeORM CLI and the drift check. */
export function databaseConfiguration(env: Env = process.env): DatabaseSettings {
  const parsed = parse(databaseSchema, env);
  const problems = databaseRules(parsed);
  if (problems.length > 0) throw new ConfigurationError(problems);
  return toDatabaseSettings(parsed);
}

/** Every variable, checked: the backend's configuration (ConfigModule's `load`). */
export default function configuration(env: Env = process.env) {
  const parsed = parse(appSchema, env);
  const problems = appRules(parsed);
  if (problems.length > 0) throw new ConfigurationError(problems);
  const production = parsed.NODE_ENV === 'production';
  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    cors: {
      origins: parsed.CORS_ORIGIN.length > 0 ? parsed.CORS_ORIGIN : production ? [] : [DEV_CORS_ORIGIN],
    },
    auth: {
      mode: parsed.FF_AUTH_MODE,
      devAccountId: parsed.FF_AUTH_MODE === 'dev' ? parsed.FF_DEV_ACCOUNT_ID : undefined,
      oidc:
        parsed.FF_AUTH_MODE === 'oidc'
          ? { issuer: parsed.FF_OIDC_ISSUER as string, audience: parsed.FF_OIDC_AUDIENCE as string }
          : undefined,
    },
    database: toDatabaseSettings(parsed),
    minio: {
      endPoint: parsed.MINIO_ENDPOINT,
      port: parsed.MINIO_PORT,
      useSSL: parsed.MINIO_USE_SSL,
      accessKey: parsed.MINIO_ACCESS_KEY,
      secretKey: parsed.MINIO_SECRET_KEY,
      bucketName: parsed.MINIO_BUCKET_NAME,
    },
    orchestrator: {
      // Scheduler driver behind the ORCHESTRATOR token (see OrchestratorModule).
      driver: parsed.ORCHESTRATOR,
      // How long create/update wait for a function to become ready.
      readyTimeoutSeconds: parsed.FF_READY_TIMEOUT_SECONDS,
    },
    scaling: {
      // Idle time before a function with scaleToZero and minInstances 0 is scaled to zero.
      scaleToZeroIdleSeconds: parsed.FF_SCALE_TO_ZERO_IDLE_SECONDS,
    },
    // Kubernetes driver settings (docs/kubernetes-migration-plan.md §4.5).
    kubernetes: {
      // Empty: use the in-cluster API server (KUBERNETES_SERVICE_HOST/PORT).
      apiUrl: parsed.K8S_API_URL ?? '',
      tokenFile: parsed.K8S_TOKEN_FILE,
      caFile: parsed.K8S_CA_FILE,
      // Empty: "direct" inside the cluster, "proxy" (through the API server) outside.
      invokeMode: parsed.K8S_INVOKE_MODE ?? '',
      namespacePrefix: parsed.K8S_NAMESPACE_PREFIX,
      runtimeImages: {
        nodejs: parsed.K8S_RUNTIME_IMAGE_NODEJS,
        python: parsed.K8S_RUNTIME_IMAGE_PYTHON,
      },
      imagePullPolicy: parsed.K8S_IMAGE_PULL_POLICY,
      runtimeClass: parsed.K8S_RUNTIME_CLASS ?? '',
      readyTimeoutSeconds: parsed.K8S_READY_TIMEOUT_SECONDS,
      egressInternet: parsed.K8S_EGRESS_INTERNET,
      ingressAllowCidrs: parsed.K8S_INGRESS_ALLOW_CIDRS,
      tenantQuota: {
        pods: parsed.K8S_TENANT_QUOTA_PODS,
        cpu: parsed.K8S_TENANT_QUOTA_CPU,
        memory: parsed.K8S_TENANT_QUOTA_MEMORY,
      },
    },
  };
}

export type AppConfig = ReturnType<typeof configuration>;

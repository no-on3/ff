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
import { DEVELOPMENT_KEY, EncryptionKey, parseKeyRing } from '../encryption/key-ring';

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

export type LogFormat = 'json' | 'text';

/** The log format: FF_LOG_FORMAT, else JSON in production, for the cluster's log store, and readable lines in development. */
export const logFormat = (env: Env): LogFormat =>
  env.FF_LOG_FORMAT === 'json' || env.FF_LOG_FORMAT === 'text' ? env.FF_LOG_FORMAT : env.NODE_ENV === 'production' ? 'json' : 'text';

/** Development defaults that production refuses (docker-compose.yml, BE/.env.example, infrastructure/seaweedfs). */
export const DEVELOPMENT_CREDENTIALS = {
  DB_PASSWORD: ['postgres'],
  MINIO_ACCESS_KEY: ['minioadmin', 'ffdevaccesskey'],
  MINIO_SECRET_KEY: ['minioadmin', 'ffdevsecretkey-local-only'],
  // The development server of customers' databases (docker-compose.yml's data-db).
  FF_DATA_DB_ADMIN_PASSWORD: ['ff-data-admin-dev'],
} as const;

const DEV_CORS_ORIGIN = 'http://localhost:5199';
/**
 * Function URLs in development: http://<id>.fn.localhost:3001/, which every browser, and curl, takes to this
 * machine, as any name under .localhost.
 */
export const DEV_FUNCTION_URL_BASE = 'http://fn.localhost:3001';
/** The admin dashboard in development (P-70): its own fixed port, next to the console's. */
const DEV_ADMIN_URL = 'http://localhost:5198';
/** The console in development: invitation e-mails link to it (P-16). */
const DEV_CONSOLE_URL = 'http://localhost:5199';
/**
 * Who sells, and where transfers go, as pro-formas say it (P-35). The
 * development values are no real seller or account (the IBAN is the usual
 * example of a Tunisian one): production refuses them.
 */
export const DEV_SELLER = {
  FF_SELLER_NAME: 'FF (development, not a seller)',
  FF_SELLER_TAX_ID: '0000000/A/A/M/000',
  FF_SELLER_ADDRESS: 'Tunis, Tunisia',
  FF_BANK_NAME: 'Development bank: no transfer arrives',
  FF_BANK_IBAN: 'TN59 1000 6035 1835 9847 8831',
} as const;
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

/** A credential that may be unset: never trimmed, and never repeated in an error message. */
function optionalSecret() {
  return z.preprocess(prepare(undefined, false), z.string().optional());
}

/** A URL that may hold a password: may be unset, and is never repeated in an error message. */
function optionalSecretUrl(rule: { test: (value: string) => boolean; expected: string }) {
  return z.preprocess(prepare(undefined), z.string().refine(rule.test, { error: `must be ${rule.expected}` }).optional());
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

/** A flag whose default depends on the environment: undefined when unset. */
function optionalFlag() {
  return z.preprocess(
    prepare(undefined),
    z
      .enum(['true', 'false'], { error: (issue) => `must be true or false; ${got(issue.input)}` })
      .transform((value) => value === 'true')
      .optional(),
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
/** A proxy Express may trust: an address, a CIDR, or one of its named ranges (loopback, linklocal, uniquelocal). */
const trustedProxy = {
  test: (value: string) => {
    if (['loopback', 'linklocal', 'uniquelocal'].includes(value)) return true;
    const [address, bits, ...rest] = value.split('/');
    const family = isIP(address);
    if (!family || rest.length) return false;
    return bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= (family === 4 ? 32 : 128));
  },
  expected: 'an IP address, a CIDR such as 10.42.0.0/16, or loopback, linklocal or uniquelocal',
};
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
const dnsSubdomain = {
  test: (v: string) => v.length <= 253 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/.test(v),
  expected: 'a Kubernetes object name (lowercase letters, digits, "-" and ".")',
};
// The admission policy (deploy/k8s/base/40-admission-policy.yaml) only lets the
// backend manage namespaces with this prefix: any other would make every deploy fail.
const namespacePrefix = {
  test: (v: string) => v === 'ff-t-',
  expected: 'ff-t-, the only prefix the admission policy allows (deploy/k8s/base/40-admission-policy.yaml)',
};
const imageReference = { test: (v: string) => /^\S+$/.test(v), expected: 'a container image reference' };
/** A registry as an image reference names it: a host, and a port if any. */
const registryHost = {
  test: (v: string) => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i.test(v),
  expected: 'a registry host, and its port if any, such as ff-dev-registry:5000',
};
const bucketName = {
  test: (v: string) => /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(v),
  expected: 'an S3 bucket name (3 to 63 lowercase letters, digits, "." and "-")',
};
const accountId = { test: (v: string) => /^\d{12}$/.test(v), expected: 'an account ID: 12 digits' };
/** An IBAN: country, check digits and account, its check digits right (ISO 13616). Spaces are allowed. */
const iban = {
  test: (v: string) => {
    const compact = v.replace(/ /g, '');
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
    const digits = [...compact.slice(4) + compact.slice(0, 4)].map((c) => parseInt(c, 36)).join('');
    return BigInt(digits) % 97n === 1n;
  },
  expected: 'an IBAN, such as TN59 1000 6035 1835 9847 8831, its check digits right',
};
const smtpUrl = {
  test: (v: string) => isUrl(v, ['smtp:', 'smtps:']),
  expected: 'an smtp:// or smtps:// URL, such as smtp://localhost:51025 (credentials go in it: smtps://user:password@host)',
};
/** A region's name, as AWS's are made: letters, then a word, then a number, such as tn-tunis-1 or eu-west-3. */
const region = { test: (v: string) => /^[a-z]{2,4}(-[a-z]+)+-\d{1,2}$/.test(v), expected: 'a region name, such as tn-tunis-1' };
/** An IP address, as the edge's are given. */
const ipAddress = { test: (v: string) => isIP(v) !== 0, expected: 'IP addresses, such as 203.0.113.10 or 2001:db8::10' };
/** A DNS server: an IP address, with a port after a colon, IPv6 in brackets then. */
const dnsServer = {
  test: (v: string) => {
    const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(v);
    if (bracketed) return isIP(bracketed[1]) === 6 && (!bracketed[2] || Number(bracketed[2]) <= 65535);
    const [address, port, ...rest] = v.split(':');
    if (isIP(v) === 6) return true;
    return rest.length === 0 && isIP(address) === 4 && (port === undefined || (/^\d{1,5}$/.test(port) && Number(port) <= 65535));
  },
  expected: 'DNS servers, an IP address and a port if not 53, such as 10.43.0.10 or 127.0.0.1:5353',
};
/** Where function URLs live: a scheme, a host under which each URL is <id>.<host>, and a port if any; no path. */
const functionUrlBase = {
  test: (v: string) => {
    try {
      const url = new URL(v);
      return ['http:', 'https:'].includes(url.protocol) && url.origin === v.replace(/\/$/, '') && url.hostname.includes('.');
    } catch {
      return false;
    }
  },
  expected: 'an origin whose host has a dot, such as https://fn.example.tn, under which each function URL is https://<id>.fn.example.tn/',
};
/** A server's address as clients name it: a host name or an IP address, without a port. */
const serverHost = {
  test: (v: string) => isIP(v) !== 0 || (v.length <= 253 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(v)),
  expected: 'a host name or an IP address, such as db.example.tn or 10.199.0.10',
};
/** A PostgreSQL role's name, as the backend's role is named. */
const roleName = { test: (v: string) => /^[a-z_][a-z0-9_]{0,62}$/.test(v), expected: 'a PostgreSQL role name: lower-case letters, digits and underscores' };
const emailAddress = { test: (v: string) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v), expected: 'an e-mail address' };
const mailbox = {
  test: (v: string) => emailAddress.test(v) || /^[^<>]*<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>$/.test(v),
  expected: 'an e-mail address, or "Name <address>"',
};

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
  // JSON a line, or readable lines; JSON by default in production (main.ts reads it before the configuration).
  FF_LOG_FORMAT: z.preprocess(prepare(undefined), oneOf(['json', 'text']).optional()),
  // The operator's metrics, in Prometheus's text format: their port (0: none) and address, never the API's.
  FF_METRICS_PORT: integer(9464, 0, 65535),
  FF_METRICS_HOST: text('127.0.0.1'),
  // The database server's disk, in bytes, which the metrics report beside the database's size; 0: unknown.
  FF_DATABASE_DISK_BYTES: integer(0, 0, Number.MAX_SAFE_INTEGER),
  CORS_ORIGIN: list(origin),
  // The OpenAPI document and its viewer at /api: on in development, off in production unless set.
  FF_API_DOCS: optionalFlag(),
  // The proxies whose X-Forwarded-For the backend believes: addresses, CIDRs, or Express's named ranges. None by default.
  FF_TRUST_PROXY: list(trustedProxy),

  FF_AUTH_MODE: oneOf(['oidc', 'dev'], 'oidc'),
  FF_DEV_ACCOUNT_ID: optionalText(accountId),
  FF_OIDC_ISSUER: optionalText(httpUrl),
  FF_OIDC_AUDIENCE: optionalText(),
  // Where the realm's keys are, when not where its public OpenID configuration says: in a cluster, Keycloak's own
  // Service, so that the backend never goes out through the edge to reach it. Tokens still name FF_OIDC_ISSUER.
  FF_OIDC_JWKS_URL: optionalText(httpUrl),
  FF_DEV_USER_ID: optionalText(),

  MINIO_ENDPOINT: text('localhost'),
  MINIO_PORT: port(9003),
  MINIO_USE_SSL: flag(false),
  MINIO_ACCESS_KEY: secret('minioadmin'),
  MINIO_SECRET_KEY: secret('minioadmin'),
  MINIO_BUCKET_NAME: text('functions', bucketName),

  ORCHESTRATOR: oneOf(['kubernetes'], 'kubernetes'),
  FF_READY_TIMEOUT_SECONDS: integer(90, 1, 3600),
  // How often the job that deletes old invocation history and closed accounts' data runs; tests shorten it.
  FF_RETENTION_INTERVAL_SECONDS: integer(3600, 5, 86400),
  // How often the backend sends the notifications that are due: e-mails and webhooks; tests shorten it.
  FF_NOTIFY_INTERVAL_SECONDS: integer(10, 1, 3600),
  // Lets webhooks reach private addresses, such as a receiver on this machine: for development and tests only.
  FF_WEBHOOK_ALLOW_PRIVATE: flag(false),
  // How often alarms are evaluated, and how long a period has been over before it is judged; tests shorten both.
  FF_ALARM_INTERVAL_SECONDS: integer(60, 1, 3600),
  FF_ALARM_SETTLE_SECONDS: integer(60, 0, 3600),
  // How often the scheduler takes the schedules due (0: never, a backend that runs none); and FF's region, which
  // events name, as AWS's do theirs.
  FF_SCHEDULER_INTERVAL_SECONDS: integer(5, 0, 60),
  FF_REGION: text('tn-tunis-1', region),
  FF_SCALE_TO_ZERO_IDLE_SECONDS: optionalText(),

  K8S_API_URL: optionalText(httpUrl),
  K8S_TOKEN_FILE: text(`${IN_CLUSTER_SECRETS}/token`),
  K8S_CA_FILE: text(`${IN_CLUSTER_SECRETS}/ca.crt`),
  K8S_INVOKE_MODE: z.preprocess(prepare(undefined), oneOf(['direct', 'proxy']).optional()),
  K8S_NAMESPACE_PREFIX: text('ff-t-', namespacePrefix),
  K8S_RUNTIME_IMAGE_NODEJS: text('ff-runtime-nodejs:24-v3', imageReference),
  K8S_RUNTIME_IMAGE_PYTHON: text('ff-runtime-python:3.13-v3', imageReference),
  K8S_IMAGE_PULL_POLICY: oneOf(['IfNotPresent', 'Always', 'Never'], 'IfNotPresent'),
  // The sandbox customers' code runs in (gvisor); production requires one, unless K8S_ALLOW_UNSANDBOXED says otherwise.
  K8S_RUNTIME_CLASS: optionalText(dnsSubdomain),
  // Production without a sandbox: only for a cluster that tries the platform's manifests, never with customers' code.
  K8S_ALLOW_UNSANDBOXED: flag(false),
  K8S_READY_TIMEOUT_SECONDS: integer(90, 1, 3600),
  // Each account's own setting decides whether its functions reach the internet (off until the operator turns it
  // on); false cuts every account off, whatever its setting.
  K8S_EGRESS_INTERNET: flag(true),
  K8S_INGRESS_ALLOW_CIDRS: list(cidr),
  // P-45: where the backend finds the log store's delete key; P-60 mounts the Secret here.
  K8S_LOG_STORE_DELETE_KEY_FILE: text('/etc/ff/victoria-logs-delete-key/key'),
  K8S_TENANT_QUOTA_PODS: optionalText(),
  K8S_TENANT_QUOTA_CPU: optionalText(),
  K8S_TENANT_QUOTA_MEMORY: optionalText(),

  FF_SMTP_URL: optionalSecretUrl(smtpUrl),
  FF_MAIL_FROM: text('FF <no-reply@ff.localhost>', mailbox),
  FF_OPERATOR_EMAIL: optionalText(emailAddress),
  FF_ADMIN_URL: text(DEV_ADMIN_URL, httpUrl),
  FF_CONSOLE_URL: text(DEV_CONSOLE_URL, httpUrl),

  FF_SELLER_NAME: text(DEV_SELLER.FF_SELLER_NAME),
  FF_SELLER_TAX_ID: text(DEV_SELLER.FF_SELLER_TAX_ID),
  FF_SELLER_ADDRESS: text(DEV_SELLER.FF_SELLER_ADDRESS),
  FF_BANK_NAME: text(DEV_SELLER.FF_BANK_NAME),
  FF_BANK_IBAN: text(DEV_SELLER.FF_BANK_IBAN, iban),
  FF_BANK_BIC: optionalText(),

  // Function URLs: the port of the server that answers them, apart from the API's (0: none), and where they live.
  FF_FUNCTION_URL_PORT: integer(3001, 0, 65535),
  FF_FUNCTION_URL_BASE: text(DEV_FUNCTION_URL_BASE, functionUrlBase),
  // Customers' own domains: the edge's addresses, which a domain apex points to (none: not checked), and the DNS
  // servers that check domains' records (none: the system's).
  FF_EDGE_ADDRESSES: list(ipAddress),
  FF_DOMAIN_RESOLVERS: list(dnsServer),

  // The keys that encrypt functions' environment variables and secrets at rest: one a line, <id>:<32 bytes in base64>,
  // the first sealing. Unset: the development key, which production refuses.
  FF_ENCRYPTION_KEYS_FILE: optionalText(),

  // Functions' code images (ADR 0003): the registry the backend pushes them to (unset: no function can be deployed), the
  // host the cluster's nodes pull them from (the registry's own by default), and a push's credentials, if it needs any.
  FF_CODE_REGISTRY: optionalText(httpUrl),
  FF_CODE_REGISTRY_PULL: optionalText(registryHost),
  FF_CODE_REGISTRY_USERNAME: optionalText(),
  FF_CODE_REGISTRY_PASSWORD: optionalSecret(),

  // Customers' databases (ADR 0008): their server as customers and functions reach it (unset: no databases, the API
  // answers 503), its port, where the backend reaches it if elsewhere, and the backend's role there; the addresses
  // functions reach it at, for their NetworkPolicy; and the CA of its certificate when it isn't a public one, which
  // functions' pods get too.
  FF_DATA_DB_HOST: optionalText(serverHost),
  FF_DATA_DB_PORT: port(5432),
  FF_DATA_DB_ADMIN_HOST: optionalText(serverHost),
  FF_DATA_DB_ADMIN_USER: text('ff_admin', roleName),
  FF_DATA_DB_ADMIN_PASSWORD: optionalSecret(),
  FF_DATA_DB_CIDRS: list(cidr),
  FF_DATA_DB_CA_FILE: optionalText(),
};

const databaseSchema = z.object(databaseShape);
const appSchema = z.object(appShape);

/** Variables that are still recognized only to explain what replaced them. */
export const OBSOLETE_VARIABLES = [
  'FF_DEV_USER_ID',
  'FF_SCALE_TO_ZERO_IDLE_SECONDS',
  'K8S_TENANT_QUOTA_PODS',
  'K8S_TENANT_QUOTA_CPU',
  'K8S_TENANT_QUOTA_MEMORY',
];
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

  if (!env.FF_CODE_REGISTRY && env.FF_CODE_REGISTRY_PULL) {
    problems.push('FF_CODE_REGISTRY_PULL is set, but FF_CODE_REGISTRY is not: the backend pushes code images to FF_CODE_REGISTRY');
  }
  if (!!env.FF_CODE_REGISTRY_USERNAME !== !!env.FF_CODE_REGISTRY_PASSWORD) {
    problems.push('FF_CODE_REGISTRY_USERNAME and FF_CODE_REGISTRY_PASSWORD go together: set both, or neither for a registry without a login');
  }

  if (env.FF_DATA_DB_HOST) {
    if (!env.FF_DATA_DB_ADMIN_PASSWORD) problems.push("FF_DATA_DB_ADMIN_PASSWORD is required when FF_DATA_DB_HOST is set: it is the backend's role's on customers' database server");
    if (env.FF_DATA_DB_CIDRS.length === 0) {
      problems.push("FF_DATA_DB_CIDRS is required when FF_DATA_DB_HOST is set: functions reach customers' database server only at these addresses, through their NetworkPolicy");
    }
  } else {
    const without = (['FF_DATA_DB_ADMIN_HOST', 'FF_DATA_DB_ADMIN_PASSWORD', 'FF_DATA_DB_CA_FILE'] as const).filter((name) => env[name] !== undefined);
    if (env.FF_DATA_DB_CIDRS.length > 0) without.push('FF_DATA_DB_CIDRS' as (typeof without)[number]);
    for (const name of without) problems.push(`${name} is set, but FF_DATA_DB_HOST is not: it names customers' database server`);
  }

  if (env.FF_DEV_USER_ID !== undefined) {
    problems.push(
      'FF_DEV_USER_ID is no longer read: set FF_AUTH_MODE=dev and FF_DEV_ACCOUNT_ID (12 digits) instead, as in BE/.env.example',
    );
  }
  // Since P-15 (2026-10-17), each account's plan sets these (D5).
  if (env.FF_SCALE_TO_ZERO_IDLE_SECONDS !== undefined) {
    problems.push("FF_SCALE_TO_ZERO_IDLE_SECONDS is no longer read: each account's plan sets its idle window (plans.limits.idleSeconds); remove it");
  }
  for (const name of ['K8S_TENANT_QUOTA_PODS', 'K8S_TENANT_QUOTA_CPU', 'K8S_TENANT_QUOTA_MEMORY'] as const) {
    if (env[name] !== undefined) problems.push(`${name} is no longer read: each account's plan sets its quota (plans.limits.quota); remove it`);
  }
  // FF tags its runtime images by their protocol: before 3, a runtime hands every function FF's original wrapper as
  // its event, which a function made now, given AWS Lambda's, would misread at every call.
  for (const [name, image] of [['K8S_RUNTIME_IMAGE_NODEJS', env.K8S_RUNTIME_IMAGE_NODEJS], ['K8S_RUNTIME_IMAGE_PYTHON', env.K8S_RUNTIME_IMAGE_PYTHON]] as const) {
    const protocol = /:[^/:]*-v([12])$/.exec(image)?.[1];
    if (protocol) {
      problems.push(
        `${name} names a runtime of protocol ${protocol} (${image}), which gives functions FF's original event: they now get AWS Lambda's, which takes protocol 3 (-v3)`,
      );
    }
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
      problems.push("CORS_ORIGIN must be set to the console's and the admin dashboard's origins when NODE_ENV=production");
    }
    // The beta's sign-ups wait for your approval (P-12): their e-mails must reach you.
    if (!env.FF_SMTP_URL) problems.push('FF_SMTP_URL is required when NODE_ENV=production, so that e-mails are sent');
    if (env.FF_CONSOLE_URL === DEV_CONSOLE_URL) {
      problems.push("FF_CONSOLE_URL must be set when NODE_ENV=production: invitation e-mails link to the console");
    }
    if (!env.FF_OPERATOR_EMAIL) {
      problems.push('FF_OPERATOR_EMAIL is required when NODE_ENV=production: new accounts wait for your approval there');
    }
    // Customers' code runs in gVisor (deploy/k8s/optional/runtimeclass-gvisor.yaml), not on the node's kernel.
    if (!env.K8S_RUNTIME_CLASS && !env.K8S_ALLOW_UNSANDBOXED) {
      problems.push(
        "K8S_RUNTIME_CLASS must name the sandbox functions run in (gvisor) when NODE_ENV=production; K8S_ALLOW_UNSANDBOXED=true runs them without one, for a cluster that only tries the platform's manifests",
      );
    }
    if (!env.FF_FUNCTION_URL_BASE.startsWith('https://')) {
      problems.push('FF_FUNCTION_URL_BASE must be an https:// origin when NODE_ENV=production, such as https://fn.example.tn: function URLs are served over TLS');
    }
    if (!env.FF_ENCRYPTION_KEYS_FILE) {
      problems.push("FF_ENCRYPTION_KEYS_FILE is required when NODE_ENV=production: its keys encrypt functions' environment variables and secrets");
    }
    // Every function's code reaches its pods as an image (ADR 0003): without a registry, none could be deployed.
    if (!env.FF_CODE_REGISTRY) {
      problems.push("FF_CODE_REGISTRY is required when NODE_ENV=production: every function's code reaches its pods as an image from the code registry (deploy/k8s/README.md, \"The code registry\")");
    }
    if (env.FF_WEBHOOK_ALLOW_PRIVATE) {
      problems.push("FF_WEBHOOK_ALLOW_PRIVATE is for development only: in production a customer's webhook must never reach FF's own network");
    }
    if (env.FF_DATA_DB_ADMIN_PASSWORD && (DEVELOPMENT_CREDENTIALS.FF_DATA_DB_ADMIN_PASSWORD as readonly string[]).includes(env.FF_DATA_DB_ADMIN_PASSWORD)) {
      problems.push('FF_DATA_DB_ADMIN_PASSWORD must not be the development default when NODE_ENV=production');
    }
    for (const name of Object.keys(DEV_SELLER) as Array<keyof typeof DEV_SELLER>) {
      if (env[name] === DEV_SELLER[name]) problems.push(`${name} must be set when NODE_ENV=production: pro-formas name the seller and where to pay (P-35)`);
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

/**
 * The platform's encryption keys: the keys file's, read and checked at start,
 * else the development key, which production refuses (appRules). A problem
 * names the file and its line, never a key.
 */
function encryptionKeys(path: string | undefined, production: boolean): EncryptionKey[] {
  if (!path) return [DEVELOPMENT_KEY];
  let text: string;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigurationError([`FF_ENCRYPTION_KEYS_FILE cannot be read: ${path} (${(error as NodeJS.ErrnoException).code ?? 'error'})`]);
  }
  const { ring, problems } = parseKeyRing(text);
  if (!ring) throw new ConfigurationError(problems.map((problem) => `FF_ENCRYPTION_KEYS_FILE ${path}: ${problem}`));
  if (production && ring.holdsDevelopmentKey()) {
    throw new ConfigurationError([`FF_ENCRYPTION_KEYS_FILE ${path} holds the development key, which protects nothing: refused when NODE_ENV=production`]);
  }
  return [...ring.keys];
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

/** Customers' database server (ADR 0008), as the backend reaches it, and as connection strings and functions name it. */
export interface DataDbSettings {
  /** In connection strings: as customers and functions reach the server. */
  host: string;
  port: number;
  /** Where the backend reaches it: its host unless told otherwise. */
  adminHost: string;
  adminUser: string;
  adminPassword: string;
  /** The addresses functions reach it at: their NetworkPolicy's rule. */
  cidrs: string[];
  /** The CA of its certificate (PEM), when it isn't a public one: the backend checks the server against it, and functions get it. */
  ca?: string;
}

function dataDbSettings(env: AppEnv): DataDbSettings | null {
  if (!env.FF_DATA_DB_HOST) return null;
  return {
    host: env.FF_DATA_DB_HOST,
    port: env.FF_DATA_DB_PORT,
    adminHost: env.FF_DATA_DB_ADMIN_HOST ?? env.FF_DATA_DB_HOST,
    adminUser: env.FF_DATA_DB_ADMIN_USER,
    adminPassword: env.FF_DATA_DB_ADMIN_PASSWORD as string,
    cidrs: env.FF_DATA_DB_CIDRS,
    ...(env.FF_DATA_DB_CA_FILE ? { ca: readCertificate('FF_DATA_DB_CA_FILE', env.FF_DATA_DB_CA_FILE) } : {}),
  };
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
  const dataDb = dataDbSettings(parsed);
  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    // How the API is served: its documents, and the proxies in front of it.
    http: {
      apiDocs: parsed.FF_API_DOCS ?? !production,
      trustProxy: parsed.FF_TRUST_PROXY,
    },
    cors: {
      origins: parsed.CORS_ORIGIN.length > 0 ? parsed.CORS_ORIGIN : production ? [] : [DEV_CORS_ORIGIN, DEV_ADMIN_URL],
    },
    auth: {
      mode: parsed.FF_AUTH_MODE,
      devAccountId: parsed.FF_AUTH_MODE === 'dev' ? parsed.FF_DEV_ACCOUNT_ID : undefined,
      oidc:
        parsed.FF_AUTH_MODE === 'oidc'
          ? {
              issuer: parsed.FF_OIDC_ISSUER as string,
              audience: parsed.FF_OIDC_AUDIENCE as string,
              ...(parsed.FF_OIDC_JWKS_URL ? { jwksUrl: parsed.FF_OIDC_JWKS_URL } : {}),
            }
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
    // What FF keeps only for a while: how often the job that deletes it runs.
    retention: {
      intervalSeconds: parsed.FF_RETENTION_INTERVAL_SECONDS,
    },
    // Notifications: how often the due ones are sent, and whether a webhook may reach a private address.
    notifications: {
      intervalSeconds: parsed.FF_NOTIFY_INTERVAL_SECONDS,
      allowPrivate: parsed.FF_WEBHOOK_ALLOW_PRIVATE,
    },
    // The log: JSON a line, or readable lines (main.ts reads it the same way, before the configuration).
    logFormat: logFormat(env),
    // The operator's metrics: where Prometheus scrapes them; port 0 serves none.
    monitoring: {
      metricsPort: parsed.FF_METRICS_PORT,
      metricsHost: parsed.FF_METRICS_HOST,
      databaseDiskBytes: parsed.FF_DATABASE_DISK_BYTES,
    },
    // Alarms: how often they are evaluated, and how long a period has been over before it is judged, as a call ending then still counts in it.
    alarms: {
      intervalSeconds: parsed.FF_ALARM_INTERVAL_SECONDS,
      settleSeconds: parsed.FF_ALARM_SETTLE_SECONDS,
    },
    // Schedules: how often the due ones are taken, and the region their events name.
    schedules: {
      intervalSeconds: parsed.FF_SCHEDULER_INTERVAL_SECONDS,
      region: parsed.FF_REGION,
    },
    mail: {
      // Empty: e-mails are written to the log instead of being sent.
      smtpUrl: parsed.FF_SMTP_URL ?? '',
      from: parsed.FF_MAIL_FROM,
      // Who is told about each new account (P-12); empty: nobody.
      operatorEmail: parsed.FF_OPERATOR_EMAIL ?? '',
      // The admin dashboard (P-70), linked from those e-mails.
      adminUrl: parsed.FF_ADMIN_URL.replace(/\/$/, ''),
      // The console, which invitation e-mails link to (P-16).
      consoleUrl: parsed.FF_CONSOLE_URL.replace(/\/$/, ''),
    },
    // Function URLs: the server that answers them, and the origin under which each is <id>.<host>.
    functionUrls: {
      port: parsed.FF_FUNCTION_URL_PORT,
      base: parsed.FF_FUNCTION_URL_BASE.replace(/\/$/, ''),
      edgeAddresses: parsed.FF_EDGE_ADDRESSES,
      domainResolvers: parsed.FF_DOMAIN_RESOLVERS,
    },
    // Functions' code images (ADR 0003): where they are pushed, and where nodes pull them from; none without a registry.
    codeImages: {
      registry: parsed.FF_CODE_REGISTRY?.replace(/\/$/, '') ?? '',
      pullHost: parsed.FF_CODE_REGISTRY_PULL ?? (parsed.FF_CODE_REGISTRY ? new URL(parsed.FF_CODE_REGISTRY).host : ''),
      username: parsed.FF_CODE_REGISTRY_USERNAME ?? '',
      password: parsed.FF_CODE_REGISTRY_PASSWORD ?? '',
    },
    // Customers' databases (ADR 0008): their server, the backend's role there, and how functions reach it; null without one.
    dataDb,
    // What FF keeps encrypted at rest (functions' environments) is sealed with these keys, the first sealing.
    encryption: {
      keys: encryptionKeys(parsed.FF_ENCRYPTION_KEYS_FILE, production),
    },
    // Who sells, and where transfers go, as pro-formas say it (P-35).
    billing: {
      seller: { name: parsed.FF_SELLER_NAME, taxId: parsed.FF_SELLER_TAX_ID, address: parsed.FF_SELLER_ADDRESS },
      bank: {
        name: parsed.FF_BANK_NAME,
        // In groups of four, as a person reads and types it.
        iban: parsed.FF_BANK_IBAN.replace(/ /g, '').replace(/(.{4})/g, '$1 ').trim(),
        bic: parsed.FF_BANK_BIC ?? null,
      },
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
      logStoreDeleteKeyFile: parsed.K8S_LOG_STORE_DELETE_KEY_FILE,
      // What functions reach of the platform whatever their account's internet access: customers' database server.
      platformEgress: dataDb ? [{ cidrs: dataDb.cidrs, port: dataDb.port }] : [],
      // The CA of that server's certificate when it isn't a public one: functions' pods get it (none: '').
      dataDbCa: dataDb?.ca ?? '',
    },
  };
}

export type AppConfig = ReturnType<typeof configuration>;

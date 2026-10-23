// Imported through the "@/" alias on purpose: this spec also proves the
// Jest moduleNameMapper matches the tsconfig "paths" mapping.
import configuration, { ConfigurationError, Env, RENAMED_VARIABLES, VARIABLES, databaseConfiguration } from '@/config/configuration';
import { DEVELOPMENT_KEY } from '@/encryption/key-ring';
import { parse as parseEnvFile } from 'dotenv';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** The smallest valid development environment: everything else has a default. */
const dev: Env = { FF_AUTH_MODE: 'dev', FF_DEV_ACCOUNT_ID: '000000000001' };

/** A keys file of the platform's, as production needs one: its encryption keys, one a line. */
const keysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-keys-'));
const keysFile = path.join(keysDir, 'keys');
fs.writeFileSync(keysFile, `2026-10:${randomBytes(32).toString('base64')}\n`);
afterAll(() => fs.rmSync(keysDir, { recursive: true, force: true }));

/** The smallest valid production environment. */
const production: Env = {
  NODE_ENV: 'production',
  FF_OIDC_ISSUER: 'https://login.ff.example/realms/ff',
  FF_OIDC_AUDIENCE: 'ff-api',
  DB_PASSWORD: 'a-long-database-secret',
  FF_OBJECT_STORE_ACCESS_KEY: 'prod-access-key',
  FF_OBJECT_STORE_SECRET_KEY: 'prod-secret-key',
  CORS_ORIGIN: 'https://console.ff.example',
  FF_SMTP_URL: 'smtps://ff:mail-secret@mail.ff.example:465',
  FF_OPERATOR_EMAIL: 'ops@ff.example',
  FF_CONSOLE_URL: 'https://console.ff.example',
  FF_SELLER_NAME: 'FF SARL',
  FF_SELLER_TAX_ID: '1234567/A/M/000',
  FF_SELLER_ADDRESS: '1 rue du Lac, 1053 Tunis',
  FF_BANK_NAME: 'Banque de Tunisie',
  FF_BANK_IBAN: 'TN5910006035183598478831',
  K8S_RUNTIME_CLASS: 'gvisor',
  FF_ENCRYPTION_KEYS_FILE: keysFile,
  FF_FUNCTION_URL_BASE: 'https://fn.ff.example',
  FF_STORAGE_BASE: 'https://s3.ff.example',
  FF_SQS_BASE: 'https://sqs.ff.example',
  FF_CODE_REGISTRY: 'http://ff-code-registry.ff-system.svc.cluster.local:5000',
};

/** The problems a configuration is refused for; fails the test if it is accepted. */
function problems(env: Env, load: (env: Env) => unknown = configuration): string[] {
  try {
    load(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError);
    return (error as ConfigurationError).problems;
  }
  throw new Error('the configuration was accepted');
}

describe('configuration', () => {
  it('runs a development backend on defaults, given only the development account', () => {
    const config = configuration(dev);

    expect(config).toMatchObject({
      nodeEnv: 'development',
      port: 3000,
      cors: { origins: ['http://localhost:5199', 'http://localhost:5198'] },
      auth: { mode: 'dev', devAccountId: '000000000001', oidc: undefined },
      database: {
        host: 'localhost',
        port: 5432,
        username: 'postgres',
        password: 'postgres',
        name: 'postgres',
        logging: true,
        ssl: false,
      },
      objectStore: { endPoint: 'localhost', port: 9003, useSSL: false, bucketName: 'functions' },
      orchestrator: { driver: 'kubernetes', readyTimeoutSeconds: 90 },
      kubernetes: {
        apiUrl: '',
        tokenFile: '/var/run/secrets/kubernetes.io/serviceaccount/token',
        caFile: '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
        invokeMode: '',
        namespacePrefix: 'ff-t-',
        runtimeImages: { nodejs: 'ff-runtime-nodejs:24-v3', python: 'ff-runtime-python:3.13-v3' },
        imagePullPolicy: 'IfNotPresent',
        runtimeClass: '',
        readyTimeoutSeconds: 90,
        egressInternet: true,
        ingressAllowCidrs: [],
      },
    });
  });

  it('parses numbers, booleans and lists, trims values, and treats a blank value as unset', () => {
    const config = configuration({
      ...dev,
      PORT: ' 4100 ',
      DB_HOST: 'db.internal',
      DB_PORT: '6543',
      DB_NAME: 'ff',
      FF_OBJECT_STORE_PORT: '9100',
      FF_OBJECT_STORE_USE_SSL: 'true',
      FF_OBJECT_STORE_BUCKET: 'artifacts',
      FF_READY_TIMEOUT_SECONDS: '30',
      CORS_ORIGIN: 'http://localhost:5173, http://localhost:5174/',
      K8S_EGRESS_INTERNET: 'false',
      K8S_INGRESS_ALLOW_CIDRS: '10.42.0.0/16, fd00::/8',
      K8S_INVOKE_MODE: 'direct',
      K8S_RUNTIME_CLASS: '',
      FF_SCALE_TO_ZERO_IDLE_SECONDS: '', // empty: as if unset, so not refused
    });

    expect(config.port).toBe(4100);
    expect(config.database).toMatchObject({ host: 'db.internal', port: 6543, name: 'ff' });
    expect(config.objectStore).toMatchObject({ port: 9100, useSSL: true, bucketName: 'artifacts' });
    expect(config.orchestrator.readyTimeoutSeconds).toBe(30);
    expect(config.cors.origins).toEqual(['http://localhost:5173', 'http://localhost:5174/']);
    expect(config.kubernetes).toMatchObject({
      egressInternet: false,
      ingressAllowCidrs: ['10.42.0.0/16', 'fd00::/8'],
      invokeMode: 'direct',
      runtimeClass: '',
    });
  });

  it('accepts a complete production configuration: oidc, no query logging, the given origins', () => {
    const config = configuration(production);

    expect(config.auth).toEqual({
      mode: 'oidc',
      devAccountId: undefined,
      oidc: { issuer: 'https://login.ff.example/realms/ff', audience: 'ff-api' },
    });
    expect(config.database.logging).toBe(false);
    expect(config.cors.origins).toEqual(['https://console.ff.example']);
  });

  describe('BE/.env.example, which the getting-started guide copies', () => {
    const example = parseEnvFile(fs.readFileSync(path.join(__dirname, '../../.env.example')));

    it('is a valid development configuration as it is', () => {
      expect(configuration(example).auth).toMatchObject({ mode: 'dev', devAccountId: '000000000001' });
    });

    it('documents every variable, and only variables the backend reads', () => {
      expect(Object.keys(example).filter((name) => !VARIABLES.includes(name))).toEqual([]);
      expect(VARIABLES.filter((name) => !(name in example))).toEqual([]);
    });
  });

  describe("functions' code images (ADR 0003)", () => {
    it('has none unless FF_CODE_REGISTRY names a registry: packages then refuse to run', () => {
      expect(configuration(dev).codeImages).toEqual({ registry: '', pullHost: '', username: '', password: '' });
    });

    it("pulls from the registry's own host unless FF_CODE_REGISTRY_PULL names the one the nodes reach", () => {
      expect(configuration({ ...dev, FF_CODE_REGISTRY: 'https://registry.ff.example/' }).codeImages).toMatchObject({
        registry: 'https://registry.ff.example',
        pullHost: 'registry.ff.example',
      });
      expect(configuration({ ...dev, FF_CODE_REGISTRY: 'http://127.0.0.1:5056', FF_CODE_REGISTRY_PULL: 'ff-dev-registry:5000' }).codeImages).toMatchObject({
        registry: 'http://127.0.0.1:5056',
        pullHost: 'ff-dev-registry:5000',
      });
    });

    it('refuses a pull host without a registry, a login without its password, and what is no host', () => {
      expect(problems({ ...dev, FF_CODE_REGISTRY_PULL: 'ff-dev-registry:5000' })).toEqual([
        'FF_CODE_REGISTRY_PULL is set, but FF_CODE_REGISTRY is not: the backend pushes code images to FF_CODE_REGISTRY',
      ]);
      expect(problems({ ...dev, FF_CODE_REGISTRY: 'http://127.0.0.1:5056', FF_CODE_REGISTRY_USERNAME: 'ff' })).toEqual([
        'FF_CODE_REGISTRY_USERNAME and FF_CODE_REGISTRY_PASSWORD go together: set both, or neither for a registry without a login',
      ]);
      expect(problems({ ...dev, FF_CODE_REGISTRY: 'http://127.0.0.1:5056', FF_CODE_REGISTRY_PULL: 'http://ff-dev-registry' })).toEqual([
        expect.stringContaining('FF_CODE_REGISTRY_PULL'),
      ]);
    });

    it('never repeats the password in a refusal', () => {
      expect(problems({ ...dev, FF_CODE_REGISTRY: 'http://127.0.0.1:5056', FF_CODE_REGISTRY_PASSWORD: 'hunter2' }).join(' ')).not.toContain('hunter2');
    });
  });

  describe("customers' database server (ADR 0008)", () => {
    const server: Env = { ...dev, FF_DATA_DB_HOST: '10.199.0.10', FF_DATA_DB_ADMIN_PASSWORD: 'ff-data-admin-dev', FF_DATA_DB_CIDRS: '10.199.0.10/32' };
    let dir: string;

    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-data-db-'));
      fs.writeFileSync(path.join(dir, 'ca.crt'), '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
    });

    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('has none unless FF_DATA_DB_HOST names it: functions then reach nothing more', () => {
      const config = configuration(dev);

      expect(config.dataDb).toBeNull();
      expect(config.kubernetes).toMatchObject({ platformEgress: [], dataDbCa: '' });
    });

    it("reaches it as named, on 5432, as ff_admin; functions at its addresses, on its port; no CA for a public certificate", () => {
      const config = configuration(server);

      expect(config.dataDb).toEqual({
        host: '10.199.0.10',
        port: 5432,
        adminHost: '10.199.0.10',
        adminUser: 'ff_admin',
        adminPassword: 'ff-data-admin-dev',
        cidrs: ['10.199.0.10/32'],
      });
      expect(config.kubernetes).toMatchObject({ platformEgress: [{ cidrs: ['10.199.0.10/32'], port: 5432 }], dataDbCa: '' });
    });

    it('takes another port, another address for the backend, and the CA of its certificate, which functions get too', () => {
      const config = configuration({
        ...server,
        FF_DATA_DB_HOST: 'db.ff.example',
        FF_DATA_DB_PORT: '6432',
        FF_DATA_DB_ADMIN_HOST: '10.0.5.4',
        FF_DATA_DB_CIDRS: '203.0.113.7/32,10.0.5.4/32',
        FF_DATA_DB_CA_FILE: path.join(dir, 'ca.crt'),
      });

      expect(config.dataDb).toMatchObject({ host: 'db.ff.example', port: 6432, adminHost: '10.0.5.4', ca: expect.stringContaining('BEGIN CERTIFICATE') });
      expect(config.kubernetes.platformEgress).toEqual([{ cidrs: ['203.0.113.7/32', '10.0.5.4/32'], port: 6432 }]);
      expect(config.kubernetes.dataDbCa).toContain('BEGIN CERTIFICATE');
    });

    it("needs the backend role's password and the addresses functions reach it at", () => {
      expect(problems({ ...dev, FF_DATA_DB_HOST: '10.199.0.10' })).toEqual([
        "FF_DATA_DB_ADMIN_PASSWORD is required when FF_DATA_DB_HOST is set: it is the backend's role's on customers' database server",
        "FF_DATA_DB_CIDRS is required when FF_DATA_DB_HOST is set: functions reach customers' database server only at these addresses, through their NetworkPolicy",
      ]);
    });

    it('refuses its other settings without it, a CA it cannot read, and what is no host or role', () => {
      expect(problems({ ...dev, FF_DATA_DB_ADMIN_PASSWORD: 'x', FF_DATA_DB_CIDRS: '10.199.0.10/32' })).toEqual([
        "FF_DATA_DB_ADMIN_PASSWORD is set, but FF_DATA_DB_HOST is not: it names customers' database server",
        "FF_DATA_DB_CIDRS is set, but FF_DATA_DB_HOST is not: it names customers' database server",
      ]);
      expect(problems({ ...server, FF_DATA_DB_CA_FILE: '/nonexistent/ca.crt' })).toEqual([expect.stringContaining('FF_DATA_DB_CA_FILE cannot be read: /nonexistent/ca.crt')]);
      expect(problems({ ...server, FF_DATA_DB_HOST: 'db.ff.example:5432' })).toEqual([expect.stringContaining('FF_DATA_DB_HOST must be a host name or an IP address')]);
      expect(problems({ ...server, FF_DATA_DB_ADMIN_USER: 'FF-Admin' })).toEqual([expect.stringContaining('FF_DATA_DB_ADMIN_USER must be a PostgreSQL role name')]);
    });

    it('refuses the development password in production, and never repeats a password', () => {
      const found = problems({ ...production, ...server, NODE_ENV: 'production', FF_AUTH_MODE: 'oidc', FF_DEV_ACCOUNT_ID: undefined });

      expect(found).toEqual(['FF_DATA_DB_ADMIN_PASSWORD must not be the development default when NODE_ENV=production']);
      expect(problems({ ...dev, FF_DATA_DB_ADMIN_PASSWORD: 'hunter2' }).join(' ')).not.toContain('hunter2');
    });
  });

  it('has no schema synchronization switch: the schema comes only from migrations', () => {
    expect(configuration(dev).database).not.toHaveProperty('synchronize');
  });

  it('evaluates alarms every minute, each period once it has been over a minute, unless told otherwise', () => {
    expect(configuration(production).alarms).toEqual({ intervalSeconds: 60, settleSeconds: 60 });
    expect(configuration({ ...production, FF_ALARM_INTERVAL_SECONDS: '5', FF_ALARM_SETTLE_SECONDS: '0' }).alarms).toEqual({ intervalSeconds: 5, settleSeconds: 0 });
    expect(problems({ ...production, FF_ALARM_INTERVAL_SECONDS: '0' })).toEqual([expect.stringContaining('FF_ALARM_INTERVAL_SECONDS')]);
  });

  it("sends notifications every 10 s, never to a private address, unless told otherwise", () => {
    expect(configuration(production).notifications).toEqual({ intervalSeconds: 10, allowPrivate: false });
    expect(configuration({ ...production, NODE_ENV: 'development', FF_NOTIFY_INTERVAL_SECONDS: '1', FF_WEBHOOK_ALLOW_PRIVATE: 'true' }).notifications).toEqual({ intervalSeconds: 1, allowPrivate: true });
    expect(problems({ ...production, FF_NOTIFY_INTERVAL_SECONDS: '0' })).toEqual([expect.stringContaining('FF_NOTIFY_INTERVAL_SECONDS')]);
  });

  it("serves the operator's metrics on port 9464 of this machine only, unless told otherwise, and logs as told", () => {
    expect(configuration(production).monitoring).toEqual({ metricsPort: 9464, metricsHost: '127.0.0.1', databaseDiskBytes: 0 });
    expect(configuration({ ...production, FF_DATABASE_DISK_BYTES: '107374182400' }).monitoring.databaseDiskBytes).toBe(100 * 1024 ** 3);
    expect(problems({ ...production, FF_DATABASE_DISK_BYTES: '-1' })).toEqual([expect.stringContaining('FF_DATABASE_DISK_BYTES')]);
    expect(configuration({ ...production, FF_METRICS_PORT: '0' }).monitoring.metricsPort).toBe(0);
    expect(configuration({ ...production, FF_METRICS_PORT: '9100', FF_METRICS_HOST: '0.0.0.0' }).monitoring).toMatchObject({ metricsPort: 9100, metricsHost: '0.0.0.0' });
    expect(problems({ ...production, FF_METRICS_PORT: '70000' })).toEqual([expect.stringContaining('FF_METRICS_PORT')]);
    expect(() => configuration({ ...production, FF_LOG_FORMAT: 'text' })).not.toThrow();
    expect(problems({ ...production, FF_LOG_FORMAT: 'xml' })).toEqual([expect.stringContaining('FF_LOG_FORMAT')]);
    expect([configuration(production).logFormat, configuration({ ...production, NODE_ENV: 'development' }).logFormat, configuration({ ...production, FF_LOG_FORMAT: 'text' }).logFormat]).toEqual([
      'json',
      'text',
      'text',
    ]);
  });

  it("reads the realm's keys from its OpenID configuration, or where FF_OIDC_JWKS_URL says", () => {
    expect(configuration(production).auth.oidc).not.toHaveProperty('jwksUrl');
    const inCluster = 'http://keycloak.ff-system.svc:8080/realms/ff/protocol/openid-connect/certs';
    expect(configuration({ ...production, FF_OIDC_JWKS_URL: inCluster }).auth.oidc).toMatchObject({ issuer: production.FF_OIDC_ISSUER, jwksUrl: inCluster });
    expect(problems({ ...production, FF_OIDC_JWKS_URL: 'keycloak/certs' })).toEqual([expect.stringContaining('FF_OIDC_JWKS_URL')]);
  });

  it("serves the API's documents in development and not in production, unless told otherwise", () => {
    expect([configuration(dev).http.apiDocs, configuration(production).http.apiDocs]).toEqual([true, false]);
    expect([configuration({ ...dev, FF_API_DOCS: 'false' }).http.apiDocs, configuration({ ...production, FF_API_DOCS: 'true' }).http.apiDocs]).toEqual([false, true]);
    expect(problems({ ...production, FF_API_DOCS: 'yes' })).toEqual([expect.stringContaining('FF_API_DOCS')]);
  });

  it('trusts no proxy unless told, and only addresses, CIDRs and named ranges', () => {
    expect(configuration(production).http.trustProxy).toEqual([]);
    expect(configuration({ ...production, FF_TRUST_PROXY: '10.42.0.0/16, 127.0.0.1, loopback, fd00::/8' }).http.trustProxy).toEqual([
      '10.42.0.0/16',
      '127.0.0.1',
      'loopback',
      'fd00::/8',
    ]);
    // A count of hops would let a client name its own address by sending the header itself.
    for (const value of ['2', 'true', '10.42.0.0/33', '10.42.0.0/16/1', 'proxy.ff.example']) {
      expect(problems({ ...production, FF_TRUST_PROXY: value })).toEqual([expect.stringContaining('FF_TRUST_PROXY')]);
    }
  });

  describe('production refuses development settings', () => {
    it.each<[string, Env, string]>([
      ['the dev authentication mode', { FF_AUTH_MODE: 'dev', FF_DEV_ACCOUNT_ID: '000000000001' }, 'FF_AUTH_MODE=dev is for development only'],
      ['the default database password', { DB_PASSWORD: undefined }, 'DB_PASSWORD must be set, and not to the development default'],
      ['the default database password, set explicitly', { DB_PASSWORD: 'postgres' }, 'DB_PASSWORD must be set'],
      ['the default storage access key', { FF_OBJECT_STORE_ACCESS_KEY: undefined }, 'FF_OBJECT_STORE_ACCESS_KEY must be set, and not to a development default'],
      ['the dev storage access key', { FF_OBJECT_STORE_ACCESS_KEY: 'ffdevaccesskey' }, 'FF_OBJECT_STORE_ACCESS_KEY must be set'],
      ['the default storage secret key', { FF_OBJECT_STORE_SECRET_KEY: 'minioadmin' }, 'FF_OBJECT_STORE_SECRET_KEY must be set'],
      ['the dev storage secret key', { FF_OBJECT_STORE_SECRET_KEY: 'ffdevsecretkey-local-only' }, 'FF_OBJECT_STORE_SECRET_KEY must be set'],
      ['a missing Keycloak issuer', { FF_OIDC_ISSUER: undefined }, 'FF_OIDC_ISSUER is required when FF_AUTH_MODE is oidc'],
      ['a missing Keycloak audience', { FF_OIDC_AUDIENCE: '' }, 'FF_OIDC_AUDIENCE is required when FF_AUTH_MODE is oidc'],
      ['an issuer without TLS', { FF_OIDC_ISSUER: 'http://login.ff.example/realms/ff' }, 'FF_OIDC_ISSUER must be an https:// URL'],
      ['a missing console origin for CORS', { CORS_ORIGIN: undefined }, "CORS_ORIGIN must be set to the console's and the admin dashboard's origins"],
      ['no SMTP server, so no e-mail would leave (P-12)', { FF_SMTP_URL: undefined }, 'FF_SMTP_URL is required when NODE_ENV=production'],
      ['nobody to approve new accounts (P-12)', { FF_OPERATOR_EMAIL: '' }, 'FF_OPERATOR_EMAIL is required when NODE_ENV=production'],
      ['invitations linking to a development console (P-16)', { FF_CONSOLE_URL: undefined }, 'FF_CONSOLE_URL must be set when NODE_ENV=production'],
      ['pro-formas naming no real seller (P-35)', { FF_SELLER_NAME: undefined }, 'FF_SELLER_NAME must be set when NODE_ENV=production'],
      ['pro-formas with the example IBAN (P-35)', { FF_BANK_IBAN: 'TN59 1000 6035 1835 9847 8831' }, 'FF_BANK_IBAN must be set when NODE_ENV=production'],
      ["webhooks allowed into FF's own network", { FF_WEBHOOK_ALLOW_PRIVATE: 'true' }, "FF_WEBHOOK_ALLOW_PRIVATE is for development only: in production a customer's webhook must never reach FF's own network"],
      ["customers' code on the node's own kernel, without a sandbox", { K8S_RUNTIME_CLASS: '' }, 'K8S_RUNTIME_CLASS must name the sandbox functions run in (gvisor) when NODE_ENV=production'],
      ["functions' environments sealed with the development key", { FF_ENCRYPTION_KEYS_FILE: undefined }, 'FF_ENCRYPTION_KEYS_FILE is required when NODE_ENV=production'],
      ['function URLs without TLS, the development default', { FF_FUNCTION_URL_BASE: undefined }, 'FF_FUNCTION_URL_BASE must be an https:// origin when NODE_ENV=production'],
      ["no registry, which every function's code reaches its pods through", { FF_CODE_REGISTRY: undefined }, 'FF_CODE_REGISTRY is required when NODE_ENV=production'],
    ])('%s', (_label, change, expected) => {
      const found = problems({ ...production, ...change });

      expect(found).toEqual([expect.stringContaining(expected)]);
    });

    it('runs functions without a sandbox only when told to, for a cluster that tries the manifests; development needs none', () => {
      expect(configuration({ ...production, K8S_RUNTIME_CLASS: undefined, K8S_ALLOW_UNSANDBOXED: 'true' }).kubernetes.runtimeClass).toBe('');
      expect(configuration({ ...production, NODE_ENV: 'development', K8S_RUNTIME_CLASS: undefined }).kubernetes.runtimeClass).toBe('');
      expect(configuration(production).kubernetes.runtimeClass).toBe('gvisor');
      expect(problems({ ...production, K8S_ALLOW_UNSANDBOXED: 'yes' })).toEqual([expect.stringContaining('K8S_ALLOW_UNSANDBOXED')]);
    });

    it('never repeats a refused credential in the message', () => {
      const message = (() => {
        try {
          configuration({ ...production, FF_OBJECT_STORE_SECRET_KEY: 'ffdevsecretkey-local-only', DB_PASSWORD: 'postgres' });
        } catch (error) {
          return (error as Error).message;
        }
        return '';
      })();

      expect(message).toContain('FF_OBJECT_STORE_SECRET_KEY');
      expect(message).not.toContain('ffdevsecretkey-local-only');
      expect(message).not.toMatch(/"postgres"|: postgres/);
    });
  });

  describe('function URLs', () => {
    it('are served on port 3001, apart from the API, under fn.localhost in development', () => {
      expect(configuration(dev).functionUrls).toEqual({ port: 3001, base: 'http://fn.localhost:3001', edgeAddresses: [], domainResolvers: [] });
    });

    it('take an origin with a dot in its host, a trailing slash dropped, and port 0 for none', () => {
      expect(configuration({ ...production, FF_FUNCTION_URL_BASE: 'https://fn.example.tn/', FF_FUNCTION_URL_PORT: '0' }).functionUrls).toMatchObject({
        port: 0,
        base: 'https://fn.example.tn',
      });
    });

    it("take the edge's addresses, which customers' domain apexes point to, and the DNS servers that check them", () => {
      const settings = { ...dev, FF_EDGE_ADDRESSES: '203.0.113.10, 2001:db8::10', FF_DOMAIN_RESOLVERS: '10.43.0.10,127.0.0.1:5353,[::1]:53,2001:db8::53' };

      expect(configuration(settings).functionUrls).toMatchObject({
        edgeAddresses: ['203.0.113.10', '2001:db8::10'],
        domainResolvers: ['10.43.0.10', '127.0.0.1:5353', '[::1]:53', '2001:db8::53'],
      });
    });

    it.each([
      ['FF_EDGE_ADDRESSES', 'edge.example.tn'],
      ['FF_DOMAIN_RESOLVERS', 'dns.example.tn'],
      ['FF_DOMAIN_RESOLVERS', '127.0.0.1:99999'],
    ])('refuse %s=%s, which is no address', (name, value) => {
      expect(problems({ ...dev, [name]: value })).toEqual([expect.stringContaining(`${name} must be a comma-separated list of`)]);
    });

    it.each(['https://fn.example.tn/path', 'ftp://fn.example.tn', 'https://localhost', 'fn.example.tn'])('refuse %s as where they live', (base) => {
      expect(problems({ ...dev, FF_FUNCTION_URL_BASE: base })).toEqual([expect.stringMatching(/^FF_FUNCTION_URL_BASE must be an origin whose host has a dot/)]);
    });
  });

  describe("buckets' S3 front door", () => {
    it('is served on port 3002, apart from the API, at s3.localhost in development, naming FF\'s region', () => {
      expect(configuration(dev).storage).toEqual({ port: 3002, base: 'http://s3.localhost:3002', region: 'tn-tunis-1', functionEndpoint: '' });
    });

    it("gives functions no key of their own unless it has an address for them, and they reach nothing more", () => {
      expect(configuration(dev).storage.functionEndpoint).toBe('');
      expect(configuration(dev).kubernetes.platformEgress).toEqual([]);
    });

    it("is reached by functions at an IP address: of a backend outside the cluster at its addresses, on the endpoint's port", () => {
      const config = configuration({ ...dev, FF_STORAGE_FUNCTION_ENDPOINT: 'http://172.18.0.1:3002/', FF_STORAGE_FUNCTION_CIDRS: '172.18.0.1/32' });

      expect(config.storage.functionEndpoint).toBe('http://172.18.0.1:3002');
      expect(config.kubernetes.platformEgress).toEqual([{ cidrs: ['172.18.0.1/32'], port: 3002 }]);
      expect(configuration({ ...dev, FF_STORAGE_FUNCTION_ENDPOINT: 'https://[fd00::5]', FF_STORAGE_FUNCTION_CIDRS: 'fd00::5/128' }).kubernetes.platformEgress).toEqual([
        { cidrs: ['fd00::5/128'], port: 443 },
      ]);
    });

    it("is reached by functions at a Service's fixed address: of the backend's own pods, on the front door's port, beside the database server", () => {
      const config = configuration({
        ...dev,
        FF_STORAGE_PORT: '3102',
        FF_STORAGE_FUNCTION_ENDPOINT: 'http://10.43.0.251:3002',
        FF_DATA_DB_HOST: '10.199.0.10',
        FF_DATA_DB_ADMIN_PASSWORD: 'ff-data-admin-dev',
        FF_DATA_DB_CIDRS: '10.199.0.10/32',
      });

      expect(config.kubernetes.platformEgress).toEqual([
        { cidrs: ['10.199.0.10/32'], port: 5432 },
        { cidrs: [], port: 3102 },
      ]);
    });

    it.each(['http://s3.ff.internal:3002', 'http://10.43.0.251:3002/s3', 'ftp://10.43.0.251'])("refuses %s as functions' endpoint: an origin at an IP address", (endpoint) => {
      expect(problems({ ...dev, FF_STORAGE_FUNCTION_ENDPOINT: endpoint })).toEqual([expect.stringMatching(/^FF_STORAGE_FUNCTION_ENDPOINT must be an origin whose host is an IP address/)]);
    });

    it("refuses functions' endpoint without the front door, and their addresses without the endpoint", () => {
      expect(problems({ ...dev, FF_STORAGE_PORT: '0', FF_STORAGE_FUNCTION_ENDPOINT: 'http://10.43.0.251:3002' })).toEqual([
        "FF_STORAGE_FUNCTION_ENDPOINT is set, but FF_STORAGE_PORT is 0: functions' keys reach buckets through the S3 front door, which isn't running",
      ]);
      expect(problems({ ...dev, FF_STORAGE_FUNCTION_CIDRS: '172.18.0.1/32' })).toEqual([
        "FF_STORAGE_FUNCTION_CIDRS is set, but FF_STORAGE_FUNCTION_ENDPOINT is not: it names where functions reach buckets' S3 front door",
      ]);
    });

    it('takes an origin with a dot in its host, a trailing slash dropped, and port 0 for none', () => {
      expect(configuration({ ...production, FF_STORAGE_BASE: 'https://s3.example.tn/', FF_STORAGE_PORT: '0' }).storage).toMatchObject({ port: 0, base: 'https://s3.example.tn' });
    });

    it.each(['https://s3.example.tn/path', 'ftp://s3.example.tn', 'https://localhost', 's3.example.tn'])('refuses %s as its endpoint', (base) => {
      expect(problems({ ...dev, FF_STORAGE_BASE: base })).toEqual([expect.stringMatching(/^FF_STORAGE_BASE must be an origin whose host has a dot/)]);
    });

    it('is reached over TLS in production', () => {
      expect(problems({ ...production, FF_STORAGE_BASE: 'http://s3.example.tn' })).toEqual([expect.stringMatching(/^FF_STORAGE_BASE must be an https:\/\/ origin when NODE_ENV=production/)]);
    });
  });

  describe("queues' SQS endpoint", () => {
    it("is served on port 3003, apart from the API, at localhost in development, naming FF's region", () => {
      expect(configuration(dev).sqs).toEqual({ port: 3003, base: 'http://localhost:3003', region: 'tn-tunis-1' });
    });

    it('takes an origin, a trailing slash dropped, and port 0 for none', () => {
      expect(configuration({ ...production, FF_SQS_BASE: 'https://sqs.example.tn/', FF_SQS_PORT: '0' }).sqs).toMatchObject({ port: 0, base: 'https://sqs.example.tn' });
    });

    it.each(['https://sqs.example.tn/queues', 'ftp://sqs.example.tn', 'sqs.example.tn'])('refuses %s as its endpoint', (base) => {
      expect(problems({ ...dev, FF_SQS_BASE: base })).toEqual([expect.stringMatching(/^FF_SQS_BASE must be an origin, such as https:\/\/sqs.example.tn/)]);
    });

    it('is reached over TLS in production', () => {
      expect(problems({ ...production, FF_SQS_BASE: 'http://sqs.example.tn' })).toEqual([expect.stringMatching(/^FF_SQS_BASE must be an https:\/\/ origin when NODE_ENV=production/)]);
    });
  });

  describe('schedules', () => {
    it('are taken every 5 s, and name the region tn-tunis-1, by default', () => {
      expect(configuration(dev).schedules).toEqual({ intervalSeconds: 5, region: 'tn-tunis-1' });
    });

    it('take another region, and 0 for a backend that runs none', () => {
      expect(configuration({ ...dev, FF_REGION: 'eu-west-3', FF_SCHEDULER_INTERVAL_SECONDS: '0' }).schedules).toEqual({ intervalSeconds: 0, region: 'eu-west-3' });
    });

    it.each(['Tunis', 'tn_tunis_1', 'tn-tunis'])('refuse %s as a region', (region) => {
      expect(problems({ ...dev, FF_REGION: region })).toEqual([expect.stringMatching(/^FF_REGION must be a region name, such as tn-tunis-1/)]);
    });
  });

  describe('asynchronous calls', () => {
    it('are claimed every second, ten at once on each backend, by default', () => {
      expect(configuration(dev).asyncInvoke).toEqual({ intervalSeconds: 1, concurrency: 10 });
    });

    it('take 0 for a backend that runs none, and more at once', () => {
      expect(configuration({ ...dev, FF_ASYNC_INTERVAL_SECONDS: '0', FF_ASYNC_CONCURRENCY: '50' }).asyncInvoke).toEqual({ intervalSeconds: 0, concurrency: 50 });
    });

    it('refuse none at once, which would never run one', () => {
      expect(problems({ ...dev, FF_ASYNC_CONCURRENCY: '0' })).toEqual([expect.stringMatching(/^FF_ASYNC_CONCURRENCY/)]);
    });
  });

  describe('the runtime images', () => {
    it('run protocol 3 by default, which hands a function the payload as its event', () => {
      expect(configuration(dev).kubernetes.runtimeImages).toEqual({ nodejs: 'ff-runtime-nodejs:24-v3', python: 'ff-runtime-python:3.13-v3' });
    });

    it('refuses an image of protocol 1 or 2, which would hand functions the old wrapper, in every environment', () => {
      expect(problems({ ...dev, K8S_RUNTIME_IMAGE_NODEJS: 'ff-runtime-nodejs:24-v2', K8S_RUNTIME_IMAGE_PYTHON: 'registry.local:5000/ff/ff-runtime-python:3.13-v1' })).toEqual([
        "K8S_RUNTIME_IMAGE_NODEJS names a runtime of protocol 2 (ff-runtime-nodejs:24-v2), which gives functions FF's original event: they now get AWS Lambda's, which takes protocol 3 (-v3)",
        "K8S_RUNTIME_IMAGE_PYTHON names a runtime of protocol 1 (registry.local:5000/ff/ff-runtime-python:3.13-v1), which gives functions FF's original event: they now get AWS Lambda's, which takes protocol 3 (-v3)",
      ]);
      expect(problems({ ...production, K8S_RUNTIME_IMAGE_NODEJS: 'ff-runtime-nodejs:24-v2' })).toHaveLength(1);
    });

    it('takes any other image: a registry with a port, a digest, a later protocol', () => {
      for (const image of ['registry.local:5000/ff-runtime-nodejs:24-v3', 'ff-runtime-nodejs@sha256:' + 'a'.repeat(64), 'ff-runtime-nodejs:24-v4']) {
        expect(configuration({ ...dev, K8S_RUNTIME_IMAGE_NODEJS: image }).kubernetes.runtimeImages.nodejs).toBe(image);
      }
    });
  });

  describe("the keys that encrypt functions' environments at rest", () => {
    const write = (name: string, text: string) => {
      const file = path.join(keysDir, name);
      fs.writeFileSync(file, text);
      return file;
    };

    it('uses the development key when no keys file is set, outside production', () => {
      expect(configuration(dev).encryption.keys).toEqual([DEVELOPMENT_KEY]);
    });

    it('reads every key of the file, the first sealing', () => {
      const [newer, older] = [randomBytes(32), randomBytes(32)];
      const file = write('two', `# newest first\n2026-10:${newer.toString('base64')}\n2026-01:${older.toString('base64')}\n`);

      const keys = configuration({ ...production, FF_ENCRYPTION_KEYS_FILE: file }).encryption.keys;

      expect(keys.map((key) => key.id)).toEqual(['2026-10', '2026-01']);
      expect(keys[0].key.equals(newer)).toBe(true);
    });

    it('refuses a file it cannot read, naming it', () => {
      expect(problems({ ...dev, FF_ENCRYPTION_KEYS_FILE: '/nonexistent/keys' })).toEqual([
        'FF_ENCRYPTION_KEYS_FILE cannot be read: /nonexistent/keys (ENOENT)',
      ]);
    });

    it('refuses a malformed file, naming each line, never repeating a key', () => {
      const short = randomBytes(16).toString('base64');
      const file = write('bad', `a:${short}\nno separator\n`);

      expect(problems({ ...dev, FF_ENCRYPTION_KEYS_FILE: file })).toEqual([
        `FF_ENCRYPTION_KEYS_FILE ${file}: line 1: the key "a" must be 32 bytes in base64, such as \`openssl rand -base64 32\` writes`,
        `FF_ENCRYPTION_KEYS_FILE ${file}: line 2 must be <id>:<key>, the key 32 bytes in base64`,
      ]);
      expect(problems({ ...dev, FF_ENCRYPTION_KEYS_FILE: file }).join(' ')).not.toContain(short);
    });

    it('refuses the development key in production, wherever it is in the file; development may use it', () => {
      const file = write('with-dev', `2026-10:${randomBytes(32).toString('base64')}\nold:${DEVELOPMENT_KEY.key.toString('base64')}\n`);

      expect(problems({ ...production, FF_ENCRYPTION_KEYS_FILE: file })).toEqual([
        `FF_ENCRYPTION_KEYS_FILE ${file} holds the development key, which protects nothing: refused when NODE_ENV=production`,
      ]);
      expect(configuration({ ...dev, FF_ENCRYPTION_KEYS_FILE: file }).encryption.keys).toHaveLength(2);
    });
  });

  describe('the seller and the bank, for pro-formas (P-35)', () => {
    it('names a development seller and the example IBAN by default, the IBAN in groups of four', () => {
      expect(configuration(dev).billing).toEqual({
        seller: { name: 'FF (development, not a seller)', taxId: '0000000/A/A/M/000', address: 'Tunis, Tunisia' },
        bank: { name: 'Development bank: no transfer arrives', iban: 'TN59 1000 6035 1835 9847 8831', bic: null },
      });
      expect(configuration(production).billing.bank).toEqual({ name: 'Banque de Tunisie', iban: 'TN59 1000 6035 1835 9847 8831', bic: null });
    });

    it('takes an IBAN only with its check digits right', () => {
      expect(problems({ ...dev, FF_BANK_IBAN: 'TN59 1000 6035 1835 9847 8832' })).toEqual([
        'FF_BANK_IBAN must be an IBAN, such as TN59 1000 6035 1835 9847 8831, its check digits right; got "TN59 1000 6035 1835 9847 8832"',
      ]);
      expect(problems({ ...dev, FF_BANK_IBAN: '12345' })).toEqual([expect.stringContaining('FF_BANK_IBAN must be an IBAN')]);
      expect(configuration({ ...dev, FF_BANK_IBAN: 'FR7630006000011234567890189', FF_BANK_BIC: 'AGRIFRPP' }).billing.bank).toEqual({
        name: 'Development bank: no transfer arrives',
        iban: 'FR76 3000 6000 0112 3456 7890 189',
        bic: 'AGRIFRPP',
      });
    });
  });

  describe('e-mail (P-12)', () => {
    it('logs e-mails instead of sending them when no SMTP server is set, and tells nobody by default', () => {
      expect(configuration(dev).mail).toEqual({
        smtpUrl: '',
        from: 'FF <no-reply@ff.localhost>',
        operatorEmail: '',
        adminUrl: 'http://localhost:5198',
        consoleUrl: 'http://localhost:5199',
      });
      expect(configuration({ ...dev, FF_ADMIN_URL: 'https://admin.ff.example/', FF_SMTP_URL: 'smtp://localhost:51025' }).mail).toMatchObject({
        smtpUrl: 'smtp://localhost:51025',
        adminUrl: 'https://admin.ff.example',
      });
    });

    it('refuses an SMTP URL it can not use without repeating it: it may hold a password', () => {
      const found = problems({ ...dev, FF_SMTP_URL: 'https://ff:mail-secret@mail.ff.example' });

      expect(found).toEqual([expect.stringContaining('FF_SMTP_URL must be an smtp:// or smtps:// URL')]);
      expect(found.join(' ')).not.toContain('mail-secret');
    });

    it.each([
      ['FF_OPERATOR_EMAIL', 'ops at ff.example', 'must be an e-mail address'],
      ['FF_MAIL_FROM', 'FF <no-reply>', 'must be an e-mail address, or "Name <address>"'],
    ])('refuses %s=%j', (name, value, expected) => {
      expect(problems({ ...dev, [name]: value })).toEqual([expect.stringContaining(`${name} ${expected}`)]);
    });
  });

  describe('authentication, in every environment', () => {
    it('defaults to oidc, so a bare environment must name its issuer and audience', () => {
      expect(problems({})).toEqual([
        expect.stringContaining('FF_OIDC_ISSUER is required when FF_AUTH_MODE is oidc, the default (for development without Keycloak, set FF_AUTH_MODE=dev)'),
        expect.stringContaining('FF_OIDC_AUDIENCE is required'),
      ]);
    });

    it('needs a 12-digit development account in dev mode', () => {
      expect(problems({ FF_AUTH_MODE: 'dev' })).toEqual(['FF_DEV_ACCOUNT_ID is required when FF_AUTH_MODE=dev']);
      expect(problems({ FF_AUTH_MODE: 'dev', FF_DEV_ACCOUNT_ID: '1' })).toEqual([
        'FF_DEV_ACCOUNT_ID must be an account ID: 12 digits; got "1"',
      ]);
    });

    it('explains that FF_DEV_USER_ID was replaced', () => {
      expect(problems({ ...dev, FF_DEV_USER_ID: '1' })).toEqual([
        expect.stringContaining('FF_DEV_USER_ID is no longer read: set FF_AUTH_MODE=dev and FF_DEV_ACCOUNT_ID'),
      ]);
    });

    it.each([
      ['FF_SCALE_TO_ZERO_IDLE_SECONDS', '900', "FF_SCALE_TO_ZERO_IDLE_SECONDS is no longer read: each account's plan sets its idle window (plans.limits.idleSeconds); remove it"],
      ['K8S_TENANT_QUOTA_PODS', '20', "K8S_TENANT_QUOTA_PODS is no longer read: each account's plan sets its quota (plans.limits.quota); remove it"],
      ['K8S_TENANT_QUOTA_CPU', '8', "K8S_TENANT_QUOTA_CPU is no longer read: each account's plan sets its quota (plans.limits.quota); remove it"],
      ['K8S_TENANT_QUOTA_MEMORY', '8Gi', "K8S_TENANT_QUOTA_MEMORY is no longer read: each account's plan sets its quota (plans.limits.quota); remove it"],
    ])("explains that each account's plan replaced %s (P-15), rather than ignoring it", (name, value, expected) => {
      expect(problems({ ...dev, [name]: value })).toEqual([expected]);
    });

    it.each(Object.entries(RENAMED_VARIABLES))("refuses %s, the object store's old name from when it was MinIO, naming %s", (name, now) => {
      expect(problems({ ...dev, [name]: 'localhost' })).toEqual([`${name} is no longer read: it is ${now} now, as in BE/.env.example; rename it`]);
    });

    it('accepts oidc outside production with a plain http issuer (a local Keycloak)', () => {
      const config = configuration({ FF_OIDC_ISSUER: 'http://localhost:8180/realms/ff', FF_OIDC_AUDIENCE: 'ff-api' });

      expect(config.auth.oidc).toEqual({ issuer: 'http://localhost:8180/realms/ff', audience: 'ff-api' });
    });
  });

  describe('a bad value is refused, naming the variable and what it expects', () => {
    it.each<[string, string, string]>([
      ['DB_PORT', 'abc', 'DB_PORT must be a whole number from 1 to 65535; got "abc"'],
      ['PORT', '0', 'PORT must be a whole number from 1 to 65535; got "0"'],
      ['FF_READY_TIMEOUT_SECONDS', '-5', 'FF_READY_TIMEOUT_SECONDS must be a whole number from 1 to 3600; got "-5"'],
      ['FF_OBJECT_STORE_USE_SSL', 'yes', 'FF_OBJECT_STORE_USE_SSL must be true or false; got "yes"'],
      ['NODE_ENV', 'staging', 'NODE_ENV must be one of development, production, test; got "staging"'],
      ['ORCHESTRATOR', 'nomad', 'ORCHESTRATOR must be one of kubernetes; got "nomad"'],
      ['K8S_IMAGE_PULL_POLICY', 'Sometimes', 'K8S_IMAGE_PULL_POLICY must be one of IfNotPresent, Always, Never; got "Sometimes"'],
      ['K8S_INVOKE_MODE', 'tunnel', 'K8S_INVOKE_MODE must be one of direct, proxy; got "tunnel"'],
      ['K8S_RUNTIME_CLASS', 'G_Visor', 'K8S_RUNTIME_CLASS must be a Kubernetes object name'],
      ['K8S_NAMESPACE_PREFIX', 'FF_', 'K8S_NAMESPACE_PREFIX must be ff-t-, the only prefix the admission policy allows'],
      // A valid name, but the admission policy would refuse every namespace the backend creates.
      ['K8S_NAMESPACE_PREFIX', 'ff-u-', 'K8S_NAMESPACE_PREFIX must be ff-t-, the only prefix the admission policy allows'],
      ['K8S_API_URL', '127.0.0.1:6550', 'K8S_API_URL must be an http:// or https:// URL; got "127.0.0.1:6550"'],
      ['FF_OIDC_ISSUER', 'login.ff.example', 'FF_OIDC_ISSUER must be an http:// or https:// URL'],
      ['FF_OBJECT_STORE_BUCKET', 'Functions_Bucket', 'FF_OBJECT_STORE_BUCKET must be an S3 bucket name'],
      ['CORS_ORIGIN', 'https://console.ff.example/app', 'CORS_ORIGIN must be a comma-separated list of origins'],
      ['K8S_INGRESS_ALLOW_CIDRS', '10.0.0.0/8,10.0.0.0/33', 'K8S_INGRESS_ALLOW_CIDRS must be a comma-separated list of CIDR blocks such as 10.42.0.0/16; got "10.0.0.0/33"'],
    ])('%s=%s', (name, value, expected) => {
      expect(problems({ ...dev, [name]: value })).toEqual([expect.stringContaining(expected)]);
    });

    it('lists every bad variable at once', () => {
      const found = problems({ ...dev, DB_PORT: 'x', FF_OBJECT_STORE_USE_SSL: 'maybe', K8S_IMAGE_PULL_POLICY: 'Sometimes' });

      expect(found.map((problem) => problem.split(' ')[0])).toEqual(['DB_PORT', 'FF_OBJECT_STORE_USE_SSL', 'K8S_IMAGE_PULL_POLICY']);
    });

    it('says how many problems there are, one per line', () => {
      expect(() => configuration({ ...dev, DB_PORT: 'x', PORT: 'y' })).toThrow(
        /^Invalid configuration \(2 problems\):\n {2}- DB_PORT .*\n {2}- PORT /,
      );
    });
  });

  describe('database TLS', () => {
    let dir: string;

    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-config-'));
      fs.writeFileSync(path.join(dir, 'ca.pem'), '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
      fs.writeFileSync(path.join(dir, 'not-a-cert.txt'), 'hello');
    });

    afterAll(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('is off by default, and verifies against the system CAs when DB_SSL is on', () => {
      expect(configuration(dev).database.ssl).toBe(false);
      expect(configuration({ ...dev, DB_SSL: 'true' }).database.ssl).toEqual({ ca: undefined });
    });

    it('loads the CA certificate named by DB_SSL_CA', () => {
      const ssl = configuration({ ...dev, DB_SSL: 'true', DB_SSL_CA: path.join(dir, 'ca.pem') }).database.ssl;

      expect(ssl).toEqual({ ca: expect.stringContaining('-----BEGIN CERTIFICATE-----') });
    });

    it.each<[string, Env, string]>([
      ['a CA without TLS', { DB_SSL_CA: '/etc/ssl/db-ca.pem' }, 'DB_SSL_CA is set, but DB_SSL is not true'],
      ['a CA file that does not exist', { DB_SSL: 'true', DB_SSL_CA: '/nonexistent/ca.pem' }, 'DB_SSL_CA cannot be read: /nonexistent/ca.pem (ENOENT)'],
      ['a CA file that holds no certificate', { DB_SSL: 'true', DB_SSL_CA: 'not-a-cert.txt' }, 'DB_SSL_CA must be a PEM file with at least one certificate'],
    ])('refuses %s', (_label, change, expected) => {
      const env = { ...dev, ...change };
      if (env.DB_SSL_CA === 'not-a-cert.txt') env.DB_SSL_CA = path.join(dir, 'not-a-cert.txt');

      expect(problems(env)).toEqual([expect.stringContaining(expected)]);
    });
  });
});

describe('databaseConfiguration (the TypeORM CLI and the drift check)', () => {
  it('reads only DB_* and NODE_ENV: a migration job needs no other setting', () => {
    const settings = databaseConfiguration({
      NODE_ENV: 'production',
      DB_HOST: 'db.internal',
      DB_PASSWORD: 'a-long-database-secret',
      // Invalid or missing for the backend, irrelevant here:
      K8S_TENANT_QUOTA_CPU: 'lots',
      FF_DEV_USER_ID: '1',
    });

    expect(settings).toEqual({
      host: 'db.internal',
      port: 5432,
      username: 'postgres',
      password: 'a-long-database-secret',
      name: 'postgres',
      logging: false,
      ssl: false,
    });
  });

  it('still refuses bad database values and the default password in production', () => {
    expect(problems({ DB_PORT: 'abc' }, databaseConfiguration)).toEqual([
      'DB_PORT must be a whole number from 1 to 65535; got "abc"',
    ]);
    expect(problems({ NODE_ENV: 'production' }, databaseConfiguration)).toEqual([
      'DB_PASSWORD must be set, and not to the development default, when NODE_ENV=production',
    ]);
  });
});

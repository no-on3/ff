// Imported through the "@/" alias on purpose: this spec also proves the
// Jest moduleNameMapper matches the tsconfig "paths" mapping.
import configuration, { ConfigurationError, Env, VARIABLES, databaseConfiguration } from '@/config/configuration';
import { parse as parseEnvFile } from 'dotenv';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** The smallest valid development environment: everything else has a default. */
const dev: Env = { FF_AUTH_MODE: 'dev', FF_DEV_ACCOUNT_ID: '000000000001' };

/** The smallest valid production environment. */
const production: Env = {
  NODE_ENV: 'production',
  FF_OIDC_ISSUER: 'https://login.ff.example/realms/ff',
  FF_OIDC_AUDIENCE: 'ff-api',
  DB_PASSWORD: 'a-long-database-secret',
  MINIO_ACCESS_KEY: 'prod-access-key',
  MINIO_SECRET_KEY: 'prod-secret-key',
  CORS_ORIGIN: 'https://console.ff.example',
  FF_SMTP_URL: 'smtps://ff:mail-secret@mail.ff.example:465',
  FF_OPERATOR_EMAIL: 'ops@ff.example',
  FF_CONSOLE_URL: 'https://console.ff.example',
  FF_SELLER_NAME: 'FF SARL',
  FF_SELLER_TAX_ID: '1234567/A/M/000',
  FF_SELLER_ADDRESS: '1 rue du Lac, 1053 Tunis',
  FF_BANK_NAME: 'Banque de Tunisie',
  FF_BANK_IBAN: 'TN5910006035183598478831',
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
      minio: { endPoint: 'localhost', port: 9003, useSSL: false, bucketName: 'functions' },
      orchestrator: { driver: 'kubernetes', readyTimeoutSeconds: 90 },
      kubernetes: {
        apiUrl: '',
        tokenFile: '/var/run/secrets/kubernetes.io/serviceaccount/token',
        caFile: '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
        invokeMode: '',
        namespacePrefix: 'ff-t-',
        runtimeImages: { nodejs: 'ff-runtime-nodejs:24-v2', python: 'ff-runtime-python:3.13-v2' },
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
      MINIO_PORT: '9100',
      MINIO_USE_SSL: 'true',
      MINIO_BUCKET_NAME: 'artifacts',
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
    expect(config.minio).toMatchObject({ port: 9100, useSSL: true, bucketName: 'artifacts' });
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
      ['the default storage access key', { MINIO_ACCESS_KEY: undefined }, 'MINIO_ACCESS_KEY must be set, and not to a development default'],
      ['the dev storage access key', { MINIO_ACCESS_KEY: 'ffdevaccesskey' }, 'MINIO_ACCESS_KEY must be set'],
      ['the default storage secret key', { MINIO_SECRET_KEY: 'minioadmin' }, 'MINIO_SECRET_KEY must be set'],
      ['the dev storage secret key', { MINIO_SECRET_KEY: 'ffdevsecretkey-local-only' }, 'MINIO_SECRET_KEY must be set'],
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
    ])('%s', (_label, change, expected) => {
      const found = problems({ ...production, ...change });

      expect(found).toEqual([expect.stringContaining(expected)]);
    });

    it('never repeats a refused credential in the message', () => {
      const message = (() => {
        try {
          configuration({ ...production, MINIO_SECRET_KEY: 'ffdevsecretkey-local-only', DB_PASSWORD: 'postgres' });
        } catch (error) {
          return (error as Error).message;
        }
        return '';
      })();

      expect(message).toContain('MINIO_SECRET_KEY');
      expect(message).not.toContain('ffdevsecretkey-local-only');
      expect(message).not.toMatch(/"postgres"|: postgres/);
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
      ['MINIO_USE_SSL', 'yes', 'MINIO_USE_SSL must be true or false; got "yes"'],
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
      ['MINIO_BUCKET_NAME', 'Functions_Bucket', 'MINIO_BUCKET_NAME must be an S3 bucket name'],
      ['CORS_ORIGIN', 'https://console.ff.example/app', 'CORS_ORIGIN must be a comma-separated list of origins'],
      ['K8S_INGRESS_ALLOW_CIDRS', '10.0.0.0/8,10.0.0.0/33', 'K8S_INGRESS_ALLOW_CIDRS must be a comma-separated list of CIDR blocks such as 10.42.0.0/16; got "10.0.0.0/33"'],
    ])('%s=%s', (name, value, expected) => {
      expect(problems({ ...dev, [name]: value })).toEqual([expect.stringContaining(expected)]);
    });

    it('lists every bad variable at once', () => {
      const found = problems({ ...dev, DB_PORT: 'x', MINIO_USE_SSL: 'maybe', K8S_IMAGE_PULL_POLICY: 'Sometimes' });

      expect(found.map((problem) => problem.split(' ')[0])).toEqual(['DB_PORT', 'MINIO_USE_SSL', 'K8S_IMAGE_PULL_POLICY']);
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

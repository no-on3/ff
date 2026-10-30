/**
 * L2: customers' mail's identities on a real PostgreSQL, through the SES
 * endpoint, requests signed as AWS's signer signs them for SES v2 (ADR 0012):
 * a domain made with its DKIM key and records, proved once its record is
 * found, its return path once its MX is; one there already, and one past the
 * plan, refused; an address proved by the link it is e-mailed, once; lists in
 * pages, both ways today's and older SDKs ask; deletion; the account's quotas;
 * the suppression list; a read-only key, a key that names buckets, another
 * account's, a suspended one's, and requests that aren't signed. The DNS and
 * FF's own mail are stand-ins. Each run works in a scratch database, dropped
 * afterwards.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { SignatureV4 } from '@smithy/signature-v4';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { EncryptionService } from '../encryption/encryption.service';
import { Mail, MailService } from '../mail/mail.service';
import { onePlan, plan } from '../plans/test-fixtures';
import { Bucket } from '../storage/bucket.entity';
import { StorageDirectory } from '../storage/storage-directory.service';
import { StorageKey } from '../storage/storage-key.entity';
import { newAccessKeyId, newSecretAccessKey } from '../storage/storage-names';
import { EmailAccountService } from './email-account.service';
import { EmailIdentitiesService } from './email-identities.service';
import { EmailIdentity } from './email-identity.entity';
import { EmailMessage } from './email-message.entity';
import { EmailMessagesService } from './email-messages.service';
import { EmailSender } from './email-sender.service';
import { EmailSending } from './email-sending.entity';
import { EmailSuppression } from './email-suppression.entity';
import { EmailSuppressionsService } from './email-suppressions.service';
import { MailResolver } from './mail-domain';
import { SesFrontDoor } from './ses-front-door';
import { SesOperations } from './ses-operations';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '810000000001';
const OTHER = '810000000002';
const SUSPENDED = '810000000003';
const REGION = 'tn-tunis-1';
const MAIL_HOST = 'mail.ff.test';

/** SHA-256 and its HMAC, as AWS's signer takes them. */
class Sha256 {
  private readonly hash;
  constructor(secret?: string | Uint8Array) {
    this.hash = secret === undefined ? createHash('sha256') : createHmac('sha256', Buffer.from(secret));
  }
  update(data: string | Uint8Array): void {
    this.hash.update(data);
  }
  digest(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(this.hash.digest()));
  }
}

run("customers' mail's identities through the SES endpoint, in FF's database (L2)", () => {
  const encryption = new EncryptionService({ getOrThrow: () => [{ id: 'test', key: randomBytes(32) }] } as unknown as ConfigService);
  let db: ScratchDatabase;
  let frontDoor: SesFrontDoor;
  let identities: EmailIdentitiesService;
  let port: number;
  const key = { id: newAccessKeyId(), secret: newSecretAccessKey() };
  const reader = { id: newAccessKeyId(), secret: newSecretAccessKey() };
  const theirs = { id: newAccessKeyId(), secret: newSecretAccessKey() };
  const photosOnly = { id: newAccessKeyId(), secret: newSecretAccessKey() };
  const suspended = { id: newAccessKeyId(), secret: newSecretAccessKey() };
  /** The DNS, as the stand-in answers it: the records published so far. */
  const zone = { txt: new Map<string, string[]>(), mx: new Map<string, string[]>() };
  const resolver: MailResolver = { txt: async (name) => zone.txt.get(name) ?? [], mx: async (name) => zone.mx.get(name) ?? [] };
  /** FF's own mail, as the stand-in takes it. */
  const sent: Mail[] = [];
  const mail = {
    send: async (one: Mail) => {
      sent.push(one);
      return true;
    },
  } as unknown as MailService;

  /** An answer of the endpoint: its status, its error's name, and its body, JSON or a page. */
  interface Answer {
    status: number;
    error: string | null;
    body: Record<string, unknown>;
    text: string;
  }
  function send(method: string, path: string, headers: Record<string, string>, body?: string): Promise<Answer> {
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const type = response.headers['x-amzn-errortype'];
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(text) as Record<string, unknown>;
          } catch {
            // A page, not JSON.
          }
          resolve({ status: response.statusCode ?? 0, error: typeof type === 'string' ? type.split(':')[0] : null, body: parsed, text });
        });
      });
      outgoing.once('error', reject);
      outgoing.end(body);
    });
  }
  /** A request as AWS's SDK sends it: its path escaped once, signed for ses with the key, its path escaped twice in what is signed. */
  async function ses(method: string, path: string, { input, query = {}, as = key }: { input?: unknown; query?: Record<string, string>; as?: typeof key } = {}): Promise<Answer> {
    const body = input === undefined ? undefined : JSON.stringify(input);
    const signer = new SignatureV4({ service: 'ses', region: REGION, credentials: { accessKeyId: as.id, secretAccessKey: as.secret }, sha256: Sha256 });
    const host = `127.0.0.1:${port}`;
    const signed = await signer.sign({ method, protocol: 'http:', hostname: '127.0.0.1', port, path, query, headers: { host, ...(body ? { 'content-type': 'application/json' } : {}) }, body });
    const search = new URLSearchParams(query).toString();
    return send(method, `${path}${search ? `?${search}` : ''}`, signed.headers, body);
  }
  const identityPath = (name: string) => `/v2/email/identities/${encodeURIComponent(name)}`;
  /** The DKIM record a domain was given, published. */
  const publish = async (domain: string) => {
    const row = (await identities.find(ACCOUNT, domain)) as EmailIdentity;
    for (const record of identities.recordsOf(row)) {
      const table = record.type === 'MX' ? zone.mx : zone.txt;
      table.set(record.name, [...(table.get(record.name) ?? []), record.type === 'MX' ? record.value.split(' ')[1] : record.value]);
    }
  };

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    await db.dataSource.getRepository(Account).save([
      { id: ACCOUNT, name: 'Shop', planId: 'beta', status: AccountStatus.ACTIVE },
      { id: OTHER, name: 'Other', planId: 'beta', status: AccountStatus.ACTIVE },
      { id: SUSPENDED, name: 'Late', planId: 'beta', status: AccountStatus.SUSPENDED },
    ]);
    const keys = db.dataSource.getRepository(StorageKey);
    const directory = new StorageDirectory(db.dataSource.getRepository(Bucket), keys, encryption);
    await keys.save([
      { id: key.id, accountId: ACCOUNT, secret: directory.sealSecret(key.id, key.secret) },
      { id: reader.id, accountId: ACCOUNT, readOnly: true, secret: directory.sealSecret(reader.id, reader.secret) },
      { id: theirs.id, accountId: OTHER, secret: directory.sealSecret(theirs.id, theirs.secret) },
      { id: photosOnly.id, accountId: ACCOUNT, buckets: ['photos'], secret: directory.sealSecret(photosOnly.id, photosOnly.secret) },
      { id: suspended.id, accountId: SUSPENDED, secret: directory.sealSecret(suspended.id, suspended.secret) },
    ]);
    const plans = onePlan(plan({ emailIdentities: 2, emailsPerDay: 200, emailsPerSecond: 1 }));
    const audit = new AuditService(db.dataSource.getRepository(AuditEntry));
    // No server of customers' mail: sending is email-sending.db.spec.ts's.
    const config = new ConfigService({
      email: { mailHost: MAIL_HOST, bounceDomain: `bounces.${MAIL_HOST}`, domainResolvers: [], server: null },
      ses: { base: 'http://email.localhost:3005', region: REGION },
    });
    identities = new EmailIdentitiesService(db.dataSource.getRepository(EmailIdentity), plans, encryption, mail, audit, resolver, config);
    const suppressions = new EmailSuppressionsService(db.dataSource.getRepository(EmailSuppression), audit);
    const account = new EmailAccountService(plans, db.dataSource.getRepository(EmailSending));
    const messages = new EmailMessagesService(db.dataSource.getRepository(EmailMessage), identities, suppressions, account, plans, { kick: () => undefined } as unknown as EmailSender, config);
    frontDoor = new SesFrontDoor(directory, new SesOperations(identities, suppressions, account, messages), identities);
    port = (await frontDoor.listen(0, '127.0.0.1')).port;
  });

  afterAll(async () => {
    await frontDoor?.onModuleDestroy();
    await db?.drop();
  });

  describe('a domain', () => {
    it('is made with a DKIM key of its own, FF\'s, as "bring your own DKIM" names it, pending until its record is found', async () => {
      const made = await ses('POST', '/v2/email/identities', { input: { EmailIdentity: 'Shop.Example.TN' } });

      expect(made).toMatchObject({ status: 200, error: null });
      expect(made.body).toMatchObject({ IdentityType: 'DOMAIN', VerifiedForSendingStatus: false, DkimAttributes: { SigningEnabled: true, Status: 'PENDING', SigningAttributesOrigin: 'EXTERNAL' } });
      const row = (await identities.find(ACCOUNT, 'shop.example.tn')) as EmailIdentity;
      expect((made.body.DkimAttributes as { Tokens: string[] }).Tokens).toEqual([row.dkimSelector]);
      expect(identities.recordsOf(row).map((record) => `${record.purpose} ${record.type} ${record.name}`)).toEqual([
        `DKIM TXT ${row.dkimSelector}._domainkey.shop.example.tn`,
        'MAIL_FROM MX bounces.mail.shop.example.tn',
        'SPF TXT bounces.mail.shop.example.tn',
        'DMARC TXT _dmarc.shop.example.tn',
      ]);
      // Its private key, sealed, signs; its public one is the record's.
      expect(identities.privateKeyOf(row)).toMatch(/^-----BEGIN PRIVATE KEY-----/);
      expect(identities.recordsOf(row)[0].value).toBe(`v=DKIM1; k=rsa; p=${row.dkimPublicKey}`);
      expect(await db.dataSource.query(`SELECT action, actor FROM audit_log WHERE resource = 'email-identity:shop.example.tn'`)).toEqual([{ action: 'email.identity.create', actor: `access_key:${key.id}` }]);
    });

    it('is proved once its DKIM record is found, its return path once its MX is, as each minute looks again', async () => {
      await publish('shop.example.tn');
      const mx = 'bounces.mail.shop.example.tn';
      const published = zone.mx.get(mx);
      zone.mx.delete(mx);
      expect(await identities.checkDue()).toBe(1);
      let shown = await ses('GET', identityPath('shop.example.tn'));
      expect(shown.body).toMatchObject({ VerifiedForSendingStatus: true, VerificationStatus: 'SUCCESS', MailFromAttributes: { MailFromDomain: mx, MailFromDomainStatus: 'PENDING', BehaviorOnMxFailure: 'USE_DEFAULT_VALUE' } });

      zone.mx.set(mx, published ?? []);
      const row = (await identities.find(ACCOUNT, 'shop.example.tn')) as EmailIdentity;
      await identities.checkNow({ accountId: ACCOUNT }, row);
      shown = await ses('GET', identityPath('shop.example.tn'));
      expect(shown.body.MailFromAttributes).toMatchObject({ MailFromDomainStatus: 'SUCCESS' });
      // Proved, it is looked at again once a day only.
      expect(await identities.checkDue()).toBe(0);
    });

    it('is refused when the account has it already, past the plan, or when it brings a key of its own', async () => {
      expect(await ses('POST', '/v2/email/identities', { input: { EmailIdentity: 'shop.example.tn' } })).toMatchObject({
        status: 400,
        error: 'AlreadyExistsException',
        body: { message: 'Email identity shop.example.tn already exist.' },
      });
      expect((await ses('POST', '/v2/email/identities', { input: { EmailIdentity: 'news.example.tn' } })).status).toBe(200);
      expect(await ses('POST', '/v2/email/identities', { input: { EmailIdentity: 'third.example.tn' } })).toMatchObject({
        status: 400,
        error: 'LimitExceededException',
        body: { message: 'The Beta plan allows 2 domains to send mail from, and the account has 2: delete one first' },
      });
      expect((await ses('POST', '/v2/email/identities', { input: { EmailIdentity: 'other.example.tn', DkimSigningAttributes: { DomainSigningSelector: 's1' } } })).error).toBe('BadRequestException');
      expect((await ses('POST', '/v2/email/identities', { input: { EmailIdentity: 'not a domain' } })).error).toBe('BadRequestException');
    });
  });

  describe('an address', () => {
    it('is proved by the link FF e-mails it, once', async () => {
      const made = await ses('POST', '/v2/email/identities', { input: { EmailIdentity: 'Orders@Shop.Example.TN' } });
      expect(made.body).toEqual({ IdentityType: 'EMAIL_ADDRESS', VerifiedForSendingStatus: false });
      const link = sent.at(-1);
      expect(link?.to).toBe('orders@shop.example.tn');
      const token = /\/verify\?token=([A-Za-z0-9_-]{32})/.exec(link?.text ?? '')?.[1] as string;

      const followed = await send('GET', `/verify?token=${token}`, {});
      expect([followed.status, followed.text.includes('orders@shop.example.tn')]).toEqual([200, true]);
      expect((await ses('GET', identityPath('orders@shop.example.tn'))).body).toMatchObject({ IdentityType: 'EMAIL_ADDRESS', VerifiedForSendingStatus: true, VerificationStatus: 'SUCCESS' });
      expect((await send('GET', `/verify?token=${token}`, {})).status).toBe(404);
      expect((await send('GET', '/verify?token=nothing', {})).status).toBe(404);
    });
  });

  it('lists the identities in pages, as today\'s SDKs ask with a POST and older ones with a GET', async () => {
    const first = await ses('POST', '/v2/email/list-identities', { input: { PageSize: 2 } });
    expect(first.body.EmailIdentities).toEqual([
      { IdentityType: 'DOMAIN', IdentityName: 'news.example.tn', SendingEnabled: false, VerificationStatus: 'PENDING' },
      { IdentityType: 'EMAIL_ADDRESS', IdentityName: 'orders@shop.example.tn', SendingEnabled: true, VerificationStatus: 'SUCCESS' },
    ]);
    const second = await ses('POST', '/v2/email/list-identities', { input: { PageSize: 2, NextToken: first.body.NextToken } });
    expect([(second.body.EmailIdentities as Array<{ IdentityName: string }>).map((one) => one.IdentityName), second.body.NextToken]).toEqual([['shop.example.tn'], undefined]);
    const older = await ses('GET', '/v2/email/identities', { query: { PageSize: '10' } });
    expect((older.body.EmailIdentities as unknown[]).length).toBe(3);
    expect((await ses('POST', '/v2/email/list-identities', { input: { NextToken: 'nope' } })).error).toBe('BadRequestException');
  });

  it("answers the account's quotas, the plan's, and its sandbox, as GetAccount does", async () => {
    expect((await ses('GET', '/v2/email/account')).body).toEqual({
      DedicatedIpAutoWarmupEnabled: false,
      EnforcementStatus: 'HEALTHY',
      ProductionAccessEnabled: false,
      SendQuota: { Max24HourSend: 200, MaxSendRate: 1, SentLast24Hours: 0 },
      SendingEnabled: true,
      SuppressionAttributes: { SuppressedReasons: ['BOUNCE', 'COMPLAINT'] },
    });
  });

  it('keeps the suppression list: an address put, read, listed by reason, and taken off', async () => {
    expect((await ses('PUT', '/v2/email/suppression/addresses', { input: { EmailAddress: 'Gone@Example.TN', Reason: 'BOUNCE' } })).status).toBe(200);
    await ses('PUT', '/v2/email/suppression/addresses', { input: { EmailAddress: 'angry@example.tn', Reason: 'COMPLAINT' } });
    expect((await ses('GET', '/v2/email/suppression/addresses/gone%40example.tn')).body).toMatchObject({ SuppressedDestination: { EmailAddress: 'gone@example.tn', Reason: 'BOUNCE' } });
    const complaints = await ses('GET', '/v2/email/suppression/addresses', { query: { Reason: 'COMPLAINT' } });
    expect((complaints.body.SuppressedDestinationSummaries as Array<{ EmailAddress: string }>).map((one) => one.EmailAddress)).toEqual(['angry@example.tn']);
    expect((await ses('PUT', '/v2/email/suppression/addresses', { input: { EmailAddress: 'x@example.tn', Reason: 'SPAM' } })).error).toBe('BadRequestException');

    expect((await ses('DELETE', '/v2/email/suppression/addresses/gone%40example.tn')).status).toBe(200);
    expect(await ses('GET', '/v2/email/suppression/addresses/gone%40example.tn')).toMatchObject({ status: 404, error: 'NotFoundException' });
  });

  it('deletes an identity: it is found no more', async () => {
    expect((await ses('DELETE', identityPath('news.example.tn'))).status).toBe(200);
    expect(await ses('GET', identityPath('news.example.tn'))).toMatchObject({ status: 404, error: 'NotFoundException', body: { message: 'Email identity news.example.tn does not exist.' } });
    expect((await ses('DELETE', identityPath('news.example.tn'))).error).toBe('NotFoundException');
  });

  describe('its keys', () => {
    it('lets a read-only key read, and nothing else', async () => {
      expect((await ses('GET', '/v2/email/account', { as: reader })).status).toBe(200);
      expect(await ses('POST', '/v2/email/identities', { input: { EmailIdentity: 'more.example.tn' }, as: reader })).toMatchObject({ status: 403, error: 'AccessDeniedException' });
    });

    it("shows another account nothing of this one's, and refuses a key that names buckets, and a suspended account's", async () => {
      expect((await ses('POST', '/v2/email/list-identities', { input: {}, as: theirs })).body.EmailIdentities).toEqual([]);
      expect((await ses('GET', identityPath('shop.example.tn'), { as: theirs })).error).toBe('NotFoundException');
      expect((await ses('GET', '/v2/email/account', { as: photosOnly })).error).toBe('AccessDeniedException');
      expect(await ses('GET', '/v2/email/account', { as: suspended })).toMatchObject({ status: 403, error: 'AccessDeniedException', body: { message: 'The account is suspended: its mail answers no key.' } });
    });

    it("refuses a request that isn't signed and a key FF doesn't know; without a mail server, sends nothing; and answers NotImplemented for what it doesn't do", async () => {
      expect(await send('GET', '/v2/email/account', { host: `127.0.0.1:${port}` })).toMatchObject({ status: 403, error: 'MissingAuthenticationTokenException' });
      expect((await ses('GET', '/v2/email/account', { as: { id: newAccessKeyId(), secret: newSecretAccessKey() } })).error).toBe('UnrecognizedClientException');
      expect(await ses('POST', '/v2/email/outbound-emails', { input: {} })).toMatchObject({ status: 400, error: 'BadRequestException', body: { message: 'Content is required: Simple or Raw' } });
      const message = { FromEmailAddress: 'orders@shop.example.tn', Destination: { ToAddresses: ['orders@shop.example.tn'] }, Content: { Simple: { Subject: { Data: 'Hi' }, Body: { Text: { Data: 'Hello' } } } } };
      expect(await ses('POST', '/v2/email/outbound-emails', { input: message })).toMatchObject({ status: 400, error: 'SendingPausedException' });
      expect(await ses('GET', '/v2/email/configuration-sets')).toMatchObject({ status: 501, error: 'NotImplemented' });
    });
  });
});

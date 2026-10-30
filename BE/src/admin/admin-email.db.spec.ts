/**
 * L2: an account's sending changed by FF's operators (ADR 0012), on a real
 * PostgreSQL: out of the sandbox, paused, its enforcement cleared, each change
 * with its reason in the account's audit log and an e-mail to its owners, each
 * in their language; a retry changing nothing and telling no one; another
 * account untouched. Each run works in a scratch database, dropped afterwards.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { Membership } from '../accounts/entities/membership.entity';
import { User } from '../accounts/entities/user.entity';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { EmailAccountService } from '../email/email-account.service';
import { EmailIdentitiesService } from '../email/email-identities.service';
import { EmailIdentity } from '../email/email-identity.entity';
import { EmailSending } from '../email/email-sending.entity';
import { EncryptionService } from '../encryption/encryption.service';
import { Language, Recipient, languageOf } from '../mail/language';
import { Mail, MailService } from '../mail/mail.service';
import { onePlan, plan } from '../plans/test-fixtures';
import { AdminEmailService } from './admin-email.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '830000000001';
const OTHER = '830000000002';

run("an account's sending, changed by FF's operators, in FF's database (L2)", () => {
  let db: ScratchDatabase;
  let email: AdminEmailService;
  const sent: Mail[] = [];
  const mail = {
    send: async (one: Mail) => {
      sent.push(one);
      return true;
    },
    sendEach: async (recipients: Recipient[], compose: (language: Language) => Omit<Mail, 'to'>) => {
      for (const { email: to, locale } of recipients) sent.push({ to, ...compose(languageOf(locale)) });
      return true;
    },
  } as unknown as MailService;
  const auditOf = async (accountId: string) =>
    db.dataSource.query<Array<{ action: string; details: unknown }>>(`SELECT action, details FROM audit_log WHERE account_id = $1 AND action = 'account.email' ORDER BY id`, [accountId]);

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    await db.dataSource.getRepository(Account).save([
      { id: ACCOUNT, name: 'Tunis Labs', planId: 'beta', status: AccountStatus.ACTIVE },
      { id: OTHER, name: 'Other', planId: 'beta', status: AccountStatus.ACTIVE },
    ]);
    const users = db.dataSource.getRepository(User);
    const amira = await users.save({ oidcSub: 'kc-amira', email: 'amira@ff.test', name: 'Amira', locale: 'fr-TN' });
    const sami = await users.save({ oidcSub: 'kc-sami', email: 'sami@ff.test', name: 'Sami', locale: 'en' });
    const dev = await users.save({ oidcSub: 'kc-dev', email: 'dev@ff.test', name: 'Dev', locale: 'en' });
    await db.dataSource.getRepository(Membership).save([
      { accountId: ACCOUNT, userId: amira.id, role: 'owner' },
      { accountId: ACCOUNT, userId: sami.id, role: 'owner' },
      { accountId: ACCOUNT, userId: dev.id, role: 'developer' },
    ]);
    const plans = onePlan(plan({ emailIdentities: 2, emailsPerDay: 200, emailsPerSecond: 1 }));
    const audit = new AuditService(db.dataSource.getRepository(AuditEntry));
    const config = new ConfigService({
      mail: { consoleUrl: 'https://console.ff.test' },
      email: { mailHost: 'mail.ff.test', bounceDomain: 'bounces.mail.ff.test', domainResolvers: [], server: null },
      ses: { base: 'http://email.localhost:3005', region: 'tn-tunis-1' },
    });
    const encryption = new EncryptionService({ getOrThrow: () => [{ id: 'test', key: randomBytes(32) }] } as unknown as ConfigService);
    const identities = new EmailIdentitiesService(
      db.dataSource.getRepository(EmailIdentity),
      plans,
      encryption,
      mail,
      audit,
      { txt: async () => [], mx: async () => [] },
      config,
    );
    await identities.create({ accountId: ACCOUNT }, 'shop.example.tn');
    email = new AdminEmailService(
      db.dataSource.getRepository(Account),
      db.dataSource.getRepository(Membership),
      new EmailAccountService(plans, db.dataSource.getRepository(EmailSending)),
      identities,
      audit,
      mail,
      config,
    );
  });

  afterAll(() => db?.drop());
  beforeEach(() => (sent.length = 0));

  it("reads a new account's sending: in the sandbox, on, healthy, the plan's quotas, its domain", async () => {
    expect(await email.view(ACCOUNT)).toEqual({
      sandbox: true,
      sendingEnabled: true,
      enforcementStatus: 'HEALTHY',
      max24HourSend: 200,
      maxSendRate: 1,
      sentLast24Hours: 0,
      reason: null,
      updatedAt: null,
      identities: [{ identity: 'shop.example.tn', type: 'DOMAIN', status: 'PENDING' }],
    });
    await expect(email.view('839999999999')).rejects.toThrow(NotFoundException);
  });

  it("lifts the sandbox with a reason: the audit log says so, each owner is told in their language, the developer isn't", async () => {
    const view = await email.change(ACCOUNT, { productionAccess: true }, 'Sends its receipts, checked with the owner');

    expect([view.sandbox, view.sendingEnabled, view.reason]).toEqual([false, true, 'Sends its receipts, checked with the owner']);
    expect(await auditOf(ACCOUNT)).toEqual([
      { action: 'account.email', details: { reason: 'Sends its receipts, checked with the owner', changes: { productionAccess: { from: false, to: true } } } },
    ]);
    expect(sent.map((one) => [one.to, one.subject]).sort()).toEqual([
      ['amira@ff.test', 'Le courrier de votre compte FF : Tunis Labs'],
      ['sami@ff.test', "Your FF account's mail: Tunis Labs"],
    ]);
    expect((await email.view(OTHER)).sandbox).toBe(true);
  });

  it('changes nothing, and tells no one, for the values the account has already', async () => {
    await email.change(ACCOUNT, { productionAccess: true }, 'Again, by mistake');

    expect([(await auditOf(ACCOUNT)).length, sent.length, (await email.view(ACCOUNT)).reason]).toEqual([1, 0, 'Sends its receipts, checked with the owner']);
  });

  it('pauses it, and clears a stop after a review, keeping what it changes not', async () => {
    await email.change(ACCOUNT, { sendingEnabled: false }, 'Spam seen by a provider');
    await db.dataSource.query(`UPDATE email_sending SET enforcement_status = 'SHUTDOWN' WHERE account_id = $1`, [ACCOUNT]);

    const view = await email.change(ACCOUNT, { sendingEnabled: true, enforcementStatus: 'HEALTHY' }, 'Reviewed with the owner: a list cleaned');

    expect([view.sandbox, view.sendingEnabled, view.enforcementStatus]).toEqual([false, true, 'HEALTHY']);
    expect((await auditOf(ACCOUNT)).slice(1).map((entry) => entry.details)).toEqual([
      { reason: 'Spam seen by a provider', changes: { sendingEnabled: { from: true, to: false } } },
      { reason: 'Reviewed with the owner: a list cleaned', changes: { sendingEnabled: { from: false, to: true }, enforcementStatus: { from: 'SHUTDOWN', to: 'HEALTHY' } } },
    ]);
    await expect(email.change('839999999999', { sendingEnabled: false }, 'No such account here')).rejects.toThrow(NotFoundException);
  });
});

/**
 * L2: customers' messages on a real PostgreSQL (ADR 0012), as the SES
 * endpoint and FF's API send them: taken from a domain or an address the
 * account proved, in the sandbox to its proved ones alone, within the plan's
 * quotas a day and a second, counted under the account's lock, the suppression
 * list's addresses kept off; queued, then handed over SMTP to a stand-in for
 * the server of customers' mail, each signed with its domain's DKIM key, its
 * envelope's sender its return path; a refusal for now tried again later, one
 * for good failing it, two backends never handing one over twice. Then what
 * comes back, from a stand-in for the server's agent: a bounce for good, which
 * puts the address on the suppression list, one for now, which doesn't, a
 * complaint; and the account's rates, reviewed past SES's, stopped further,
 * the operator told. Each run works in a scratch database, dropped afterwards.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, randomUUID, verify } from 'node:crypto';
import { IncomingMessage, Server as HttpServer, ServerResponse, createServer as createHttpServer } from 'node:http';
import { AddressInfo, Server, Socket, createServer } from 'node:net';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import { InsufficientCreditException } from '../billing/credit-policy';
import { CreditService } from '../billing/credit.service';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { EncryptionService } from '../encryption/encryption.service';
import { Mail, MailService } from '../mail/mail.service';
import { onePlan, plan } from '../plans/test-fixtures';
import { EmailAccountService } from './email-account.service';
import { EmailBounces } from './email-bounces.service';
import { EmailIdentitiesService } from './email-identities.service';
import { EmailIdentity } from './email-identity.entity';
import { EmailMessage, EmailMessageStatus, MessageRecipient } from './email-message.entity';
import { EmailMessagesService, SendRefusal, SendRequest } from './email-messages.service';
import { EmailSender } from './email-sender.service';
import { EmailSending } from './email-sending.entity';
import { EmailSuppression, SuppressionReason } from './email-suppression.entity';
import { EmailSuppressionsService } from './email-suppressions.service';
import { MailResolver } from './mail-domain';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '820000000001';
const OTHER = '820000000002';
const MAIL_HOST = 'mail.ff.test';
const TOKEN = 'agent-token';

/** A message the stand-in took: its envelope and its text, dots unstuffed. */
interface Taken {
  from: string;
  to: string[];
  data: string;
}

/**
 * The stand-in for the server of customers' mail: SMTP without TLS, as Node's
 * standard library speaks it, keeping each message it takes. It refuses the
 * addresses in `refuse` at RCPT, for good, and answers MAIL FROM with `next`,
 * once, when it is set: a 4xx to try again later, a 5xx for good.
 */
class StandInServer {
  readonly taken: Taken[] = [];
  readonly refuse = new Set<string>();
  next: string | null = null;
  port = 0;
  private readonly sockets = new Set<Socket>();
  private readonly server: Server = createServer((socket) => this.serve(socket));

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }

  private serve(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.setEncoding('latin1');
    let buffer = '';
    let envelope = { from: '', to: [] as string[] };
    let data: string | null = null;
    const say = (line: string) => socket.write(`${line}\r\n`);
    say('220 stand-in.ff.test ESMTP');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (data !== null) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          data += buffer.slice(0, end + 2);
          buffer = buffer.slice(end + 5);
          this.taken.push({ ...envelope, data: data.replace(/^\.\./gm, '.') });
          data = null;
          envelope = { from: '', to: [] };
          say(`250 2.0.0 Ok: queued as ${this.taken.length}`);
          continue;
        }
        const at = buffer.indexOf('\r\n');
        if (at < 0) return;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') say('250-stand-in.ff.test\r\n250-8BITMIME\r\n250 SMTPUTF8');
        else if (verb === 'HELO') say('250 stand-in.ff.test');
        else if (verb === 'MAIL') {
          const answer = this.next;
          this.next = null;
          if (answer) {
            say(answer);
            continue;
          }
          envelope = { from: /<([^>]*)>/.exec(line)?.[1] ?? '', to: [] };
          say('250 2.1.0 Ok');
        } else if (verb === 'RCPT') {
          const to = /<([^>]*)>/.exec(line)?.[1] ?? '';
          if (this.refuse.has(to)) say(`550 5.1.1 <${to}>: Recipient address rejected: User unknown`);
          else {
            envelope.to.push(to);
            say('250 2.1.5 Ok');
          }
        } else if (verb === 'DATA') {
          data = '';
          say('354 End data with <CR><LF>.<CR><LF>');
        } else if (verb === 'RSET') {
          envelope = { from: '', to: [] };
          say('250 2.0.0 Ok');
        } else if (verb === 'NOOP') say('250 2.0.0 Ok');
        else if (verb === 'QUIT') {
          say('221 2.0.0 Bye');
          socket.end();
          return;
        } else say('502 5.5.2 Error: command not recognized');
      }
    });
  }
}

/** The stand-in for the server's agent: what came back, by its ID, given and deleted as the agent does, to its token alone. */
class StandInAgent {
  readonly waiting = new Map<string, Buffer>();
  port = 0;
  private readonly server: HttpServer = createHttpServer((request, response) => this.serve(request, response));

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  close(): Promise<unknown> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(resolve));
  }

  private serve(request: IncomingMessage, response: ServerResponse): void {
    const answer = (status: number, body?: unknown) => {
      response.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (request.headers.authorization !== `Bearer ${TOKEN}`) return answer(401, { message: 'no' });
    const url = new URL(request.url ?? '/', 'http://agent');
    if (request.method === 'GET' && url.pathname === '/bounces') {
      const limit = Number(url.searchParams.get('limit') ?? 20);
      const bounces = [...this.waiting].slice(0, limit).map(([id, message]) => ({ id, receivedAt: new Date().toISOString(), message: message.toString('base64') }));
      return answer(200, { bounces });
    }
    const id = /^\/bounces\/(.+)$/.exec(url.pathname)?.[1];
    if (request.method === 'DELETE' && id) return answer(this.waiting.delete(decodeURIComponent(id)) ? 204 : 404);
    answer(404, { message: 'no such route' });
  }
}

/**
 * A message's DKIM signature, checked as a receiving server checks one signed
 * relaxed/relaxed with rsa-sha256 (RFC 6376), against the public key the
 * domain's record publishes: its tags, and whether its body's hash and its
 * signature hold. Null for a message without one.
 */
function dkimOf(message: string, publicKey: string): { d: string; s: string; a: string; c: string; body: boolean; signature: boolean } | null {
  const split = message.indexOf('\r\n\r\n');
  const head = message.slice(0, split + 2);
  const body = message.slice(split + 4);
  const fields = head
    .split(/\r\n(?![ \t])/)
    .filter((field) => field !== '')
    .map((raw) => ({ name: raw.slice(0, raw.indexOf(':')).trim().toLowerCase(), raw }));
  const field = fields.find((one) => one.name === 'dkim-signature');
  if (!field) return null;
  const tags = Object.fromEntries(
    field.raw
      .slice(field.raw.indexOf(':') + 1)
      .split(';')
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '')
      .map((tag) => [tag.slice(0, tag.indexOf('=')).trim(), tag.slice(tag.indexOf('=') + 1).replace(/\s+/g, '')]),
  ) as Record<string, string>;
  const relaxed = (raw: string) => {
    const at = raw.indexOf(':');
    return `${raw.slice(0, at).trim().toLowerCase()}:${raw.slice(at + 1).replace(/\r\n/g, '').replace(/[ \t]+/g, ' ').trim()}`;
  };
  const lines = body.split('\r\n').map((line) => line.replace(/[ \t]+/g, ' ').replace(/ $/, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const bodyHash = createHash('sha256')
    .update(lines.length > 0 ? `${lines.join('\r\n')}\r\n` : '')
    .digest('base64');
  // The fields signed, a name given twice taking its fields from the bottom up.
  const used = new Map<string, number>();
  const signed = tags.h
    .split(':')
    .map((name) => {
      const key = name.trim().toLowerCase();
      const all = fields.filter((one) => one.name === key);
      used.set(key, (used.get(key) ?? 0) + 1);
      const one = all[all.length - (used.get(key) as number)];
      return one ? `${relaxed(one.raw)}\r\n` : '';
    })
    .join('');
  const own = relaxed(field.raw.replace(/(;\s*b\s*=)[^;]*/, '$1'));
  const signature = verify('sha256', Buffer.from(signed + own, 'latin1'), { key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }, Buffer.from(tags.b, 'base64'));
  return { d: tags.d, s: tags.s, a: tags.a, c: tags.c, body: bodyHash === tags.bh, signature };
}

/** Postfix's bounce of a message, as it writes one: each recipient failed with its status and its server's words. */
function bounce(id: string, domain: string, recipients: Array<{ address: string; status: string; diagnostic: string }>): Buffer {
  const boundary = '539BA1E69345.1793326706/mail.ff.test';
  return Buffer.from(
    [
      'Return-Path: <>',
      `X-Original-To: b-${id}@${domain}`,
      `Delivered-To: b-${id}@${domain}`,
      'From: Mail Delivery System <MAILER-DAEMON@mail.ff.test>',
      'Subject: Undelivered Mail Returned to Sender',
      `To: b-${id}@${domain}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Description: Notification',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'This is the mail system at host mail.ff.test.',
      '',
      `--${boundary}`,
      'Content-Description: Delivery report',
      'Content-Type: message/delivery-status',
      '',
      'Reporting-MTA: dns; mail.ff.test',
      '',
      ...recipients.flatMap(({ address, status, diagnostic }) => [`Final-Recipient: rfc822; ${address}`, 'Action: failed', `Status: ${status}`, `Diagnostic-Code: smtp; ${diagnostic}`, '']),
      `--${boundary}--`,
      '',
    ].join('\r\n'),
  );
}

/** A mailbox provider's abuse report (RFC 5965) of a message, its original's return path naming it. */
function complaint(id: string, domain: string, recipient: string): Buffer {
  const boundary = 'arf-boundary';
  return Buffer.from(
    [
      'From: abuse@provider.example',
      `To: b-${id}@${domain}`,
      'Subject: Abuse report',
      'MIME-Version: 1.0',
      `Content-Type: multipart/report; report-type=feedback-report; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain',
      '',
      'This is an abuse report.',
      '',
      `--${boundary}`,
      'Content-Type: message/feedback-report',
      '',
      'Feedback-Type: abuse',
      'User-Agent: provider/1.0',
      'Version: 1',
      `Original-Rcpt-To: ${recipient}`,
      '',
      `--${boundary}`,
      'Content-Type: message/rfc822-headers',
      '',
      `Return-Path: <b-${id}@${domain}>`,
      'From: orders@shop.example.tn',
      `To: ${recipient}`,
      'Subject: Your order',
      '',
      `--${boundary}--`,
      '',
    ].join('\r\n'),
  );
}

run("customers' messages, sent and come back, in FF's database (L2)", () => {
  const encryption = new EncryptionService({ getOrThrow: () => [{ id: 'test', key: randomBytes(32) }] } as unknown as ConfigService);
  const shop = plan({ emailIdentities: 10, emailsPerDay: 1000, emailsPerSecond: 100 });
  const plans = onePlan(shop);
  const server = new StandInServer();
  const agent = new StandInAgent();
  /** FF's own mail, the operator's among it, as the stand-in takes it. */
  const sent: Mail[] = [];
  const mail = {
    send: async (one: Mail) => {
      sent.push(one);
      return true;
    },
  } as unknown as MailService;
  const resolver: MailResolver = { txt: async () => [], mx: async () => [] };
  const kick = jest.fn();
  // The account's credit, as the credit service judges it: enough, until a test says it isn't.
  let creditless = false;
  const credit = {
    admit: async () => {
      if (!creditless) return;
      throw new InsufficientCreditException(
        { currency: 'TND', exponent: 3, balanceMinor: -40_000n, belowBufferSince: new Date('2026-10-17T10:33:00Z') },
        { bufferMinor: 1000n, graceMs: 24 * 3_600_000, shadow: false },
        { state: 'stopped', invokesStopAt: new Date('2026-10-18T10:33:00Z') },
      );
    },
  } as unknown as CreditService;
  let db: ScratchDatabase;
  let identities: EmailIdentitiesService;
  let suppressions: EmailSuppressionsService;
  let account: EmailAccountService;
  let messages: EmailMessagesService;
  let sender: EmailSender;
  let second: EmailSender;
  let bounces: EmailBounces;
  let config: ConfigService;
  let shopKey: string;
  let newsKey: string;
  const query = <T = unknown>(sql: string, parameters?: unknown[]) => db.dataSource.query<T>(sql, parameters);
  const row = (id: string) => db.dataSource.getRepository(EmailMessage).findOneByOrFail({ id });
  const rawOf = async (id: string) => (await query<Array<{ raw: Buffer | null }>>('SELECT raw FROM email_messages WHERE id = $1', [id]))[0].raw;
  const simple = (from: string, to: string[], more: Partial<SendRequest> = {}): SendRequest => ({
    from,
    to,
    cc: [],
    bcc: [],
    replyTo: [],
    content: { simple: { subject: 'Your order', text: 'Thanks for your order.\n', headers: [] } },
    ...more,
  });
  /** A refusal's kind and words, or "taken". */
  const outcome = async (sending: Promise<string>): Promise<string> => {
    try {
      await sending;
      return 'taken';
    } catch (error) {
      if (!(error instanceof SendRefusal)) throw error;
      return `${error.kind}: ${error.message}`;
    }
  };
  /** Sent more than a second ago, as far as the rate a second goes. */
  const aSecondAgo = () => query(`UPDATE email_messages SET created_at = created_at - interval '2 seconds'`);
  /** An identity of the account's, made as FF makes it, then proved: a domain with its return path's MX found or not. */
  const proved = async (accountId: string, name: string, mailFromVerified = false) => {
    const made = await identities.create({ accountId }, name);
    await query(`UPDATE email_identities SET status = 'SUCCESS', verified_at = now(), mail_from_verified = $2 WHERE id = $1`, [made.id, mailFromVerified]);
    return made;
  };

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    await db.dataSource.getRepository(Account).save([
      { id: ACCOUNT, name: 'Shop', planId: 'beta', status: AccountStatus.ACTIVE },
      { id: OTHER, name: 'Other', planId: 'beta', status: AccountStatus.ACTIVE },
    ]);
    await Promise.all([server.listen(), agent.listen()]);
    config = new ConfigService({
      email: {
        mailHost: MAIL_HOST,
        bounceDomain: `bounces.${MAIL_HOST}`,
        domainResolvers: [],
        server: { smtpHost: '127.0.0.1', smtpPort: server.port, agentUrl: `http://127.0.0.1:${agent.port}`, agentToken: TOKEN, requireTls: false },
      },
      ses: { base: 'http://email.localhost:3005', region: 'tn-tunis-1' },
      mail: { operatorEmail: 'operator@ff.test' },
    });
    const audit = new AuditService(db.dataSource.getRepository(AuditEntry));
    identities = new EmailIdentitiesService(db.dataSource.getRepository(EmailIdentity), plans, encryption, mail, audit, resolver, config);
    suppressions = new EmailSuppressionsService(db.dataSource.getRepository(EmailSuppression), audit);
    account = new EmailAccountService(plans, db.dataSource.getRepository(EmailSending));
    // Each round is the test's to run: the queue is kicked, and nothing more.
    messages = new EmailMessagesService(db.dataSource.getRepository(EmailMessage), identities, suppressions, account, plans, { kick } as unknown as EmailSender, credit, config);
    sender = new EmailSender(db.dataSource.getRepository(EmailMessage), identities, config);
    second = new EmailSender(db.dataSource.getRepository(EmailMessage), identities, config);
    sender.open();
    second.open();
    bounces = new EmailBounces(db.dataSource.getRepository(EmailMessage), db.dataSource.getRepository(EmailSending), suppressions, mail, audit, config);

    // The shop's domain, its bounces back to its own return path; another of its domains, whose return path's MX isn't
    // found yet; an address at a domain it hasn't proved, and one not proved yet; and the other account's domain.
    shopKey = (await proved(ACCOUNT, 'shop.example.tn', true)).dkimPublicKey as string;
    newsKey = (await proved(ACCOUNT, 'news.example.tn')).dkimPublicKey as string;
    await proved(ACCOUNT, 'ana@elsewhere.tn');
    await identities.create({ accountId: ACCOUNT }, 'pending@elsewhere.tn');
    await proved(OTHER, 'other.example.tn', true);
  });

  afterAll(async () => {
    sender?.onModuleDestroy();
    second?.onModuleDestroy();
    await Promise.all([server.close(), agent.close()]);
    await db?.drop();
  });

  beforeEach(async () => {
    for (const table of ['email_messages', 'email_sending', 'email_suppressions']) await query(`DELETE FROM "${table}"`);
    Object.assign(shop.limits, { emailsPerDay: 1000, emailsPerSecond: 100 });
    server.taken.length = 0;
    server.refuse.clear();
    server.next = null;
    agent.waiting.clear();
    sent.length = 0;
    kick.mockClear();
    creditless = false;
  });

  describe('a message taken', () => {
    it('is queued at once, then handed to the server: signed with its domain\'s DKIM key, its return path its envelope\'s sender, its Bcc in the envelope alone', async () => {
      const id = await messages.send(ACCOUNT, simple('Shop <Orders@Shop.Example.TN>', ['Ana <ana@elsewhere.tn>'], { bcc: ['audit@shop.example.tn'] }));

      const queued = await row(id);
      expect([queued.status, queued.identity, queued.fromAddress, queued.recipientCount, queued.recipients]).toEqual([
        EmailMessageStatus.QUEUED,
        'shop.example.tn',
        'orders@shop.example.tn',
        2,
        [
          { address: 'ana@elsewhere.tn', status: 'QUEUED' },
          { address: 'audit@shop.example.tn', status: 'QUEUED' },
        ],
      ]);
      expect(queued.returnPath).toBe(`b-${id}@bounces.mail.shop.example.tn`);
      expect(await rawOf(id)).not.toBeNull();
      expect(kick).toHaveBeenCalledTimes(1);

      await sender.drain();

      expect(server.taken).toHaveLength(1);
      const [taken] = server.taken;
      expect([taken.from, taken.to]).toEqual([`b-${id}@bounces.mail.shop.example.tn`, ['ana@elsewhere.tn', 'audit@shop.example.tn']]);
      // Its domain in lower case, as nodemailer writes one.
      expect(taken.data).toMatch(/^From: Shop <Orders@shop\.example\.tn>\r$/m);
      expect(taken.data).toMatch(/^Subject: Your order\r$/m);
      expect(taken.data).toMatch(new RegExp(`^Message-ID: <${id}@email\\.localhost>\\r$`, 'mi'));
      expect(taken.data).not.toMatch(/^Bcc:/im);
      const selector = (await identities.find(ACCOUNT, 'shop.example.tn'))?.dkimSelector;
      expect(dkimOf(taken.data, shopKey)).toEqual({ d: 'shop.example.tn', s: selector, a: 'rsa-sha256', c: 'relaxed/relaxed', body: true, signature: true });
      // The same signature fails once the message changed on the way.
      expect(dkimOf(taken.data.replace('Subject: Your order', 'Subject: Changed'), shopKey)).toMatchObject({ body: true, signature: false });

      const done = await row(id);
      expect([done.status, done.attempts, done.sentAt !== null, done.recipients.map((one) => one.status)]).toEqual([EmailMessageStatus.SENT, 1, true, ['SENT', 'SENT']]);
      expect(await rawOf(id)).toBeNull();
    });

    it("comes back to FF's own return path from a domain whose own isn't found yet, and goes unsigned from an address alone", async () => {
      const news = await messages.send(ACCOUNT, simple('news@news.example.tn', ['ana@elsewhere.tn']));
      await aSecondAgo();
      const ana = await messages.send(ACCOUNT, simple('ana@elsewhere.tn', ['ana@elsewhere.tn']));

      await sender.drain();

      const [fromNews, fromAna] = server.taken;
      expect([fromNews.from, dkimOf(fromNews.data, newsKey)]).toEqual([`b-${news}@bounces.${MAIL_HOST}`, expect.objectContaining({ d: 'news.example.tn', body: true, signature: true })]);
      expect([fromAna.from, dkimOf(fromAna.data, newsKey), (await row(ana)).identity]).toEqual([`b-${ana}@bounces.${MAIL_HOST}`, null, 'ana@elsewhere.tn']);
    });

    it('may be raw: its sender and recipients from its header when the request names none, its Bcc header dropped, signed too', async () => {
      const raw = Buffer.from(
        ['From: Shop <orders@shop.example.tn>', 'To: ana@elsewhere.tn', 'Bcc: audit@shop.example.tn', 'Subject: Raw', `Message-ID: <raw-1@shop.example.tn>`, '', 'Hello', ''].join('\r\n'),
      );

      const id = await messages.send(ACCOUNT, { to: [], cc: [], bcc: [], replyTo: [], content: { raw } });
      await sender.drain();

      expect((await row(id)).recipients.map((one) => one.address)).toEqual(['ana@elsewhere.tn', 'audit@shop.example.tn']);
      const [taken] = server.taken;
      expect([taken.to, /^Bcc:/im.test(taken.data), /^Message-ID: <raw-1@shop\.example\.tn>\r$/m.test(taken.data)]).toEqual([['ana@elsewhere.tn', 'audit@shop.example.tn'], false, true]);
      expect(dkimOf(taken.data, shopKey)).toMatchObject({ d: 'shop.example.tn', body: true, signature: true });
    });

    it("leaves a billing record as SES bills it, its recipients and its attachments' weight as sent, which nothing changes or deletes", async () => {
      const raw = Buffer.from(
        [
          'From: orders@shop.example.tn',
          'To: ana@elsewhere.tn',
          'Cc: audit@shop.example.tn',
          'Subject: Your receipt',
          'MIME-Version: 1.0',
          'Content-Type: multipart/mixed; boundary="part"',
          '',
          '--part',
          'Content-Type: text/plain',
          '',
          'Thank you.',
          '--part',
          'Content-Type: application/pdf',
          'Content-Disposition: attachment; filename="receipt.pdf"',
          'Content-Transfer-Encoding: base64',
          '',
          'JVBERi0xLjQK',
          '--part--',
          '',
        ].join('\r\n'),
      );

      const id = await messages.send(ACCOUNT, { to: [], cc: [], bcc: [], replyTo: [], content: { raw } });

      expect(await query('SELECT account_id AS "accountId", identity, recipients, attachment_bytes AS "attachmentBytes" FROM email_sends WHERE message_id = $1', [id])).toEqual([
        { accountId: ACCOUNT, identity: 'shop.example.tn', recipients: 2, attachmentBytes: 'JVBERi0xLjQK'.length },
      ]);
      await expect(query('UPDATE email_sends SET recipients = 0 WHERE message_id = $1', [id])).rejects.toThrow();
      await expect(query('DELETE FROM email_sends WHERE message_id = $1', [id])).rejects.toThrow();
      await sender.drain();
    });
  });

  describe('a message refused', () => {
    it("from an identity the account hasn't proved, or another account's, in SES's words", async () => {
      const unverified = (who: string) => `rejected: Email address is not verified. The following identities failed the check in region TN-TUNIS-1: ${who}`;

      expect(await outcome(messages.send(ACCOUNT, simple('someone@unproved.tn', ['ana@elsewhere.tn'])))).toBe(unverified('someone@unproved.tn'));
      expect(await outcome(messages.send(ACCOUNT, simple('pending@elsewhere.tn', ['ana@elsewhere.tn'])))).toBe(unverified('pending@elsewhere.tn'));
      expect(await outcome(messages.send(ACCOUNT, simple('orders@other.example.tn', ['ana@elsewhere.tn'])))).toBe(unverified('orders@other.example.tn'));
      expect(await query('SELECT count(*)::int AS n FROM email_messages')).toEqual([{ n: 0 }]);
    });

    it("in the sandbox, to an address the account hasn't proved; out of it, to any", async () => {
      expect(await outcome(messages.send(ACCOUNT, simple('orders@shop.example.tn', ['ana@elsewhere.tn', 'Stranger@Else.TN'])))).toBe(
        'rejected: Email address is not verified. The following identities failed the check in region TN-TUNIS-1: stranger@else.tn',
      );

      await query(`INSERT INTO email_sending (account_id, production_access) VALUES ($1, true)`, [ACCOUNT]);

      expect(await outcome(messages.send(ACCOUNT, simple('orders@shop.example.tn', ['ana@elsewhere.tn', 'stranger@else.tn'])))).toBe('taken');
      expect((await account.state(ACCOUNT)).sandbox).toBe(false);
    });

    it('when its recipients are more than 50, none, or not addresses, saying so', async () => {
      const many = Array.from({ length: 51 }, (_, n) => `a${n}@shop.example.tn`);

      expect(await outcome(messages.send(ACCOUNT, simple('orders@shop.example.tn', many)))).toBe('invalid: Recipient count exceeds 50.');
      expect(await outcome(messages.send(ACCOUNT, simple('orders@shop.example.tn', [])))).toBe(
        "invalid: A message needs a recipient: Destination's ToAddresses, CcAddresses or BccAddresses",
      );
      expect(await outcome(messages.send(ACCOUNT, simple('orders@shop.example.tn', ['not an address'])))).toBe('invalid: Illegal address: not an address');
    });

    it('when the account is paused, or stopped past its rates', async () => {
      await query(`INSERT INTO email_sending (account_id, sending_enabled) VALUES ($1, false)`, [ACCOUNT]);
      expect(await outcome(messages.send(ACCOUNT, simple('orders@shop.example.tn', ['ana@elsewhere.tn'])))).toMatch(/^paused: Sending is paused for this account/);

      await query(`UPDATE email_sending SET sending_enabled = true, enforcement_status = 'SHUTDOWN' WHERE account_id = $1`, [ACCOUNT]);
      expect(await outcome(messages.send(ACCOUNT, simple('orders@shop.example.tn', ['ana@elsewhere.tn'])))).toMatch(/^suspended: The account's sending is stopped/);
    });

    it('when the account is out of credit: nothing is queued, billed or counted against its quotas', async () => {
      // Billing records stay, being append-only: the test counts what it adds.
      const counts = () =>
        query<Array<{ messages: number; billed: number }>>(`SELECT (SELECT count(*)::int FROM email_messages WHERE account_id = $1) AS "messages", (SELECT count(*)::int FROM email_sends WHERE account_id = $1) AS "billed"`, [ACCOUNT]);
      const [before] = await counts();
      creditless = true;
      expect(await outcome(messages.send(ACCOUNT, simple('orders@shop.example.tn', ['buyer@shop.example.tn'])))).toBe(
        'credit: The account is out of credit: its identities and messages are read, and sending waits for credit.',
      );
      expect(await counts()).toEqual([before]);
      expect(kick).not.toHaveBeenCalled();
      expect((await account.state(ACCOUNT)).sentLast24Hours).toBe(0);

      creditless = false;
      expect(await outcome(messages.send(ACCOUNT, simple('orders@shop.example.tn', ['buyer@shop.example.tn'])))).toBe('taken');
    });

    it("when FF has no server of customers' mail: nothing is queued", async () => {
      const without = new ConfigService({ email: { ...config.getOrThrow('email'), server: null }, ses: config.getOrThrow('ses') });
      const nowhere = new EmailMessagesService(db.dataSource.getRepository(EmailMessage), identities, suppressions, account, plans, { kick } as unknown as EmailSender, credit, without);

      expect(await outcome(nowhere.send(ACCOUNT, simple('orders@shop.example.tn', ['ana@elsewhere.tn'])))).toMatch(/^unavailable: Sending is paused: FF has no server of customers' mail here/);
      expect(kick).not.toHaveBeenCalled();
    });
  });

  describe("the plan's quotas", () => {
    it('count each recipient against the day, a suppressed one too, under the account\'s lock: of sends at once, those within it alone are taken', async () => {
      shop.limits.emailsPerDay = 5;
      await suppressions.put(null, ACCOUNT, 'gone@shop.example.tn', SuppressionReason.BOUNCE);
      await messages.send(ACCOUNT, simple('orders@shop.example.tn', ['gone@shop.example.tn', 'ana@elsewhere.tn']));
      await aSecondAgo();

      const outcomes = await Promise.all(Array.from({ length: 4 }, (_, n) => outcome(messages.send(ACCOUNT, simple('orders@shop.example.tn', [`buyer${n}@shop.example.tn`])))));

      expect(outcomes.filter((one) => one === 'taken')).toHaveLength(3);
      expect(outcomes.filter((one) => one !== 'taken')).toEqual(['daily: Daily message quota exceeded.']);
      expect(await account.state(ACCOUNT)).toMatchObject({ max24HourSend: 5, sentLast24Hours: 5 });
      // The other account's day is its own.
      expect((await account.state(OTHER)).sentLast24Hours).toBe(0);
    });

    it("refuse a message past the plan's rate in the last second, and take it a second later", async () => {
      shop.limits.emailsPerSecond = 2;
      await messages.send(ACCOUNT, simple('orders@shop.example.tn', ['ana@elsewhere.tn', 'audit@shop.example.tn']));

      expect(await outcome(messages.send(ACCOUNT, simple('orders@shop.example.tn', ['ana@elsewhere.tn'])))).toBe('rate: Maximum sending rate exceeded.');
      await aSecondAgo();
      expect(await outcome(messages.send(ACCOUNT, simple('orders@shop.example.tn', ['ana@elsewhere.tn'])))).toBe('taken');
    });
  });

  it("keeps the suppression list's addresses off: a message to them alone is done at once, never handed over", async () => {
    await suppressions.put(null, ACCOUNT, 'gone@shop.example.tn', SuppressionReason.COMPLAINT);

    const id = await messages.send(ACCOUNT, simple('orders@shop.example.tn', ['Gone@Shop.Example.TN']));
    await sender.drain();

    const done = await row(id);
    expect([done.status, done.recipients, done.recipientCount, await rawOf(id), server.taken.length, kick.mock.calls.length]).toEqual([
      EmailMessageStatus.SENT,
      [{ address: 'gone@shop.example.tn', status: 'SUPPRESSED' }],
      1,
      null,
      0,
      0,
    ]);
  });

  describe("the server's answers", () => {
    it('a refusal for now: tried again 30 s later, then 2 minutes after the next, then taken', async () => {
      server.next = '451 4.3.0 Try again later';
      const id = await messages.send(ACCOUNT, simple('orders@shop.example.tn', ['ana@elsewhere.tn']));

      await sender.drain();

      let waiting = await row(id);
      const [{ wait }] = await query<Array<{ wait: number }>>('SELECT extract(epoch FROM next_attempt_at - now())::int AS wait FROM email_messages WHERE id = $1', [id]);
      expect([waiting.status, waiting.attempts, server.taken.length, wait]).toEqual([EmailMessageStatus.QUEUED, 1, 0, expect.any(Number)]);
      expect(wait).toBeGreaterThanOrEqual(28);
      expect(wait).toBeLessThanOrEqual(30);
      expect(waiting.lastError).toMatch(/451 4\.3\.0 Try again later/);
      // Not due yet: nothing.
      await sender.drain();
      expect(server.taken).toHaveLength(0);

      server.next = '451 4.3.0 Try again later';
      await query(`UPDATE email_messages SET next_attempt_at = now() WHERE id = $1`, [id]);
      await sender.drain();
      const [{ wait: again }] = await query<Array<{ wait: number }>>('SELECT extract(epoch FROM next_attempt_at - now())::int AS wait FROM email_messages WHERE id = $1', [id]);
      expect([(await row(id)).attempts, again >= 118 && again <= 120]).toEqual([2, true]);

      await query(`UPDATE email_messages SET next_attempt_at = now() WHERE id = $1`, [id]);
      await sender.drain();
      waiting = await row(id);
      expect([waiting.status, waiting.attempts, waiting.lastError, server.taken.length]).toEqual([EmailMessageStatus.SENT, 3, null, 1]);
    });

    it('a refusal for good: the message failed, each recipient with the server\'s words, its copy dropped', async () => {
      server.next = '554 5.7.1 Relay access denied';
      const id = await messages.send(ACCOUNT, simple('orders@shop.example.tn', ['ana@elsewhere.tn']));

      await sender.drain();

      const failed = await row(id);
      expect([failed.status, failed.recipients, await rawOf(id)]).toEqual([
        EmailMessageStatus.FAILED,
        [{ address: 'ana@elsewhere.tn', status: 'FAILED', diagnostic: '554 5.7.1 Relay access denied' }],
        null,
      ]);
    });

    it('a recipient refused at RCPT bounces for now, the others go', async () => {
      server.refuse.add('nobody@shop.example.tn');
      const id = await messages.send(ACCOUNT, simple('orders@shop.example.tn', ['nobody@shop.example.tn', 'ana@elsewhere.tn']));

      await sender.drain();

      expect(server.taken.map((one) => one.to)).toEqual([['ana@elsewhere.tn']]);
      const [nobody, ana] = (await row(id)).recipients;
      expect([nobody.status, nobody.permanent, ana.status]).toEqual(['BOUNCED', false, 'SENT']);
      expect(nobody.diagnostic).toMatch(/550 5\.1\.1/);
    });

    it("none of it taken for a day: failed, the customer reading no address of FF's", async () => {
      server.next = '421 4.4.2 Timeout';
      const id = await messages.send(ACCOUNT, simple('orders@shop.example.tn', ['ana@elsewhere.tn']));
      await query(`UPDATE email_messages SET created_at = now() - interval '25 hours' WHERE id = $1`, [id]);

      await sender.drain();

      const failed = await row(id);
      expect([failed.status, failed.recipients[0].diagnostic]).toEqual([EmailMessageStatus.FAILED, "FF's mail server took none of it for a day"]);
      expect(failed.lastError).toMatch(/421 4\.4\.2 Timeout/);
    });

    it('a message whose identity went before it did: failed, saying so', async () => {
      await proved(ACCOUNT, 'temp@elsewhere.tn');
      const id = await messages.send(ACCOUNT, simple('temp@elsewhere.tn', ['ana@elsewhere.tn']));
      await identities.remove({ accountId: ACCOUNT }, 'temp@elsewhere.tn');

      await sender.drain();

      expect((await row(id)).recipients[0]).toEqual({ address: 'ana@elsewhere.tn', status: 'FAILED', diagnostic: 'The identity temp@elsewhere.tn was deleted before the message went' });
      expect(server.taken).toHaveLength(0);
    });
  });

  it('is handed over once by two backends emptying the queue at once', async () => {
    const ids: string[] = [];
    for (let n = 0; n < 12; n++) ids.push(await messages.send(ACCOUNT, simple('orders@shop.example.tn', ['ana@elsewhere.tn'])));

    await Promise.all([sender.drain(), second.drain()]);

    expect(server.taken.map((one) => one.from).sort()).toEqual(ids.map((id) => `b-${id}@bounces.mail.shop.example.tn`).sort());
    expect(await query('SELECT status, attempts, count(*)::int AS n FROM email_messages GROUP BY status, attempts')).toEqual([{ status: 'SENT', attempts: 1, n: 12 }]);
  });

  it('is kicked at once once queued: a round hands it over without waiting for the next second', async () => {
    const kicked = new EmailMessagesService(db.dataSource.getRepository(EmailMessage), identities, suppressions, account, plans, sender, credit, config);

    const id = await kicked.send(ACCOUNT, simple('orders@shop.example.tn', ['ana@elsewhere.tn']));

    for (let n = 0; n < 30 && (await row(id)).status !== EmailMessageStatus.SENT; n++) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.taken.map((one) => one.from)).toEqual([`b-${id}@bounces.mail.shop.example.tn`]);
  });

  describe('what comes back', () => {
    it('a bounce for good puts the address on the suppression list, one for now doesn\'t, one for no message of FF\'s is dropped; each deleted from the server', async () => {
      const id = await messages.send(ACCOUNT, simple('orders@shop.example.tn', ['gone@shop.example.tn', 'full@shop.example.tn', 'ana@elsewhere.tn']));
      await sender.drain();
      agent.waiting.set(
        'r1',
        bounce(id, 'bounces.mail.shop.example.tn', [
          { address: 'Gone@Shop.Example.TN', status: '5.1.1', diagnostic: '550 5.1.1 <gone@shop.example.tn>: User unknown' },
          { address: 'full@shop.example.tn', status: '4.2.2', diagnostic: '452 4.2.2 Mailbox full' },
        ]),
      );
      agent.waiting.set('r2', bounce(randomUUID(), `bounces.${MAIL_HOST}`, [{ address: 'x@nowhere.tn', status: '5.1.1', diagnostic: '550 User unknown' }]));

      expect(await bounces.poll()).toBe(2);

      expect(agent.waiting.size).toBe(0);
      const [gone, full, ana] = (await row(id)).recipients;
      expect([gone.status, gone.permanent, full.status, full.permanent, ana.status]).toEqual(['BOUNCED', true, 'BOUNCED', false, 'SENT']);
      expect(gone.diagnostic).toMatch(/User unknown/);
      const listed = await suppressions.find(ACCOUNT, 'gone@shop.example.tn');
      expect([listed?.reason, listed?.messageId, listed?.feedback]).toEqual([SuppressionReason.BOUNCE, id, expect.stringMatching(/User unknown/)]);
      expect([await suppressions.find(ACCOUNT, 'full@shop.example.tn'), await suppressions.find(OTHER, 'gone@shop.example.tn')]).toEqual([null, null]);
      // The next message to it is kept off, and counted.
      await aSecondAgo();
      const next = await messages.send(ACCOUNT, simple('orders@shop.example.tn', ['gone@shop.example.tn']));
      expect((await row(next)).recipients).toEqual([{ address: 'gone@shop.example.tn', status: 'SUPPRESSED' }]);
    });

    it('a complaint: the recipient complained of, its address on the suppression list as SES puts it', async () => {
      const id = await messages.send(ACCOUNT, simple('orders@shop.example.tn', ['ana@elsewhere.tn']));
      await sender.drain();
      agent.waiting.set('c1', complaint(id, 'bounces.mail.shop.example.tn', 'ana@elsewhere.tn'));

      await bounces.poll();

      expect((await row(id)).recipients).toEqual([{ address: 'ana@elsewhere.tn', status: 'COMPLAINED', diagnostic: 'abuse' }]);
      expect(await suppressions.find(ACCOUNT, 'ana@elsewhere.tn')).toMatchObject({ reason: SuppressionReason.COMPLAINT, messageId: id, feedback: 'abuse' });
    });
  });

  describe("the account's rates, over its last 14 days", () => {
    /** A message of the account's, sent `daysAgo` days ago (and 2 s, out of the rate a second), to `sent` recipients delivered and `bounced` bounced for good. */
    const history = async (accountId: string, sent: number, bounced: number, daysAgo = 0) => {
      const recipients: MessageRecipient[] = [
        ...Array.from({ length: sent }, (_, n): MessageRecipient => ({ address: `r${n}@shop.example.tn`, status: 'SENT' })),
        ...Array.from({ length: bounced }, (_, n): MessageRecipient => ({ address: `b${n}@shop.example.tn`, status: 'BOUNCED', permanent: true })),
      ];
      await query(
        `INSERT INTO email_messages (id, account_id, identity, from_address, return_path, recipients, recipient_count, size_bytes, status, created_at)
         VALUES (gen_random_uuid(), $1, 'shop.example.tn', 'orders@shop.example.tn', 'b-x@bounces.mail.shop.example.tn', $2, $3, 100, 'SENT', now() - make_interval(days => $4, secs => 2))`,
        [accountId, JSON.stringify(recipients), recipients.length, daysAgo],
      );
    };

    it('past 5% of bounces, reviewed, the operator told and the audit log saying it; past 10%, stopped, and its mail refused; never back by itself', async () => {
      await history(ACCOUNT, 95, 4);
      expect(await bounces.review(ACCOUNT)).toBe('HEALTHY');

      await history(ACCOUNT, 0, 2);
      expect(await bounces.review(ACCOUNT)).toBe('PROBATION');
      expect((await account.state(ACCOUNT)).enforcementStatus).toBe('PROBATION');
      expect(sent.map((one) => [one.to, one.subject])).toEqual([['operator@ff.test', `FF: account ${ACCOUNT}'s mail, its sending reviewed`]]);
      expect(await query(`SELECT action, details->>'enforcementStatus' AS status FROM audit_log WHERE account_id = $1 AND action = 'email.sending.enforce'`, [ACCOUNT])).toEqual([
        { action: 'email.sending.enforce', status: 'PROBATION' },
      ]);
      // Taken still, while reviewed.
      expect(await outcome(messages.send(ACCOUNT, simple('orders@shop.example.tn', ['ana@elsewhere.tn'])))).toBe('taken');

      await history(ACCOUNT, 0, 6);
      expect(await bounces.review(ACCOUNT)).toBe('SHUTDOWN');
      expect(await outcome(messages.send(ACCOUNT, simple('orders@shop.example.tn', ['ana@elsewhere.tn'])))).toMatch(/^suspended: /);

      await query(`DELETE FROM email_messages WHERE account_id = $1`, [ACCOUNT]);
      expect(await bounces.review(ACCOUNT)).toBe('SHUTDOWN');
    });

    it('judges 100 recipients at least, of the last 14 days alone, each account its own', async () => {
      await history(OTHER, 40, 40);
      await history(ACCOUNT, 100, 100, 15);

      expect([await bounces.review(OTHER), await bounces.review(ACCOUNT)]).toEqual(['HEALTHY', 'HEALTHY']);
      expect(sent).toEqual([]);
    });
  });

  it("lists the account's latest messages first, never another's", async () => {
    const first = await messages.send(ACCOUNT, simple('orders@shop.example.tn', ['ana@elsewhere.tn']));
    await aSecondAgo();
    const latest = await messages.send(ACCOUNT, simple('orders@shop.example.tn', ['ana@elsewhere.tn']));
    await messages.send(OTHER, simple('orders@other.example.tn', ['team@other.example.tn']));

    expect((await messages.latest(ACCOUNT, 10)).map((one) => one.id)).toEqual([latest, first]);
    expect((await messages.latest(ACCOUNT, 1)).map((one) => one.id)).toEqual([latest]);
  });
});

/**
 * L2: notifications against a real PostgreSQL server, in a scratch database
 * dropped after, and a local HTTP server as the customer's receiver: the
 * signing secret and its rotation, a notification's deliveries, the test,
 * and the worker that sends them, signs them, tries them again and gives up,
 * never twice the same, never to a private address unless development allows.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { createHmac } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { Membership } from '../accounts/entities/membership.entity';
import { User } from '../accounts/entities/user.entity';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import type { Role } from '../auth/principal';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { Mail, MailService } from '../mail/mail.service';
import { DeliveryStatus, NotificationDelivery } from './entities/notification-delivery.entity';
import { LEASE_MS, NotificationWorker } from './notification-worker.service';
import { NotificationsService, PREVIOUS_SECRET_MS } from './notifications.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const MINUTE = 60_000;

run('notifications (L2)', () => {
  let db: ScratchDatabase;
  let notifications: NotificationsService;
  let worker: NotificationWorker;
  let server: Server;
  let receiver: string;
  let received: Array<{ path: string; headers: IncomingMessage['headers']; body: string }>;
  /** How the receiver answers each path; 204 by default. */
  let answers: Record<string, (res: ServerResponse) => void>;
  let allowPrivate: boolean;
  let smtp: boolean;
  const sent: Mail[] = [];
  let n = 0;

  const query = <T = unknown>(sql: string, parameters?: unknown[]) => db.dataSource.query<T>(sql, parameters);
  const user = (email: string, locale = 'en') => db.dataSource.getRepository(User).save({ oidcSub: `kc-${email}`, email, name: null, locale });
  async function account(members: Array<[User, Role]> = []): Promise<string> {
    const id = String(800000000000 + ++n);
    await db.dataSource.getRepository(Account).save({ id, name: `Notified ${n}`, planId: 'beta', status: AccountStatus.ACTIVE });
    for (const [member, role] of members) await db.dataSource.getRepository(Membership).save({ accountId: id, userId: member.id, role });
    return id;
  }
  const deliveriesOf = (accountId: string) => db.dataSource.getRepository(NotificationDelivery).find({ where: { accountId }, order: { createdAt: 'ASC', channel: 'ASC', target: 'ASC' } });
  const row = (id: string) => db.dataSource.getRepository(NotificationDelivery).findOneByOrFail({ id });
  /** A webhook notification to the receiver's path, due now. */
  const webhook = async (accountId: string, path: string) => (await notifications.notify({ accountId, kind: 'test', data: { path }, webhookUrls: [`${receiver}${path}`] }))[0];

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    const config = {
      getOrThrow: (key: string) =>
        key === 'notifications' ? { intervalSeconds: 3600, allowPrivate } : key === 'mail' ? { consoleUrl: 'https://console.ff.example' } : undefined,
    } as unknown as ConfigService;
    notifications = new NotificationsService(db.dataSource, new AuditService(db.dataSource.getRepository(AuditEntry)), config);
    const mail = Object.create(MailService.prototype) as MailService;
    Object.defineProperty(mail, 'sends', { get: () => smtp });
    Object.assign(mail, { send: (message: Mail) => Promise.resolve(sent.push(message) > 0) });
    worker = new NotificationWorker(db.dataSource, notifications, mail, config);
    worker.timeoutMs = 500;
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        received.push({ path: req.url ?? '', headers: req.headers, body });
        (answers[req.url ?? ''] ?? ((r: ServerResponse) => r.writeHead(204).end()))(res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    receiver = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve) && server.closeAllConnections());
    await db?.drop();
  });

  beforeEach(async () => {
    received = [];
    answers = {};
    allowPrivate = true;
    smtp = true;
    sent.length = 0;
    // Each test sends only its own: what an earlier one left pending is out of the way.
    await query(`UPDATE "notification_deliveries" SET "status" = 'failed' WHERE "status" = 'pending'`);
  });

  describe('the signing secret', () => {
    it('is made at its first need, once, and kept', async () => {
      const id = await account();
      const [first, again] = await Promise.all([notifications.secret(id), notifications.secret(id)]);

      expect(first.secret).toMatch(/^whsec_/);
      expect(again.secret).toBe(first.secret);
      expect((await notifications.secret(id)).secret).toBe(first.secret);
    });

    it('rotates: a new one, the previous one signing too for 24 hours, and an audit entry naming neither', async () => {
      const id = await account();
      const before = await notifications.secret(id);
      const now = new Date();

      const rotated = await notifications.rotate(id, now);

      expect(rotated).toMatchObject({ previousSecret: before.secret, previousExpiresAt: new Date(now.getTime() + PREVIOUS_SECRET_MS), createdAt: now });
      expect(rotated.secret).not.toBe(before.secret);
      expect(await notifications.signingSecrets(id, now)).toEqual([rotated.secret, before.secret]);
      expect(await notifications.signingSecrets(id, new Date(now.getTime() + PREVIOUS_SECRET_MS))).toEqual([rotated.secret]);
      const [entry] = await db.dataSource.getRepository(AuditEntry).find({ where: { accountId: id } });
      expect(entry).toMatchObject({ action: 'webhook_secret.rotate', resource: `account:${id}`, details: { previousCreatedAt: before.createdAt.toISOString() } });
      expect(JSON.stringify(entry)).not.toContain('whsec_');
    });
  });

  describe('a notification', () => {
    it("is an e-mail to each owner with an address, in their language, and a POST to each webhook, all with one ID", async () => {
      const english = await user('owner-en@ff.test');
      const french = await user('owner-fr@ff.test', 'fr-TN');
      const id = await account([
        [english, 'owner'],
        [french, 'owner'],
        [await user('viewer@ff.test'), 'viewer'],
      ]);

      const rows = await notifications.notify({
        accountId: id,
        kind: 'test',
        data: { message: 'hello' },
        email: (language) => ({ subject: `subject ${language}`, text: `text ${language}` }),
        webhookUrls: ['https://a.example.tn/hooks', 'https://b.example.tn/hooks'],
      });

      expect(new Set(rows.map((r) => r.notificationId)).size).toBe(1);
      expect((await deliveriesOf(id)).map(({ channel, target, payload, status, attempts }) => ({ channel, target, payload, status, attempts }))).toEqual([
        { channel: 'email', target: 'owner-en@ff.test', payload: { subject: 'subject en', text: 'text en' }, status: 'pending', attempts: 0 },
        { channel: 'email', target: 'owner-fr@ff.test', payload: { subject: 'subject fr', text: 'text fr' }, status: 'pending', attempts: 0 },
        { channel: 'webhook', target: 'https://a.example.tn/hooks', payload: { id: rows[0].notificationId, type: 'test', account: id, createdAt: expect.any(String), data: { message: 'hello' } }, status: 'pending', attempts: 0 },
        { channel: 'webhook', target: 'https://b.example.tn/hooks', payload: expect.objectContaining({ id: rows[0].notificationId }), status: 'pending', attempts: 0 },
      ]);
    });
  });

  describe('a test notification', () => {
    it('goes to a webhook and the owners, recorded in the audit log with the URL', async () => {
      const owner = await user('test-owner@ff.test', 'fr-TN');
      const id = await account([[owner, 'owner']]);

      const { notificationId, deliveries } = await notifications.test(id, { webhookUrl: 'https://hooks.example.tn/ff', email: true }, 'amira@ff.tn');

      expect(deliveries.map(({ channel, target, status, nextAttemptAt }) => ({ channel, target, status, due: nextAttemptAt instanceof Date }))).toEqual([
        { channel: 'email', target: 'test-owner@ff.test', status: 'pending', due: true },
        { channel: 'webhook', target: 'https://hooks.example.tn/ff', status: 'pending', due: true },
      ]);
      expect((await deliveriesOf(id))[0].payload).toEqual({
        subject: `Notification de test de FF : Notified ${n}`,
        text: expect.stringContaining('demandée par amira@ff.tn'),
      });
      expect((await db.dataSource.getRepository(AuditEntry).findOneByOrFail({ accountId: id, action: 'notification.test' })).details).toEqual({
        webhookUrl: 'https://hooks.example.tn/ff',
        email: true,
      });
      expect(notificationId).toBe(deliveries[0].notificationId);
    });

    it('refuses no destination, a URL that is not one, and an e-mail with no owner to send it to, writing nothing', async () => {
      const id = await account();

      await expect(notifications.test(id, {}, 'x')).rejects.toThrow(new BadRequestException('Name a webhookUrl, or ask for the e-mail with email: true, or both'));
      await expect(notifications.test(id, { webhookUrl: 'ftp://example.tn' }, 'x')).rejects.toThrow('webhookUrl must be an http or https URL');
      await expect(notifications.test(id, { email: true }, 'x')).rejects.toThrow("This account has no owner with an e-mail address to send the test to: development mode's account has none");
      expect([await deliveriesOf(id), await db.dataSource.getRepository(AuditEntry).countBy({ accountId: id })]).toEqual([[], 0]);
    });
  });

  describe('the worker', () => {
    it('POSTs a webhook signed with the account secret, FF-Event-Id its notification, and marks it delivered', async () => {
      const id = await account();
      const delivery = await webhook(id, '/ok');
      const { secret } = await notifications.secret(id);

      expect(await worker.tick()).toBe(1);

      expect(received).toHaveLength(1);
      const [{ headers, body }] = received;
      expect(JSON.parse(body)).toEqual({ id: delivery.notificationId, type: 'test', account: id, createdAt: delivery.createdAt.toISOString(), data: { path: '/ok' } });
      expect(headers).toMatchObject({ 'content-type': 'application/json', 'user-agent': 'FF-Webhooks/1', 'ff-event-id': delivery.notificationId, 'ff-event-type': 'test', 'ff-delivery-id': delivery.id });
      // As a receiver checks it: recomputed with its secret, over "<t>.<the body as received>".
      const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(headers['ff-signature'] as string) ?? [];
      expect(v1).toBe(createHmac('sha256', secret).update(`${t}.${body}`).digest('hex'));
      expect(Math.abs(Number(t) * 1000 - Date.now())).toBeLessThan(MINUTE);
      expect(await row(delivery.id)).toMatchObject({ status: 'delivered', attempts: 1, responseStatus: 204, lastError: null, deliveredAt: expect.any(Date) });
    });

    it('signs with the previous secret too, for a day after a rotation', async () => {
      const id = await account();
      const previous = (await notifications.secret(id)).secret;
      const { secret } = await notifications.rotate(id);
      await webhook(id, '/rotated');

      await worker.tick();

      const [{ headers, body }] = received;
      const [t] = /t=(\d+)/.exec(headers['ff-signature'] as string)!.slice(1);
      expect(headers['ff-signature']).toBe(`t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')},v1=${createHmac('sha256', previous).update(`${t}.${body}`).digest('hex')}`);
    });

    it('tries a failing webhook again 1, 2, 4, 8 and 16 minutes after, then gives it up: 6 attempts, each recorded', async () => {
      const id = await account();
      answers['/broken'] = (res) => res.writeHead(500).end('nope');
      const delivery = await webhook(id, '/broken');
      let now = new Date();
      const waits: number[] = [];

      for (let attempt = 1; attempt <= 6; attempt++) {
        expect(await worker.tick(now)).toBe(1);
        const after = await row(delivery.id);
        expect([after.attempts, after.lastError, after.responseStatus]).toEqual([attempt, 'HTTP 500', 500]);
        if (attempt < 6) {
          expect(after.status).toBe('pending');
          waits.push((after.nextAttemptAt.getTime() - now.getTime()) / MINUTE);
          expect(await worker.tick(new Date(after.nextAttemptAt.getTime() - 1000))).toBe(0); // not due yet
          now = after.nextAttemptAt;
        } else {
          expect(after.status).toBe('failed');
        }
      }
      expect(waits).toEqual([1, 2, 4, 8, 16]);
      expect(received).toHaveLength(6);
      expect(await worker.tick(new Date(now.getTime() + 60 * MINUTE))).toBe(0);
    });

    it("doesn't follow a redirect, and gives up on a webhook that doesn't answer in time", async () => {
      const id = await account();
      answers['/moved'] = (res) => res.writeHead(302, { location: `${receiver}/elsewhere` }).end();
      answers['/silent'] = () => undefined;
      const moved = await webhook(id, '/moved');
      const silent = await webhook(id, '/silent');

      expect(await worker.tick()).toBe(2);

      expect(received.map((r) => r.path).sort()).toEqual(['/moved', '/silent']);
      expect(await row(moved.id)).toMatchObject({ status: 'pending', lastError: "HTTP 302: redirects aren't followed", responseStatus: 302 });
      expect(await row(silent.id)).toMatchObject({ status: 'pending', lastError: 'timed out after 0.5 s', responseStatus: null });
    });

    it('never sends a webhook to a private address unless development allows it, and says why', async () => {
      allowPrivate = false;
      const id = await account();
      const delivery = await webhook(id, '/private');

      await worker.tick();

      expect(received).toEqual([]);
      expect(await row(delivery.id)).toMatchObject({ status: 'pending', attempts: 1, lastError: '127.0.0.1 is 127.0.0.1, a private or reserved address: webhooks only go to the internet' });
    });

    it('sends the e-mails, and gives one up at once when no SMTP server is set, saying so', async () => {
      const owner = await user('mailed@ff.test');
      const id = await account([[owner, 'owner']]);
      const mail = { email: () => ({ subject: 'Hello', text: 'A notification' }) };
      const [delivered] = await notifications.notify({ accountId: id, kind: 'test', data: {}, ...mail });

      await worker.tick();
      smtp = false;
      const [logged] = await notifications.notify({ accountId: id, kind: 'test', data: {}, ...mail });
      await worker.tick();

      expect(sent).toEqual([{ to: 'mailed@ff.test', subject: 'Hello', text: 'A notification' }]);
      expect(await row(delivered.id)).toMatchObject({ status: 'delivered', attempts: 1 });
      expect(await row(logged.id)).toMatchObject({ status: 'failed', attempts: 1, lastError: 'FF_SMTP_URL is not set: the e-mail was written to the backend log instead' });
    });

    it('sends each delivery once when two backends work at once, ten at a time each', async () => {
      const id = await account();
      answers['/slow'] = (res) => setTimeout(() => res.writeHead(200).end(), 100);
      const rows = [];
      for (let i = 0; i < 12; i++) rows.push(await webhook(id, '/slow'));
      const other = new NotificationWorker(db.dataSource, notifications, Object.create(MailService.prototype) as MailService, {
        getOrThrow: () => ({ intervalSeconds: 3600, allowPrivate: true }),
      } as unknown as ConfigService);

      const [mine, theirs] = await Promise.all([worker.tick(), other.tick()]);

      expect([mine + theirs, Math.max(mine, theirs)]).toEqual([12, 10]);
      expect(received.map((r) => r.headers['ff-delivery-id']).sort()).toEqual(rows.map((r) => r.id).sort());
      expect((await deliveriesOf(id)).every((d) => d.status === DeliveryStatus.DELIVERED && d.attempts === 1)).toBe(true);
    });

    it("leaves a delivery another backend holds until its lease ends, then takes it again", async () => {
      const id = await account();
      const delivery = await webhook(id, '/held');
      const now = new Date();
      // As a backend that took it, then stopped before saying how it went.
      await query(`UPDATE "notification_deliveries" SET "attempts" = 1, "next_attempt_at" = $2 WHERE "id" = $1`, [delivery.id, new Date(now.getTime() + LEASE_MS)]);

      expect(await worker.tick(now)).toBe(0);
      expect(await worker.tick(new Date(now.getTime() + LEASE_MS))).toBe(1);

      expect(await row(delivery.id)).toMatchObject({ status: 'delivered', attempts: 2 });
    });
  });

  describe('the deliveries', () => {
    it("lists an account's own, newest first, as many as asked", async () => {
      const id = await account();
      const other = await account();
      await webhook(other, '/other');
      const first = await webhook(id, '/first');
      const second = await webhook(id, '/second');

      expect((await notifications.deliveries(id)).map((d) => d.id)).toEqual([second.id, first.id]);
      expect((await notifications.deliveries(id, 1)).map((d) => d.id)).toEqual([second.id]);
    });
  });
});

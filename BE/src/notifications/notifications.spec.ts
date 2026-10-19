/**
 * L1: what a webhook may reach, how it is signed and when it is tried again,
 * the request itself against a local HTTP server, and the test notification's
 * e-mail. The queue and the worker run against PostgreSQL in
 * notifications.db.spec.ts.
 */
import { createServer, IncomingMessage, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { testMail } from './notification-mail';
import { MAX_ATTEMPTS, nextAttempt } from './retry';
import { newSecret, signatureHeader } from './signature';
import { postWebhook } from './webhook-client';
import { blockedAddress, resolveWebhook, webhookUrlProblem } from './webhook-target';

describe('what a webhook may reach', () => {
  it("never FF's own network or machine: private, loopback, link-local, shared and reserved addresses, in IPv4 and IPv6", () => {
    const blocked = ['10.0.0.5', '172.16.3.4', '172.31.255.255', '192.168.1.10', '127.0.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1'];
    const blocked6 = ['::1', '::', 'fd00::1', 'fc00::1', 'fe80::1', 'ff02::1', '64:ff9b::a00:1', '2001:db8::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', '::ffff:a00:1', '::ffff:7f00:1'];
    expect([...blocked, ...blocked6].filter((address) => !blockedAddress(address))).toEqual([]);
  });

  it('the internet: public addresses, IPv4, IPv6, and IPv4 written as IPv6', () => {
    const open = ['8.8.8.8', '41.226.22.10', '172.32.0.1', '192.169.0.1', '100.128.0.1', '2001:4860:4860::8888', '2a00:1450::1', '::ffff:8.8.8.8'];
    expect(open.filter((address) => blockedAddress(address))).toEqual([]);
  });

  it("treats what isn't an address as blocked", () => {
    expect([blockedAddress('example.tn'), blockedAddress('')]).toEqual([true, true]);
  });

  it('takes an http or https URL with a host, without a user or password, of 2,048 characters at most', () => {
    expect([webhookUrlProblem('https://example.tn/ff-hooks'), webhookUrlProblem('http://hooks.example.tn:8080/a?b=c')]).toEqual([null, null]);
    expect([
      webhookUrlProblem('ftp://example.tn/hooks'),
      webhookUrlProblem('example.tn/hooks'),
      webhookUrlProblem('https://user:secret@example.tn/hooks'),
      webhookUrlProblem(`https://example.tn/${'a'.repeat(2048)}`),
    ]).toEqual([
      'webhookUrl must be an http or https URL',
      'webhookUrl must be a URL, such as https://example.tn/ff-hooks',
      "webhookUrl mustn't hold a user or a password: check the signature instead",
      'webhookUrl must be 2048 characters at most',
    ]);
  });

  it('goes to the address checked; refuses a host with any private address, unless development allows it; and says when a host has none', async () => {
    const lookup = (addresses: string[]) => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    const url = new URL('https://hooks.example.tn/ff');

    expect(await resolveWebhook(url, false, lookup(['41.226.22.10', '2a00:1450::1']))).toEqual({ address: '41.226.22.10', family: 4 });
    // One private address among public ones is enough: a later lookup could choose it.
    expect(await resolveWebhook(url, false, lookup(['41.226.22.10', '10.0.0.5']))).toEqual({
      problem: 'hooks.example.tn is 10.0.0.5, a private or reserved address: webhooks only go to the internet',
    });
    expect(await resolveWebhook(url, true, lookup(['127.0.0.1']))).toEqual({ address: '127.0.0.1', family: 4 });
    expect(await resolveWebhook(new URL('http://[::1]:8080/'), false, lookup([]))).toEqual({ problem: '::1 is ::1, a private or reserved address: webhooks only go to the internet' });
    expect(await resolveWebhook(new URL('http://169.254.169.254/latest'), false, lookup([]))).toMatchObject({ problem: expect.stringContaining('169.254.169.254') });
    const missing = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    expect(await resolveWebhook(url, false, () => Promise.reject(missing))).toEqual({ problem: 'hooks.example.tn could not be found (ENOTFOUND)' });
    expect(await resolveWebhook(url, false, lookup([]))).toEqual({ problem: 'hooks.example.tn has no address' });
  });
});

describe('the signature', () => {
  // Worked out apart, with Python's hmac: hmac.new(secret, f"{t}.{body}", sha256).
  const BODY = '{"id":"0b7c6f2e-5d1a-4c3b-9e8f-7a6b5c4d3e2f","type":"test"}';
  const AT = new Date('2026-10-19T15:37:50.900Z');

  it('is when it was signed, in Unix seconds, and the HMAC-SHA256 of "<t>.<body>" keyed with the secret as written', () => {
    expect(signatureHeader(['whsec_current'], BODY, AT)).toBe('t=1792424270,v1=c4ca8d280390fafa5a37b9c673aebcb63ec2d512a5af9e33990a535dbeaf8fca');
  });

  it('carries one v1 per secret: the current one first, and the previous one for a day after a rotation', () => {
    expect(signatureHeader(['whsec_current', 'whsec_previous'], BODY, AT)).toBe(
      't=1792424270,v1=c4ca8d280390fafa5a37b9c673aebcb63ec2d512a5af9e33990a535dbeaf8fca,v1=23fc8b694251527a4230a09489410699c004cbeb13ce68ff8a05301c152089cf',
    );
  });

  it('changes with a byte of the body', () => {
    expect(signatureHeader(['whsec_current'], BODY.replace('test', 'tesT'), AT)).not.toBe(signatureHeader(['whsec_current'], BODY, AT));
  });

  it('uses secrets of 32 random bytes, each new', () => {
    const [a, b] = [newSecret(), newSecret()];
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });
});

describe('the retries', () => {
  const NOW = new Date('2026-10-19T10:00:00Z');

  it('come 1, 2, 4, 8 and 16 minutes after each failed attempt, then none: 6 attempts in all', () => {
    expect([1, 2, 3, 4, 5].map((attempts) => (nextAttempt(attempts, NOW)!.getTime() - NOW.getTime()) / 60_000)).toEqual([1, 2, 4, 8, 16]);
    expect([MAX_ATTEMPTS, nextAttempt(6, NOW), nextAttempt(7, NOW)]).toEqual([6, null, null]);
  });
});

describe('a webhook request, against a local HTTP server', () => {
  let server: Server;
  let port: number;
  let received: Array<{ method?: string; url?: string; headers: IncomingMessage['headers']; body: string }>;
  let answer: (res: import('node:http').ServerResponse) => void;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        received.push({ method: req.method, url: req.url, headers: req.headers, body });
        answer(res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  // Open connections closed first: a request left hanging by a failing test mustn't keep the suite from ending.
  afterAll(() => new Promise((resolve) => server.close(resolve) && server.closeAllConnections()));
  beforeEach(() => {
    received = [];
    answer = (res) => res.writeHead(204).end();
  });

  const post = (path: string, timeoutMs = 2000) =>
    postWebhook({
      // A name with no address anywhere: the request still reaches the address given, the one that was checked.
      url: new URL(`http://hooks.example.invalid:${port}${path}`),
      address: '127.0.0.1',
      family: 4,
      headers: { 'content-type': 'application/json', 'ff-signature': 't=1,v1=ab' },
      body: '{"id":"n-1"}',
      timeoutMs,
    });

  it('POSTs the body with its headers to the address checked, for the host named, and answers the status', async () => {
    expect(await post('/ff-hooks?x=1')).toBe(204);

    expect(received).toEqual([
      {
        method: 'POST',
        url: '/ff-hooks?x=1',
        headers: expect.objectContaining({ host: `hooks.example.invalid:${port}`, 'content-type': 'application/json', 'ff-signature': 't=1,v1=ab', 'content-length': '12' }),
        body: '{"id":"n-1"}',
      },
    ]);
  });

  it("answers a failure's status, and a redirect's without following it", async () => {
    answer = (res) => res.writeHead(500).end('broken');
    expect(await post('/a')).toBe(500);
    answer = (res) => res.writeHead(302, { location: `http://127.0.0.1:${port}/elsewhere` }).end();
    expect(await post('/b')).toBe(302);
    expect(received.map((r) => r.url)).toEqual(['/a', '/b']);
  });

  it('gives up when nothing answers in time, and says so', async () => {
    answer = () => undefined; // never answers
    await expect(post('/slow', 200)).rejects.toThrow('timed out after 0.2 s');
  });

  it("says when the address can't be reached", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const unused = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    await expect(postWebhook({ url: new URL(`http://hooks.example.invalid:${unused}/`), address: '127.0.0.1', family: 4, headers: {}, body: '{}', timeoutMs: 2000 })).rejects.toThrow(
      'ECONNREFUSED',
    );
  });
});

describe("a test notification's e-mail", () => {
  const facts = { account: { id: '000000000042', name: 'Tunis Labs' }, requestedBy: 'amira@ff.tn', consoleUrl: 'https://console.ff.tn' };

  it('says what it is, for which account and who asked, in English and in French', () => {
    expect(testMail(facts, 'en')).toEqual({
      subject: 'A test notification from FF: Tunis Labs',
      text: [
        'This is a test notification for your account "Tunis Labs" (000000000042), asked for by amira@ff.tn.',
        "Your alarms' notifications will come the same way.",
        '',
        'The console: https://console.ff.tn',
      ].join('\n'),
    });
    expect(testMail(facts, 'fr')).toEqual({
      subject: 'Notification de test de FF : Tunis Labs',
      text: [
        'Ceci est une notification de test pour votre compte « Tunis Labs » (000000000042), demandée par amira@ff.tn.',
        'Les notifications de vos alarmes arriveront de la même façon.',
        '',
        'La console : https://console.ff.tn',
      ].join('\n'),
    });
  });
});

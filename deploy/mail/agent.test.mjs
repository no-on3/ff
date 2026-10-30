// The mail agent's unit tests, Node.js's own runner: the bounces waiting in the Maildir, oldest first, a page at a time,
// each deleted once the backend took it; the API, which answers the backend's token alone. L4 runs the agent with
// Postfix itself (hack/e2e.sh).
//   node --test deploy/mail/agent.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { MESSAGE, handler, take, waiting } from './agent.mjs';

const TOKEN = 'the-backends-token';
let dir;
/** A message Postfix delivered, its file's time `secondsAgo` in the past. */
const delivered = (name, text, secondsAgo) => {
  const file = join(dir, 'bounces', 'new', name);
  writeFileSync(file, text);
  const at = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(file, at, at);
};

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'ff-mail-agent-'));
  mkdirSync(join(dir, 'bounces', 'new'), { recursive: true });
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe('the bounces waiting', () => {
  it('are the Maildir\'s new messages, oldest first, a page at a time, each whole', () => {
    delivered('1730275300.V803I2M2.mail', 'From: MAILER-DAEMON\r\n\r\nsecond', 10);
    delivered('1730275200.V803I1M1.mail', 'From: MAILER-DAEMON\r\n\r\nfirst', 20);
    delivered('not a message', 'ignored', 30);

    const page = waiting(dir, 1);
    assert.deepEqual(page.map(({ id }) => id), ['1730275200.V803I1M1.mail']);
    assert.equal(Buffer.from(page[0].message, 'base64').toString(), 'From: MAILER-DAEMON\r\n\r\nfirst');
    assert.match(page[0].receivedAt, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual(waiting(dir, 10).map(({ id }) => id), ['1730275200.V803I1M1.mail', '1730275300.V803I2M2.mail']);
  });

  it('are deleted once taken, once; a name that is no message of Postfix\'s is none', () => {
    assert.equal(take(dir, '1730275200.V803I1M1.mail'), true);
    assert.equal(take(dir, '1730275200.V803I1M1.mail'), false);
    assert.equal(take(dir, '../../etc/passwd'), false);
    assert.equal(MESSAGE.test('1730275200.V803I1M1.mail'), true);
    assert.deepEqual(waiting(dir, 10).map(({ id }) => id), ['1730275300.V803I2M2.mail']);
  });

  it('are none when the Maildir is not there yet', () => {
    assert.deepEqual(waiting(join(dir, 'nowhere'), 10), []);
  });
});

describe("the backend's API", () => {
  const serve = handler({ dir, postfix: { running: true } }, createHash('sha256').update(TOKEN).digest('hex'), () => undefined);
  /** A request to the handler, as node's server would give it; the answer's status and body. */
  async function call(method, url, token = TOKEN) {
    const request = { method, url, headers: token ? { authorization: `Bearer ${token}` } : {} };
    let status = 0;
    let text = '';
    await serve(request, {
      writeHead: (code) => {
        status = code;
      },
      end: (body) => {
        text = body;
      },
    });
    return { status, body: text ? JSON.parse(text) : undefined };
  }

  it("answers the backend's token alone", async () => {
    assert.equal((await call('GET', '/health', 'another')).status, 401);
    assert.equal((await call('GET', '/health', '')).status, 401);
    assert.deepEqual(await call('GET', '/health'), { status: 200, body: { postfix: true, bounces: 1 } });
  });

  it('gives a page of the bounces, and deletes the one taken', async () => {
    const page = await call('GET', '/bounces?limit=5');
    assert.deepEqual(page.body.bounces.map(({ id }) => id), ['1730275300.V803I2M2.mail']);
    assert.equal((await call('GET', '/bounces?limit=1000')).status, 400);
    assert.equal((await call('DELETE', '/bounces/1730275300.V803I2M2.mail')).status, 204);
    assert.equal((await call('DELETE', '/bounces/1730275300.V803I2M2.mail')).status, 404);
    assert.equal((await call('GET', '/bounces/1730275300.V803I2M2.mail')).status, 405);
    assert.equal((await call('GET', '/elsewhere')).status, 404);
  });
});

#!/usr/bin/env node
// FF's agent on the server of customers' mail (ADR 0012): it keeps Postfix running, and gives the backend, over HTTPS
// with a token whose SHA-256 alone is here, what came back for the return-path domains, bounces.mail.<domain>: the
// bounces and the complaints, each a file of one Maildir, which the backend reads and then deletes. Node.js's standard
// library only.
//   FF_MAIL_AGENT_TOKEN_SHA256=<hex> node agent.mjs
// Its files, under FF_MAIL_DIR (/var/lib/ff-mail): tls/server.crt and tls/server.key, the server's certificate for its
// name, which Postfix and the agent both answer with; bounces/, the Maildir Postfix delivers every address of the
// return-path domains to.
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:https';
import { join } from 'node:path';

const SHA256 = /^[0-9a-f]{64}$/;
/** A message's file in the Maildir, as Postfix names it: the time, then a unique part and the host. */
export const MESSAGE = /^[0-9]+\.[A-Za-z0-9._-]+$/;
/** The most bounces one answer gives. */
export const MAX_PAGE = 100;

/** The messages waiting in the Maildir, oldest first, `limit` at most: each its file's name, when it came, and itself. */
export function waiting(dir, limit) {
  const folder = join(dir, 'bounces', 'new');
  let names;
  try {
    names = readdirSync(folder).filter((name) => MESSAGE.test(name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return names
    .map((name) => ({ name, at: statSync(join(folder, name)).mtimeMs }))
    .sort((a, b) => a.at - b.at || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ name, at }) => ({ id: name, receivedAt: new Date(at).toISOString(), message: readFileSync(join(folder, name)).toString('base64') }));
}

/** A message the backend took, deleted; false when it was gone already. */
export function take(dir, id) {
  if (!MESSAGE.test(id)) return false;
  try {
    unlinkSync(join(dir, 'bounces', 'new', id));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Postfix's master, in the foreground, started again a moment after it stops, unless the agent is stopping. */
export class Postfix {
  constructor(log = (line) => console.log(`ff-mail agent: ${line}`)) {
    this.log = log;
    this.child = null;
    this.stopping = false;
    this.restarts = 0;
  }

  get running() {
    return this.child !== null;
  }

  start() {
    if (this.stopping) return;
    const child = spawn('postfix', ['start-fg'], { stdio: ['ignore', 'inherit', 'inherit'] });
    const startedAt = Date.now();
    this.child = child;
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) return;
      // A master that ran a minute is started again at once; one that keeps stopping, less and less often.
      this.restarts = Date.now() - startedAt > 60_000 ? 0 : this.restarts + 1;
      const delay = Math.min(1000 * 2 ** Math.min(this.restarts, 5), 30_000);
      this.log(`postfix stopped (${signal ?? `exit ${code}`}); started again in ${delay / 1000} s`);
      setTimeout(() => this.start(), delay).unref();
    });
  }

  /** Stops the master, and waits for it: SIGTERM, then SIGKILL after 10 s. */
  async stop() {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
}

/** The backend's API: each request with the token, whose SHA-256 alone the agent has. */
export function handler({ dir, postfix }, tokenSha256, log = (line) => console.log(`ff-mail agent: ${line}`)) {
  const expected = Buffer.from(tokenSha256, 'hex');
  const authorized = (request) => {
    const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
    return token !== undefined && timingSafeEqual(createHash('sha256').update(token).digest(), expected);
  };
  const answer = (response, status, body) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    response.end(text);
  };
  return async (request, response) => {
    try {
      if (!authorized(request)) return answer(response, 401, { message: 'A bearer token, the backend’s' });
      const url = new URL(request.url, 'https://agent');
      if (url.pathname === '/health' && request.method === 'GET') return answer(response, 200, { postfix: postfix?.running ?? false, bounces: waiting(dir, Infinity).length });
      if (url.pathname === '/bounces' && request.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') ?? 20);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) return answer(response, 400, { message: `limit is 1 to ${MAX_PAGE}` });
        return answer(response, 200, { bounces: waiting(dir, limit) });
      }
      const id = /^\/bounces\/([^/]+)$/.exec(url.pathname)?.[1];
      if (!id) return answer(response, 404, { message: 'Not found' });
      if (request.method !== 'DELETE') return answer(response, 405, { message: 'DELETE' });
      return take(dir, decodeURIComponent(id)) ? answer(response, 204) : answer(response, 404, { message: `No bounce ${id}` });
    } catch (error) {
      log(`a request failed: ${error instanceof Error ? error.message : String(error)}`);
      return answer(response, 500, { message: 'The agent failed: see its log' });
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.env.FF_MAIL_DIR ?? '/var/lib/ff-mail';
  const tokenSha256 = process.env.FF_MAIL_AGENT_TOKEN_SHA256 ?? '';
  if (!SHA256.test(tokenSha256)) {
    console.error("FF_MAIL_AGENT_TOKEN_SHA256 is the SHA-256 of the backend's token, 64 hexadecimal digits");
    process.exit(2);
  }
  const postfix = new Postfix();
  postfix.start();
  const port = Number(process.env.FF_MAIL_AGENT_PORT ?? 6391);
  const tls = { cert: readFileSync(join(dir, 'tls', 'server.crt')), key: readFileSync(join(dir, 'tls', 'server.key')) };
  const server = createServer(tls, handler({ dir, postfix }, tokenSha256)).listen(port, () => console.log(`ff-mail agent: Postfix started, the API on port ${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      server.close();
      void postfix.stop().then(() => process.exit(0));
    });
  }
}

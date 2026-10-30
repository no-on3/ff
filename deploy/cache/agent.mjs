#!/usr/bin/env node
// FF's agent on the server of customers' caches (ADR 0013): a Valkey process for each cache, under a user of its own,
// with the plan's memory, nothing kept on disk, TLS only, and the customer's password kept as its SHA-256 alone. The
// backend tells it, over HTTPS with a token whose SHA-256 alone is here, what each cache is; it writes each one's
// settings and ACL file, starts its process and starts it again if it stops, turns the customer's user off and on,
// and reads each one's measures with a user of FF's own that never reads a key. Node.js's standard library only.
//   FF_CACHE_AGENT_TOKEN_SHA256=<hex> node agent.mjs
// Its files, under FF_CACHE_DIR (/var/lib/ff-cache): tls/server.crt and tls/server.key, the server's certificate for
// its name, which the caches and the agent both answer with; caches/<name>/, each cache's.
import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { join } from 'node:path';
import { connect } from 'node:tls';

/** A cache's name, as the backend gives it: opaque, its own folder's. */
export const NAME = /^[a-z][a-z0-9-]{2,39}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** The most memory a cache may have, in MB: a server's whole, as ElastiCache's largest nodes. */
export const MAX_MEMORY_MB = 65_536;

/**
 * What the customer's user may not run: what would change the server, write to its disk or reach another; DEBUG and
 * MODULE are off in the server's settings as well. ACL WHOAMI stays, as clients ask it.
 */
export const CUSTOMER_COMMANDS =
  '+@all -config -debug -module -acl +acl|whoami -save -bgsave -bgrewriteaof -shutdown -replicaof -slaveof -sync -psync -migrate -failover -cluster';
/** FF's own user: the cache's measures, and the customer's switch; never a key. */
export const AGENT_COMMANDS = 'resetkeys -@all +info +ping +client|kill +client|list +acl|setuser';

/** The cache's ACL file: the customer's user, on or off, by its password's SHA-256; and FF's. */
export function usersAcl(cache, agentSha256) {
  return [
    `user default ${cache.enabled ? 'on' : 'off'} #${cache.passwordSha256} ~* &* ${CUSTOMER_COMMANDS}`,
    `user ff-agent on #${agentSha256} ${AGENT_COMMANDS}`,
    '',
  ].join('\n');
}

/** The cache's settings: TLS only on its port, its memory evicting the least recently used keys, nothing on disk. */
export function valkeyConf(cache, dir, tlsDir) {
  return [
    'port 0',
    `tls-port ${cache.port}`,
    'bind 0.0.0.0',
    `tls-cert-file ${join(tlsDir, 'server.crt')}`,
    `tls-key-file ${join(tlsDir, 'server.key')}`,
    'tls-auth-clients no',
    `aclfile ${join(dir, 'users.acl')}`,
    `maxmemory ${cache.memoryMb}mb`,
    'maxmemory-policy allkeys-lru',
    'save ""',
    'appendonly no',
    `dir ${dir}`,
    'enable-debug-command no',
    'enable-module-command no',
    'enable-protected-configs no',
    `logfile ${join(dir, 'valkey.log')}`,
    '',
  ].join('\n');
}

/** Why a cache's description can't be taken, or null: its port in the agent's range, its memory, its password's hash. */
export function cacheProblem(body, ports) {
  if (typeof body !== 'object' || body === null) return 'The body is a JSON object: port, memoryMb, passwordSha256, enabled';
  if (!Number.isInteger(body.port) || body.port < ports.first || body.port > ports.last) return `port is a whole number from ${ports.first} to ${ports.last}`;
  if (!Number.isInteger(body.memoryMb) || body.memoryMb < 1 || body.memoryMb > MAX_MEMORY_MB) return `memoryMb is a whole number from 1 to ${MAX_MEMORY_MB}`;
  if (typeof body.passwordSha256 !== 'string' || !SHA256.test(body.passwordSha256)) return "passwordSha256 is the password's SHA-256, 64 hexadecimal digits";
  if (typeof body.enabled !== 'boolean') return 'enabled is true or false';
  return null;
}

/** The fields of an INFO answer, by name. */
export function infoFields(text) {
  const fields = {};
  for (const line of text.split('\r\n')) {
    const at = line.indexOf(':');
    if (at > 0 && !line.startsWith('#')) fields[line.slice(0, at)] = line.slice(at + 1);
  }
  return fields;
}

/**
 * A cache's measures, as ElastiCache names them, from its INFO: its memory, its connections, its hits, misses and
 * evictions. Its connections leave out the agent's own, which asked.
 */
export function measuresOf(fields) {
  const number = (name) => (fields[name] === undefined ? null : Number(fields[name]));
  const clients = number('connected_clients');
  return {
    bytesUsedForCache: number('used_memory'),
    currConnections: clients === null ? null : Math.max(clients - 1, 0),
    cacheHits: number('keyspace_hits'),
    cacheMisses: number('keyspace_misses'),
    evictions: number('evicted_keys'),
    uptimeSeconds: number('uptime_in_seconds'),
  };
}

/** A port range, "6400-6999". */
export function portRange(text) {
  const match = /^(\d+)-(\d+)$/.exec(text);
  const [first, last] = match ? [Number(match[1]), Number(match[2])] : [NaN, NaN];
  if (!(first >= 1024 && last <= 65_535 && first <= last)) throw new Error(`FF_CACHE_PORTS is a range of ports, such as 6400-6999, not "${text}"`);
  return { first, last };
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** One Valkey command over TLS to a cache of this server, as FF's user: its reply, or an error. */
function command(cache, password, args, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: cache.port, rejectUnauthorized: false });
    const timer = setTimeout(() => socket.destroy(new Error('the cache did not answer in time')), timeoutMs);
    const encode = (parts) => `*${parts.length}\r\n${parts.map((part) => `$${Buffer.byteLength(String(part))}\r\n${part}\r\n`).join('')}`;
    let buffer = Buffer.alloc(0);
    const replies = [];
    socket.once('secureConnect', () => socket.write(encode(['AUTH', 'ff-agent', password]) + encode(args)));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const reply = parse(buffer);
        if (!reply) break;
        buffer = buffer.subarray(reply[1]);
        replies.push(reply[0]);
      }
      if (replies.length === 2) {
        clearTimeout(timer);
        socket.end();
        const [auth, answer] = replies;
        if (auth instanceof Error) reject(auth);
        else if (answer instanceof Error) reject(answer);
        else resolve(answer);
      }
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** One reply of Valkey's protocol (RESP 2) from the buffer: [value, next position], or undefined while it isn't whole. */
export function parse(buffer, at = 0) {
  const end = buffer.indexOf('\r\n', at);
  if (end < 0) return undefined;
  const type = String.fromCharCode(buffer[at]);
  const text = buffer.toString('utf8', at + 1, end);
  if (type === '+') return [text, end + 2];
  if (type === '-') return [new Error(text), end + 2];
  if (type === ':') return [Number(text), end + 2];
  if (type === '$') {
    const length = Number(text);
    if (length < 0) return [null, end + 2];
    if (buffer.length < end + 2 + length + 2) return undefined;
    return [buffer.toString('utf8', end + 2, end + 2 + length), end + 2 + length + 2];
  }
  if (type === '*') {
    const items = [];
    let next = end + 2;
    for (let i = 0; i < Number(text); i++) {
      const item = parse(buffer, next);
      if (!item) return undefined;
      items.push(item[0]);
      next = item[1];
    }
    return [items, next];
  }
  throw new Error(`unexpected reply type ${type}`);
}

/** The agent: the caches it keeps, their processes, and the backend's API to them. */
export class Agent {
  constructor({ dir, ports, uidBase = 20_000, valkey = 'valkey-server', runAs = true, log = (line) => console.log(line) }) {
    this.dir = dir;
    this.tlsDir = join(dir, 'tls');
    this.ports = ports;
    this.uidBase = uidBase;
    this.valkey = valkey;
    // As root, each cache's process runs as its own user; otherwise (tests) as the agent's.
    this.runAs = runAs;
    this.log = log;
    /** FF's own user's password, made at each start: every process the agent starts has its SHA-256. */
    this.agentPassword = randomBytes(24).toString('base64url');
    /** By name: the cache's description and its process. */
    this.caches = new Map();
    this.stopping = false;
  }

  folder(name) {
    return join(this.dir, 'caches', name);
  }

  /** The caches kept on disk, each started again: an agent that starts finds them as it left them. */
  start() {
    mkdirSync(join(this.dir, 'caches'), { recursive: true, mode: 0o711 });
    // The certificate's key, readable by the caches' group alone, whose users are the caches'.
    if (this.runAs) {
      chownSync(this.tlsDir, 0, this.uidBase);
      chmodSync(this.tlsDir, 0o750);
      chownSync(join(this.tlsDir, 'server.key'), 0, this.uidBase);
      chmodSync(join(this.tlsDir, 'server.key'), 0o640);
    }
    for (const name of readdirSync(join(this.dir, 'caches'))) {
      const file = join(this.folder(name), 'cache.json');
      if (!NAME.test(name) || !existsSync(file)) continue;
      const cache = JSON.parse(readFileSync(file, 'utf8'));
      this.caches.set(name, { cache, process: null, restarts: 0 });
      this.write(name);
      this.run(name);
    }
  }

  /** The cache's files, its settings and its ACL file, owned by its user, its folder its alone. */
  write(name) {
    const entry = this.caches.get(name);
    const dir = this.folder(name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'cache.json'), JSON.stringify(entry.cache, null, 2) + '\n', { mode: 0o600 });
    writeFileSync(join(dir, 'valkey.conf'), valkeyConf(entry.cache, dir, this.tlsDir), { mode: 0o600 });
    writeFileSync(join(dir, 'users.acl'), usersAcl(entry.cache, sha256(this.agentPassword)), { mode: 0o600 });
    if (this.runAs) {
      for (const file of ['', 'valkey.conf', 'users.acl']) chownSync(join(dir, file), entry.cache.uid, this.uidBase);
      chmodSync(dir, 0o700);
    }
  }

  /** The cache's process, started again a moment after it stops, unless the cache is going. */
  run(name) {
    const entry = this.caches.get(name);
    if (!entry || entry.going || this.stopping) return;
    const conf = join(this.folder(name), 'valkey.conf');
    const [file, args] = this.runAs ? ['su-exec', [`${entry.cache.uid}:${this.uidBase}`, this.valkey, conf]] : [this.valkey, [conf]];
    const child = spawn(file, args, { stdio: ['ignore', 'ignore', 'inherit'] });
    entry.process = child;
    entry.startedAt = Date.now();
    child.once('exit', (code, signal) => {
      if (entry.process !== child) return;
      entry.process = null;
      if (entry.going || this.stopping) return;
      // A process that ran a minute is started again at once; one that keeps stopping, less and less often.
      entry.restarts = Date.now() - entry.startedAt > 60_000 ? 0 : entry.restarts + 1;
      const delay = Math.min(1000 * 2 ** Math.min(entry.restarts, 5), 30_000);
      this.log(`cache ${name} stopped (${signal ?? `exit ${code}`}); started again in ${delay / 1000} s`);
      setTimeout(() => this.run(name), delay).unref();
    });
  }

  /** Stops the cache's process, and waits for it: SIGTERM, then SIGKILL after 5 s. */
  async stop(name) {
    const entry = this.caches.get(name);
    const child = entry?.process;
    if (!child) return;
    entry.process = null;
    await new Promise((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  /** Until FF's user logs in to the cache, for 10 s at most: true once it answers. */
  async ready(name, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if ((await command(this.caches.get(name).cache, this.agentPassword, ['PING'], 1000)) === 'PONG') return true;
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  /** The smallest user ID no cache has. */
  freeUid() {
    const used = new Set([...this.caches.values()].map((entry) => entry.cache.uid));
    let uid = this.uidBase + 1;
    while (used.has(uid)) uid++;
    return uid;
  }

  /**
   * A cache made, or changed as the backend says: a new port or memory starts its process again, its keys gone, as
   * a node's change does; a new password or the customer's switch apply at once, the switch ending its connections.
   * [status, view].
   */
  async put(name, body) {
    const taken = [...this.caches.entries()].find(([other, entry]) => other !== name && entry.cache.port === body.port);
    if (taken) return [409, { message: `Port ${body.port} is cache ${taken[0]}'s` }];
    const entry = this.caches.get(name);
    if (!entry) {
      const cache = { name, port: body.port, memoryMb: body.memoryMb, passwordSha256: body.passwordSha256, enabled: body.enabled, uid: this.freeUid() };
      this.caches.set(name, { cache, process: null, restarts: 0 });
      this.write(name);
      this.run(name);
      const ready = await this.ready(name);
      this.log(`cache ${name} made on port ${cache.port}, ${cache.memoryMb} MB${ready ? '' : ', not answering yet'}`);
      return [201, await this.view(name)];
    }
    const before = entry.cache;
    entry.cache = { ...before, port: body.port, memoryMb: body.memoryMb, passwordSha256: body.passwordSha256, enabled: body.enabled };
    this.write(name);
    if (before.port !== body.port || before.memoryMb !== body.memoryMb) {
      await this.stop(name);
      this.run(name);
      await this.ready(name);
      this.log(`cache ${name} started again on port ${body.port}, ${body.memoryMb} MB`);
    } else if (entry.process) {
      if (before.passwordSha256 !== body.passwordSha256) await command(entry.cache, this.agentPassword, ['ACL', 'SETUSER', 'default', 'resetpass', `#${body.passwordSha256}`]);
      if (before.enabled !== body.enabled) {
        await command(entry.cache, this.agentPassword, ['ACL', 'SETUSER', 'default', body.enabled ? 'on' : 'off']);
        if (!body.enabled) await command(entry.cache, this.agentPassword, ['CLIENT', 'KILL', 'USER', 'default']);
      }
    }
    return [200, await this.view(name)];
  }

  /** The cache gone: its process stopped, its folder deleted. */
  async remove(name) {
    const entry = this.caches.get(name);
    if (!entry) return false;
    entry.going = true;
    await this.stop(name);
    rmSync(this.folder(name), { recursive: true, force: true });
    this.caches.delete(name);
    this.log(`cache ${name} deleted`);
    return true;
  }

  /** What the backend reads of a cache: its description, never its password's hash, and its measures now. */
  async view(name) {
    const { cache, process } = this.caches.get(name);
    let measures = null;
    if (process) {
      try {
        measures = measuresOf(infoFields(await command(cache, this.agentPassword, ['INFO'])));
      } catch {
        // starting, or stopped: no measure
      }
    }
    return { name, port: cache.port, memoryMb: cache.memoryMb, enabled: cache.enabled, running: measures !== null, measures };
  }

  async shutdown() {
    this.stopping = true;
    await Promise.all([...this.caches.keys()].map((name) => this.stop(name)));
  }
}

/** The backend's API: each request with the token, whose SHA-256 alone the agent has. */
export function handler(agent, tokenSha256) {
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
      const path = new URL(request.url, 'https://agent').pathname;
      if (path === '/health' && request.method === 'GET') return answer(response, 200, { caches: agent.caches.size });
      if (path === '/caches' && request.method === 'GET') return answer(response, 200, await Promise.all([...agent.caches.keys()].sort().map((name) => agent.view(name))));
      const name = /^\/caches\/([^/]+)$/.exec(path)?.[1];
      if (!name || !NAME.test(name)) return answer(response, 404, { message: 'Not found' });
      if (request.method === 'GET') return agent.caches.has(name) ? answer(response, 200, await agent.view(name)) : answer(response, 404, { message: `No cache ${name}` });
      if (request.method === 'DELETE') return (await agent.remove(name)) ? answer(response, 204) : answer(response, 404, { message: `No cache ${name}` });
      if (request.method !== 'PUT') return answer(response, 405, { message: 'GET, PUT or DELETE' });
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return answer(response, 400, { message: 'The body is JSON' });
      }
      const problem = cacheProblem(body, agent.ports);
      if (problem) return answer(response, 400, { message: problem });
      const [status, view] = await agent.put(name, body);
      return answer(response, status, view);
    } catch (error) {
      agent.log(`a request failed: ${error instanceof Error ? error.message : String(error)}`);
      return answer(response, 500, { message: 'The agent failed: see its log' });
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.env.FF_CACHE_DIR ?? '/var/lib/ff-cache';
  const tokenSha256 = process.env.FF_CACHE_AGENT_TOKEN_SHA256 ?? '';
  if (!SHA256.test(tokenSha256)) {
    console.error("FF_CACHE_AGENT_TOKEN_SHA256 is the SHA-256 of the backend's token, 64 hexadecimal digits");
    process.exit(2);
  }
  const agent = new Agent({ dir, ports: portRange(process.env.FF_CACHE_PORTS ?? '6400-6999'), runAs: process.getuid?.() === 0 });
  agent.start();
  const port = Number(process.env.FF_CACHE_AGENT_PORT ?? 6390);
  const tls = { cert: readFileSync(join(dir, 'tls', 'server.crt')), key: readFileSync(join(dir, 'tls', 'server.key')) };
  const server = createServer(tls, handler(agent, tokenSha256)).listen(port, () => console.log(`ff-cache agent: ${agent.caches.size} cache(s), the API on port ${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      server.close();
      void agent.shutdown().then(() => process.exit(0));
    });
  }
}

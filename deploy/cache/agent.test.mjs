// The cache agent's unit tests, Node.js's own runner: each cache's settings and ACL file as ADR 0013 decided them, what
// the backend's descriptions may be, and a cache's measures from its INFO. The image's test (hack/test-images.sh) runs
// the agent with Valkey itself.
//   node --test deploy/cache/agent.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { AGENT_COMMANDS, CUSTOMER_COMMANDS, cacheProblem, handler, infoFields, measuresOf, parse, portRange, usersAcl, valkeyConf } from './agent.mjs';

const CACHE = { name: 'fc-0123456789abcdef01234567', port: 6400, memoryMb: 64, passwordSha256: 'a'.repeat(64), enabled: true, uid: 20_001 };

describe("a cache's files", () => {
  it('lets the customer run all but what would change the server, write to its disk or reach another, and FF read its measures alone', () => {
    const acl = usersAcl(CACHE, 'b'.repeat(64)).split('\n');
    assert.equal(acl[0], `user default on #${'a'.repeat(64)} ~* &* ${CUSTOMER_COMMANDS}`);
    assert.equal(acl[1], `user ff-agent on #${'b'.repeat(64)} resetkeys -@all +info +ping +client|kill +client|list +acl|setuser`);
    for (const refused of ['-config', '-debug', '-module', '-acl', '-save', '-shutdown', '-replicaof', '-migrate', '-cluster']) assert.ok(CUSTOMER_COMMANDS.split(' ').includes(refused), refused);
    assert.ok(!AGENT_COMMANDS.includes('@read') && !AGENT_COMMANDS.includes('~'), "FF's user reaches no key");
    assert.match(usersAcl({ ...CACHE, enabled: false }, 'b'.repeat(64)), /^user default off #/);
  });

  it('serves TLS alone on its port, within its memory, evicting the least recently used keys, nothing on disk, its dangerous commands off', () => {
    const conf = valkeyConf(CACHE, '/var/lib/ff-cache/caches/fc-1', '/var/lib/ff-cache/tls').split('\n');
    for (const line of [
      'port 0',
      'tls-port 6400',
      'tls-cert-file /var/lib/ff-cache/tls/server.crt',
      'tls-key-file /var/lib/ff-cache/tls/server.key',
      'tls-auth-clients no',
      'aclfile /var/lib/ff-cache/caches/fc-1/users.acl',
      'maxmemory 64mb',
      'maxmemory-policy allkeys-lru',
      'save ""',
      'appendonly no',
      'enable-debug-command no',
      'enable-module-command no',
      'enable-protected-configs no',
    ]) {
      assert.ok(conf.includes(line), line);
    }
  });
});

describe("the backend's descriptions", () => {
  const ports = portRange('6400-6999');

  it('takes a port of its range, a memory, a SHA-256 and the switch', () => {
    assert.equal(cacheProblem({ port: 6400, memoryMb: 64, passwordSha256: 'a'.repeat(64), enabled: true }, ports), null);
    assert.deepEqual(
      [
        cacheProblem({ port: 6379, memoryMb: 64, passwordSha256: 'a'.repeat(64), enabled: true }, ports),
        cacheProblem({ port: 6400, memoryMb: 0, passwordSha256: 'a'.repeat(64), enabled: true }, ports),
        cacheProblem({ port: 6400, memoryMb: 64, passwordSha256: 'the password', enabled: true }, ports),
        cacheProblem({ port: 6400, memoryMb: 64, passwordSha256: 'a'.repeat(64) }, ports),
        cacheProblem(null, ports),
      ],
      [
        'port is a whole number from 6400 to 6999',
        'memoryMb is a whole number from 1 to 65536',
        "passwordSha256 is the password's SHA-256, 64 hexadecimal digits",
        'enabled is true or false',
        'The body is a JSON object: port, memoryMb, passwordSha256, enabled',
      ],
    );
    assert.throws(() => portRange('80-90'), /FF_CACHE_PORTS is a range of ports/);
  });

  it("refuses a request without the backend's token, which it knows by its SHA-256 alone", async () => {
    const answers = [];
    const respond = handler({ caches: new Map(), ports }, createHash('sha256').update('the token').digest('hex'));
    const call = (authorization) =>
      respond({ headers: { authorization }, url: '/health', method: 'GET' }, { writeHead: (status) => answers.push(status), end: () => undefined });
    await call(undefined);
    await call('Bearer another token');
    await call('Bearer the token');
    assert.deepEqual(answers, [401, 401, 200]);
  });
});

describe("a cache's measures", () => {
  it("reads INFO as ElastiCache names its metrics, the agent's own connection left out", () => {
    const info = '# Memory\r\nused_memory:1048576\r\nmaxmemory:67108864\r\n\r\n# Clients\r\nconnected_clients:3\r\n# Stats\r\nkeyspace_hits:10\r\nkeyspace_misses:2\r\nevicted_keys:7\r\n# Server\r\nuptime_in_seconds:60\r\n';
    assert.deepEqual(measuresOf(infoFields(info)), { bytesUsedForCache: 1_048_576, currConnections: 2, cacheHits: 10, cacheMisses: 2, evictions: 7, uptimeSeconds: 60 });
  });

  it("parses Valkey's replies, whole or not yet", () => {
    assert.deepEqual(parse(Buffer.from('+OK\r\n')), ['OK', 5]);
    assert.deepEqual(parse(Buffer.from('$5\r\nhello\r\n')), ['hello', 11]);
    assert.equal(parse(Buffer.from('$5\r\nhel')), undefined);
    assert.equal(parse(Buffer.from('-NOPERM no\r\n'))[0].message, 'NOPERM no');
    assert.deepEqual(parse(Buffer.from('*2\r\n:1\r\n$-1\r\n')), [[1, null], 13]);
  });
});

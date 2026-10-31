#!/usr/bin/env node
// The cache spike's checks from outside, as an app connects (resp.mjs, TLS and a password): what a customer's user may
// and may not run, another cache's password, the operator's switch turning the user off and on again. JSON lines.
//   HOST=127.0.0.1 CA=… CACHES='[{"port":…,"password":…}, …]' AGENT_PASSWORD=… node checks.mjs
import { open } from './resp.mjs';

const caches = JSON.parse(process.env.CACHES);
const { HOST, CA, AGENT_PASSWORD } = process.env;
const url = (cache, password = cache.password, user = 'default') => `rediss://${user}:${encodeURIComponent(password)}@${HOST}:${cache.port}`;
const line = (object) => console.log(JSON.stringify(object));
const check = (what, want, got) => line({ check: what, want, got: got instanceof Error ? got.message.split(' ')[0] : got });

const app = await open(url(caches[0]), CA);
check("the cache's password, over TLS", 'OK', app.auth);
check('SET then GET', 'v1', (await app.send('SET', 'k1', 'v1'), await app.send('GET', 'k1')));
check('a Lua script runs, as on ElastiCache', 2, await app.send('EVAL', 'return 1 + 1', '0'));
for (const [what, args] of [
  ['CONFIG GET, which would show and change the server', ['CONFIG', 'GET', 'maxmemory']],
  ['CONFIG SET dir, the old way to write files', ['CONFIG', 'SET', 'dir', '/tmp']],
  ['ACL SETUSER, a user giving itself more', ['ACL', 'SETUSER', 'default', '+@all']],
  ['SAVE, a snapshot on the server', ['SAVE']],
  ['REPLICAOF, which would reach out', ['REPLICAOF', '198.18.0.1', '6379']],
  ['MIGRATE, which would reach out', ['MIGRATE', '198.18.0.1', '6379', 'k1', '0', '1000']],
  ['SHUTDOWN', ['SHUTDOWN', 'NOSAVE']],
]) {
  check(`refused: ${what}`, 'NOPERM', await app.send(...args));
}
// The server's own switches (enable-debug-command, enable-module-command) refuse these two first, before the ACL does.
for (const [what, args] of [
  ['DEBUG', ['DEBUG', 'SLEEP', '0']],
  ['MODULE LOAD', ['MODULE', 'LOAD', '/tmp/x.so']],
]) {
  check(`refused by the server's own switch: ${what}`, 'ERR', await app.send(...args));
}
check('ACL WHOAMI, allowed', 'default', await app.send('ACL', 'WHOAMI'));
const wrong = await open(url(caches[0], 'not-the-password'), CA);
check('a wrong password', 'WRONGPASS', wrong.auth);
wrong.end();
const other = await open(url(caches[0], caches[1].password), CA);
check("another cache's password", 'WRONGPASS', other.auth);
other.end();

// The operator's switch, as a suspension: the customer's user off and its connections ended, then on again.
const agent = await open(url(caches[0], AGENT_PASSWORD, 'ff-agent'), CA);
check("the agent's own user", 'OK', agent.auth);
check('the agent turns the customer off', 'OK', await agent.send('ACL', 'SETUSER', 'default', 'off'));
check("and ends the customer's connections", 1, await agent.send('CLIENT', 'KILL', 'USER', 'default'));
const ended = await Promise.race([app.closed.then(() => 'closed'), new Promise((resolve) => setTimeout(() => resolve('still open'), 2000))]);
check("the app's connection, after", 'closed', ended);
const refused = await open(url(caches[0]), CA);
check('a new login while off', 'WRONGPASS', refused.auth);
refused.end();
check('the agent turns it on again', 'OK', await agent.send('ACL', 'SETUSER', 'default', 'on'));
const back = await open(url(caches[0]), CA);
check('the data are still there', 'v1', await back.send('GET', 'k1'));
check("the agent may not read the customer's keys", 'NOPERM', await agent.send('GET', 'k1'));
const info = await agent.send('INFO', 'memory');
check("the agent reads the cache's measures", 'yes', /used_memory:\d+/.test(info) ? 'yes' : 'no');
back.end();
agent.end();
process.exit(0);

// A minimal client of Valkey's protocol (RESP 2) over TLS, Node.js's standard library only, for the cache spike: an
// app's connection, as `rediss://user:password@host:port` gives it, checking the server's certificate against a CA.
import { readFileSync } from 'node:fs';
import { connect } from 'node:tls';

/** One reply from the buffer at `at`: [value, next position], or undefined while it isn't whole. */
function parse(buffer, at = 0) {
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

/** A connection from a URL; `closed` resolves when the server ends it. */
export async function open(url, caFile) {
  const { hostname, port, username, password } = new URL(url);
  const socket = connect({ host: hostname, port: Number(port), ca: readFileSync(caFile), servername: hostname === '127.0.0.1' ? undefined : hostname });
  await new Promise((resolve, reject) => socket.once('secureConnect', resolve).once('error', reject));
  let buffer = Buffer.alloc(0);
  const waiting = [];
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const reply = parse(buffer);
      if (!reply) break;
      buffer = buffer.subarray(reply[1]);
      waiting.shift()?.(reply[0]);
    }
  });
  // A command still waiting when the connection closes is refused: one listener for them all.
  const failing = [];
  const closed = new Promise((resolve) => socket.once('close', resolve));
  void closed.then(() => failing.splice(0).forEach((reject) => reject(new Error('connection closed'))));
  socket.on('error', () => undefined);
  const send = (...args) =>
    new Promise((resolve, reject) => {
      if (socket.destroyed) return reject(new Error('connection closed'));
      waiting.push((reply) => {
        failing.splice(failing.indexOf(reject), 1);
        resolve(reply);
      });
      failing.push(reject);
      socket.write(`*${args.length}\r\n${args.map((arg) => `$${Buffer.byteLength(String(arg))}\r\n${arg}\r\n`).join('')}`);
    });
  const auth = await send('AUTH', decodeURIComponent(username || 'default'), decodeURIComponent(password));
  return { send, closed, auth, end: () => socket.end() };
}

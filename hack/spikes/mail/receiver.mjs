#!/usr/bin/env node
// The spike's receiving mail server, Node.js's standard library only: SMTP on PORT, refusing at RCPT any address whose
// local part starts with bounce-me (550 5.1.1, as a mailbox that doesn't exist), keeping every message it takes,
// whole, in OUT, as received-<n>.eml beside its envelope in received-<n>.json.
//   PORT=2525 OUT=/out node receiver.mjs
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';

const { PORT, OUT } = process.env;
let received = 0;

createServer((socket) => {
  let buffer = '';
  let envelope = { from: '', to: [] };
  let data = null;
  const say = (line) => socket.write(`${line}\r\n`);
  say('220 receiver.spike.test ESMTP');
  socket.setEncoding('latin1');
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      if (data !== null) {
        const end = buffer.indexOf('\r\n.\r\n');
        if (end < 0) return;
        data += buffer.slice(0, end + 2);
        buffer = buffer.slice(end + 5);
        const message = data.replace(/^\.\./gm, '.');
        received++;
        writeFileSync(`${OUT}/received-${received}.eml`, message, 'latin1');
        writeFileSync(`${OUT}/received-${received}.json`, JSON.stringify(envelope));
        data = null;
        envelope = { from: '', to: [] };
        say(`250 2.0.0 Ok: queued as spike${received}`);
        continue;
      }
      const at = buffer.indexOf('\r\n');
      if (at < 0) return;
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const verb = line.slice(0, 4).toUpperCase();
      if (verb === 'EHLO') say('250-receiver.spike.test\r\n250-8BITMIME\r\n250 SMTPUTF8');
      else if (verb === 'HELO') say('250 receiver.spike.test');
      else if (verb === 'MAIL') {
        envelope.from = /<([^>]*)>/.exec(line)?.[1] ?? '';
        say('250 2.1.0 Ok');
      } else if (verb === 'RCPT') {
        const to = /<([^>]*)>/.exec(line)?.[1] ?? '';
        if (/^bounce-me/i.test(to)) say(`550 5.1.1 <${to}>: Recipient address rejected: User unknown in virtual mailbox table`);
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
      } else if (verb === 'QUIT') {
        say('221 2.0.0 Bye');
        socket.end();
        return;
      } else if (verb === 'NOOP') say('250 2.0.0 Ok');
      else say('502 5.5.2 Error: command not recognized');
    }
  });
  socket.on('error', () => undefined);
}).listen(Number(PORT), '0.0.0.0');

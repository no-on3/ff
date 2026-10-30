#!/usr/bin/env node
// The spike's sender: nodemailer, as the backend has it, signing each message with a domain's DKIM key, as the backend
// would sign a customer's, and handing it to the sending server with a return path that names the message (VERP), so
// that a bounce says which message it was. Prints a JSON line per message.
//   MODULES=<BE/node_modules> SMTP_PORT=… KEY_FILE=… node send.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(`${process.env.MODULES}/`);
const nodemailer = require('nodemailer');
const transport = nodemailer.createTransport({
  host: '127.0.0.1',
  port: Number(process.env.SMTP_PORT),
  secure: false,
  ignoreTLS: true,
  dkim: { domainName: 'shop.spike.test', keySelector: 'ff1', privateKey: readFileSync(process.env.KEY_FILE, 'utf8') },
});
for (const [id, to] of [
  ['m1', 'customer@example.test'],
  ['m2', 'bounce-me@example.test'],
]) {
  const started = Date.now();
  const info = await transport.sendMail({
    from: 'Boutique Ana <orders@shop.spike.test>',
    to,
    subject: 'Votre reçu n° 42',
    text: 'Merci pour votre commande : 42,500 DT.\n',
    html: '<p>Merci pour votre commande : <b>42,500 DT</b>.</p>',
    messageId: `<${id}@shop.spike.test>`,
    envelope: { from: `b-${id}@bounces.spike.test`, to },
  });
  console.log(JSON.stringify({ id, to, accepted: info.accepted, rejected: info.rejected, response: info.response, ms: Date.now() - started }));
}
transport.close();

#!/usr/bin/env node
// The spike's checks at the other end: each message the receiver kept, its DKIM signature verified against the
// domain's public key (given by a resolver of the spike's own, as DNS would give the TXT record FF tells the customer
// to publish), and the same message with its subject changed, which must fail; then the bounce Postfix sent back to
// the return path, read as a delivery status report. One JSON line each.
//   MODULES=<dir with mailauth> RECEIVED=<dir> PUBLIC_KEY=<base64 DER> BOUNCES=<mbox file> node verify.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(`${process.env.MODULES}/`);
const { dkimVerify } = require('mailauth/lib/dkim/verify');
const record = `v=DKIM1; k=rsa; p=${process.env.PUBLIC_KEY}`;
const resolver = async (name, type) => {
  if (type === 'TXT' && name === 'ff1._domainkey.shop.spike.test') return [[record]];
  const error = new Error(`no ${type} record for ${name}`);
  error.code = 'ENOTFOUND';
  throw error;
};
const line = (object) => console.log(JSON.stringify(object));

for (const file of readdirSync(process.env.RECEIVED).filter((name) => name.endsWith('.eml')).sort()) {
  const raw = readFileSync(`${process.env.RECEIVED}/${file}`);
  const envelope = JSON.parse(readFileSync(`${process.env.RECEIVED}/${file.replace(/\.eml$/, '.json')}`, 'utf8'));
  const result = await dkimVerify(raw, { resolver });
  const first = result.results[0];
  line({ check: `${file}: its DKIM signature`, want: 'pass', got: first?.status?.result, domain: first?.signingDomain, selector: first?.selector, returnPath: envelope.from, to: envelope.to });
  const changed = Buffer.from(raw.toString('latin1').replace(/^Subject: .*$/m, 'Subject: changed on the way'), 'latin1');
  const tampered = await dkimVerify(changed, { resolver });
  line({ check: `${file}, its subject changed: its DKIM signature`, want: 'fail', got: tampered.results[0]?.status?.result });
}

const mailbox = readFileSync(process.env.BOUNCES, 'utf8');
const report = mailbox.split(/^From /m).find((message) => /report-type=delivery-status/.test(message)) ?? '';
// A field of the report, its folded lines joined, as RFC 5322 unfolds them.
const field = (name) => new RegExp(`^${name}: (.*(?:\\r?\\n[ \\t].*)*)$`, 'mi').exec(report)?.[1]?.replace(/\r?\n[ \t]+/g, ' ').trim();
line({ check: 'a bounce came back to the return path, as a delivery status report', want: 'yes', got: report ? 'yes' : 'no' });
line({ check: "its envelope's recipient names the message (VERP)", want: 'b-m2@bounces.spike.test', got: /^Delivered-To: (.*)$/m.exec(report)?.[1]?.trim() ?? /^X-Original-To: (.*)$/m.exec(report)?.[1]?.trim() });
line({ check: 'its final recipient', want: 'rfc822; bounce-me@example.test', got: field('Final-Recipient') });
line({ check: 'its action and status', want: 'failed 5.1.1', got: `${field('Action')} ${field('Status')}` });
line({ check: 'its remote server said why', want: 'yes', got: /User unknown/.test(field('Diagnostic-Code') ?? '') ? 'yes' : 'no', detail: field('Diagnostic-Code') });

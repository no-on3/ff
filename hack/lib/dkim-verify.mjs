#!/usr/bin/env node
// A message's DKIM signature, checked as a mailbox provider checks it, with mailauth: its key looked up through the
// test's DNS server, as the record the customer published. Prints the first signature's result, its domain and its
// selector, "pass shop.example.tn ff0a1b2c3d"; then the same for the message with its subject changed on the way.
//   MODULES=<directory with mailauth> DNS=127.0.0.1:<port> node dkim-verify.mjs <message.eml>
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Resolver } from 'node:dns/promises';

const require = createRequire(`${process.env.MODULES}/`);
const { dkimVerify } = require('mailauth/lib/dkim/verify');
const dns = new Resolver({ timeout: 2000, tries: 2 });
dns.setServers([process.env.DNS]);
const resolver = (name, type) => dns.resolve(name, type);

const raw = readFileSync(process.argv[2]);
const changed = Buffer.from(raw.toString('latin1').replace(/^Subject: .*$/m, 'Subject: changed on the way'), 'latin1');
for (const message of [raw, changed]) {
  const [first] = (await dkimVerify(message, { resolver })).results;
  console.log(`${first?.status?.result ?? 'none'} ${first?.signingDomain ?? '-'} ${first?.selector ?? '-'}`);
}

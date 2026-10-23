#!/usr/bin/env node
// A PostgreSQL SCRAM-SHA-256 verifier for a password, as the backend will compute it (the step-2 plan's D4):
// the server is sent the verifier, never the password, so the password reaches no log.
//   node scram-verifier.mjs <password>   → SCRAM-SHA-256$4096:<salt>$<StoredKey>:<ServerKey>
// The password must be ASCII: SASLprep, which PostgreSQL applies first, leaves ASCII as it is.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

const password = process.argv[2];
if (!password || !/^[\x21-\x7e]+$/.test(password)) {
  console.error('usage: scram-verifier.mjs <password of printable ASCII>');
  process.exit(2);
}
const iterations = 4096;
const salt = randomBytes(16);
const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
const clientKey = createHmac('sha256', salted).update('Client Key').digest();
const storedKey = createHash('sha256').update(clientKey).digest();
const serverKey = createHmac('sha256', salted).update('Server Key').digest();
console.log(`SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`);

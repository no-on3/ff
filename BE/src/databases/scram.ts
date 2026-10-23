import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

/** PostgreSQL's own iterations for SCRAM-SHA-256 (scram_iterations' default). */
export const SCRAM_ITERATIONS = 4096;

/**
 * The SCRAM-SHA-256 verifier of a password, as PostgreSQL stores one: the backend sends the server this, never the
 * password, so the password reaches no log of the server's (ADR 0008). The password must be ASCII, which SASLprep,
 * the normalization PostgreSQL applies first, leaves as it is; FF's are base64url.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = SCRAM_ITERATIONS): string {
  if (!/^[\x21-\x7e]+$/.test(password)) throw new Error('A database password must be printable ASCII');
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** `ffk_<key ID>_<secret>`: 12 lowercase hex characters, then 32 random bytes in base64url (ADR 0004). */
export const API_KEY = /^ffk_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

/** What a key may do (D3). A user's token may do all that its role allows. */
export const SCOPES = [
  'functions:read',
  'functions:write',
  'functions:invoke',
  'logs:read',
  'metrics:read',
  'alarms:read',
  'alarms:write',
  'usage:read',
  'databases:read',
  'databases:write',
  'storage:read',
  'storage:write',
] as const;
export type Scope = (typeof SCOPES)[number];

/** A new key. The whole key is shown once; only the secret's hash is kept. */
export function newApiKey(): { id: string; secret: string; key: string } {
  const id = randomBytes(6).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  return { id, secret, key: `ffk_${id}_${secret}` };
}

export function parseApiKey(value: string): { id: string; secret: string } | undefined {
  const match = API_KEY.exec(value);
  return match ? { id: match[1], secret: match[2] } : undefined;
}

/** SHA-256 is enough: a 256-bit random secret can't be guessed, so a slow hash would only cost CPU (ADR 0004). */
export function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

/** In constant time, so the answer's timing says nothing about how much of a guess matched. */
export function secretMatches(secret: string, stored: Buffer): boolean {
  const hash = hashSecret(secret);
  return hash.length === stored.length && timingSafeEqual(hash, stored);
}

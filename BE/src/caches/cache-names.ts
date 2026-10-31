import { createHash, randomBytes } from 'node:crypto';

/**
 * A cache's name in its account, as ElastiCache names its clusters: 1 to 40 lower-case letters, digits and hyphens, a
 * letter first, no two hyphens in a row, no hyphen last.
 */
export const CACHE_NAME = /^[a-z](?:[a-z0-9]|-(?!-)){0,39}$/;

/** Why a name can't be a cache's, or undefined when it can. */
export function cacheNameProblem(name: string): string | undefined {
  if (CACHE_NAME.test(name) && !name.endsWith('-')) return undefined;
  return `"${name.length > 40 ? `${name.slice(0, 40)}…` : name}" is not a cache name: 1 to 40 lower-case letters, digits and hyphens, a letter first, no two hyphens in a row and none last, as AWS ElastiCache names its clusters`;
}

/** A cache's name on its server: fc- and 24 random hexadecimal characters, which say nothing of whose it is. */
export const SERVER_NAME = /^fc-[0-9a-f]{24}$/;

export function newServerName(): string {
  return `fc-${randomBytes(12).toString('hex')}`;
}

/** A cache's password: 32 random bytes, in base64url, which needs no escaping in its address. */
export function newPassword(): string {
  return randomBytes(32).toString('base64url');
}

/** What the server keeps of a password: its SHA-256, as Valkey's ACL files take it. */
export function passwordSha256(password: string): string {
  return createHash('sha256').update(password).digest('hex');
}

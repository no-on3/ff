import { randomBytes } from 'node:crypto';

/**
 * A database's name in its account, as RDS names its instances: 1 to 63 lower-case letters, digits and hyphens, a
 * letter first, no two hyphens in a row, no hyphen last.
 */
export const DATABASE_NAME = /^[a-z](?:[a-z0-9]|-(?!-)){0,62}$/;

/** Why a name can't be a database's, or undefined when it can. */
export function databaseNameProblem(name: string): string | undefined {
  if (DATABASE_NAME.test(name) && !name.endsWith('-')) return undefined;
  return `"${name.length > 63 ? `${name.slice(0, 63)}…` : name}" is not a database name: 1 to 63 lower-case letters, digits and hyphens, a letter first, no two hyphens in a row and none last, as AWS RDS names its databases`;
}

/** A database's and its user's name on the server: ff_ and 24 random hexadecimal characters, which say nothing of whose it is. */
export const SERVER_NAME = /^ff_[0-9a-f]{24}$/;

export function newServerName(): string {
  return `ff_${randomBytes(12).toString('hex')}`;
}

/** A database's password: 32 random bytes, in base64url, which needs no escaping in a connection string. */
export function newPassword(): string {
  return randomBytes(32).toString('base64url');
}

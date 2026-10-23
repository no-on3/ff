import { randomBytes } from 'node:crypto';

/**
 * A bucket's name, as AWS names general purpose buckets, without dots, so that
 * its virtual-hosted host keeps the wildcard certificate: 3 to 63 lower-case
 * letters, digits and hyphens, a letter or a digit first and last.
 */
export const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** The prefixes and suffixes AWS keeps for itself, which no bucket of AWS's may have, and so no bucket of FF's: it must move to S3. */
const RESERVED_PREFIXES = ['xn--', 'sthree-', 'amzn-s3-demo-'];
const RESERVED_SUFFIXES = ['-s3alias', '--ol-s3', '--x-s3', '--table-s3'];

/** Why a name can't be a bucket's, or undefined when it can. */
export function bucketNameProblem(name: string): string | undefined {
  const shown = JSON.stringify(name.length > 63 ? `${name.slice(0, 63)}…` : name);
  if (!BUCKET_NAME.test(name)) {
    return `${shown} is not a bucket name: 3 to 63 lower-case letters, digits and hyphens, a letter or a digit first and last, as AWS names buckets (without dots on FF)`;
  }
  const reserved = RESERVED_PREFIXES.find((prefix) => name.startsWith(prefix)) ?? RESERVED_SUFFIXES.find((suffix) => name.endsWith(suffix));
  return reserved ? `${shown} is not a bucket name: AWS keeps names with "${reserved}" for itself` : undefined;
}

/** A bucket's name in the store: ff- and 24 random hexadecimal characters, which say nothing of whose it is. */
export const STORE_NAME = /^ff-[0-9a-f]{24}$/;

export function newStoreName(): string {
  return `ff-${randomBytes(12).toString('hex')}`;
}

/** An access key ID, as AWS's are 20 characters, AKIA and 16 of base32: FF's start AKFF. */
export const ACCESS_KEY_ID = /^AKFF[A-Z2-7]{16}$/;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function newAccessKeyId(): string {
  return `AKFF${[...randomBytes(16)].map((byte) => BASE32[byte & 31]).join('')}`;
}

/** A secret access key, as AWS's: 40 characters of base64, from 30 random bytes. */
export function newSecretAccessKey(): string {
  return randomBytes(30).toString('base64');
}

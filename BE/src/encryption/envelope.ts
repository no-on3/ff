import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { KEY_BYTES, KeyRing } from './key-ring';

/**
 * A value sealed by envelope encryption, as the database keeps it: the value
 * encrypted with a data key of its own, and that data key encrypted with one of
 * the platform's keys, which `kid` names. Every field but `v` and `kid` is base64.
 */
export interface Sealed {
  /** The format's version. */
  v: 1;
  /** The platform key that sealed the data key. */
  kid: string;
  /** The data key, sealed: its IV, ciphertext and tag, one after the other. */
  key: string;
  iv: string;
  data: string;
  tag: string;
}

/** A sealed value that doesn't open: an unknown key, the wrong context, or a changed byte. */
export class UnsealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsealError';
  }
}

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** What each encryption is bound to: its purpose and its context, so that neither opens in another place. */
const boundTo = (purpose: 'key' | 'data', context: string) => Buffer.from(`ff/v1/${purpose}/${context}`, 'utf8');

function encrypt(key: Buffer, plaintext: Buffer, aad: Buffer): { iv: Buffer; data: Buffer; tag: Buffer } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, data, tag: cipher.getAuthTag() };
}

function decrypt(key: Buffer, iv: Buffer, data: Buffer, tag: Buffer, aad: Buffer): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/**
 * Seals a value: a new random data key encrypts it with AES-256-GCM, and the
 * ring's current key encrypts that data key. Both are bound to `context`, such
 * as a function's ID, so that a sealed value copied to another context doesn't
 * open. Two seals of one value differ.
 */
export function seal(plaintext: Buffer, context: string, ring: KeyRing): Sealed {
  const dataKey = randomBytes(KEY_BYTES);
  const sealedKey = encrypt(ring.current.key, dataKey, boundTo('key', context));
  const sealedData = encrypt(dataKey, plaintext, boundTo('data', context));
  return {
    v: 1,
    kid: ring.current.id,
    key: Buffer.concat([sealedKey.iv, sealedKey.data, sealedKey.tag]).toString('base64'),
    iv: sealedData.iv.toString('base64'),
    data: sealedData.data.toString('base64'),
    tag: sealedData.tag.toString('base64'),
  };
}

/** Opens a sealed value, in the context it was sealed in. Throws UnsealError when it can't. */
export function open(sealed: Sealed, context: string, ring: KeyRing): Buffer {
  if (sealed?.v !== 1) throw new UnsealError(`Unknown sealed format ${JSON.stringify(sealed?.v)}`);
  const platformKey = ring.find(sealed.kid);
  if (!platformKey) throw new UnsealError(`The key "${sealed.kid}" that sealed it is not among the platform's keys`);
  try {
    const key = Buffer.from(sealed.key, 'base64');
    const dataKey = decrypt(
      platformKey.key,
      key.subarray(0, IV_BYTES),
      key.subarray(IV_BYTES, key.length - TAG_BYTES),
      key.subarray(key.length - TAG_BYTES),
      boundTo('key', context),
    );
    return decrypt(dataKey, Buffer.from(sealed.iv, 'base64'), Buffer.from(sealed.data, 'base64'), Buffer.from(sealed.tag, 'base64'), boundTo('data', context));
  } catch {
    // GCM's check failed: another context, another key with the same ID, or a byte changed. Which one, it can't say.
    throw new UnsealError(`It doesn't open with the key "${sealed.kid}" in this context: it was changed, or sealed elsewhere`);
  }
}

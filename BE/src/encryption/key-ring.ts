import { createHash } from 'node:crypto';

/** One of the platform's keys: 32 bytes for AES-256, and the ID that a value sealed with it names. */
export interface EncryptionKey {
  id: string;
  key: Buffer;
}

/** A key's ID, as a sealed value names it. */
export const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
export const KEY_BYTES = 32;

/**
 * The key development uses when no keys file is set. It is written in the
 * source, so it protects nothing: production refuses it.
 */
export const DEVELOPMENT_KEY: EncryptionKey = {
  id: 'development',
  key: createHash('sha256').update('FF development key: it protects nothing, and production refuses it').digest(),
};

/**
 * The platform's keys. The first seals new values; every one opens what it
 * sealed. To change keys, put the new one first, and remove the old one once
 * nothing sealed with it is left.
 */
export class KeyRing {
  constructor(readonly keys: readonly EncryptionKey[]) {
    if (keys.length === 0) throw new Error('A key ring needs at least one key');
  }

  /** The key new values are sealed with. */
  get current(): EncryptionKey {
    return this.keys[0];
  }

  find(id: string): EncryptionKey | undefined {
    return this.keys.find((key) => key.id === id);
  }

  /** Whether the development key, which protects nothing, is among the keys. */
  holdsDevelopmentKey(): boolean {
    return this.keys.some((key) => key.key.equals(DEVELOPMENT_KEY.key));
  }
}

/**
 * Reads a keys file: one key a line, `<id>:<32 bytes in base64>`, the first
 * sealing. Blank lines and lines starting with # are skipped. Each problem
 * names its line, never what is written there.
 */
export function parseKeyRing(text: string): { ring?: KeyRing; problems: string[] } {
  const keys: EncryptionKey[] = [];
  const problems: string[] = [];
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const where = `line ${index + 1}`;
    const separator = line.indexOf(':');
    if (separator === -1) {
      problems.push(`${where} must be <id>:<key>, the key 32 bytes in base64`);
      return;
    }
    const id = line.slice(0, separator);
    const encoded = line.slice(separator + 1).trim();
    if (!KEY_ID.test(id)) {
      problems.push(`${where}: the ID must be 1 to 64 letters, digits, dots, hyphens or underscores`);
      return;
    }
    const key = Buffer.from(encoded, 'base64');
    // Node's decoder skips what isn't base64: encoding the bytes again must give back what was written.
    if (key.length !== KEY_BYTES || key.toString('base64') !== encoded) {
      problems.push(`${where}: the key "${id}" must be ${KEY_BYTES} bytes in base64, such as \`openssl rand -base64 32\` writes`);
      return;
    }
    if (keys.some((other) => other.id === id)) {
      problems.push(`${where}: the ID "${id}" is already used by an earlier line`);
      return;
    }
    keys.push({ id, key });
  });
  if (keys.length === 0 && problems.length === 0) problems.push('it holds no key');
  return problems.length > 0 ? { problems } : { ring: new KeyRing(keys), problems };
}

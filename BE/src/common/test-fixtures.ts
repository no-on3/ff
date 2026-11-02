// Helpers for tests (not part of the build: tsconfig.build.json excludes test-fixtures.ts).
import { createHash, createHmac } from 'node:crypto';

/** SHA-256 and its HMAC, as AWS's signer (@smithy/signature-v4) takes them: from node's crypto. */
export class Sha256 {
  private readonly hash;
  constructor(secret?: string | Uint8Array) {
    this.hash = secret === undefined ? createHash('sha256') : createHmac('sha256', Buffer.from(secret));
  }
  update(data: string | Uint8Array): void {
    this.hash.update(data);
  }
  digest(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(this.hash.digest()));
  }
}

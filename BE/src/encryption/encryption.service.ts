import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Sealed, open, seal } from './envelope';
import { EncryptionKey, KeyRing } from './key-ring';

/**
 * Seals what FF keeps encrypted at rest, functions' environments first, with
 * the platform's keys (FF_ENCRYPTION_KEYS_FILE, read once at start).
 */
@Injectable()
export class EncryptionService {
  private readonly ring: KeyRing;

  constructor(config: ConfigService) {
    this.ring = new KeyRing(config.getOrThrow<EncryptionKey[]>('encryption.keys'));
  }

  /** A JSON value, sealed for `context`: it opens only there. */
  sealJson(value: unknown, context: string): Sealed {
    return seal(Buffer.from(JSON.stringify(value), 'utf8'), context, this.ring);
  }

  /** The JSON value sealed for `context`. Throws UnsealError when it doesn't open. */
  openJson<T>(sealed: Sealed, context: string): T {
    return JSON.parse(open(sealed, context, this.ring).toString('utf8')) as T;
  }
}

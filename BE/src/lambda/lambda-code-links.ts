import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EncryptionService } from '../encryption/encryption.service';
import { Sealed } from '../encryption/envelope';

/** How long a link to a function's code works, as Lambda's `Code.Location` does: 10 minutes. */
export const CODE_LINK_MS = 10 * 60 * 1000;

/** The path the front door answers a link at, unsigned: the token is the link's whole proof. */
export const CODE_LINK_PATH = /^\/code\/([A-Za-z0-9_-]+)$/;

/** Where a link's seal opens, and nowhere else: a function's sealed environment never passes for a link. */
const CONTEXT = 'lambda/code-link';

/** What a link names: an account's function, its $LATEST or one of its versions. */
export interface CodeLinkTarget {
  accountId: string;
  functionId: string;
  version?: number;
}

/**
 * Links to a function's code, as `GetFunction` gives them in `Code.Location`:
 * Lambda's are S3 links good for 10 minutes, and FF's are its endpoint's
 * `/code/{token}`, the token sealed with the platform's keys, so that any
 * backend opens it and none can forge one. The link names the function by its
 * ID: a function deleted since, or a version, answers that it is gone.
 */
@Injectable()
export class LambdaCodeLinks {
  private readonly base: string;

  constructor(
    private readonly encryption: EncryptionService,
    config: ConfigService,
  ) {
    this.base = config.getOrThrow<string>('lambda.base');
  }

  /** The link to the code that `target` names, good for 10 minutes from `now`. */
  linkFor(target: CodeLinkTarget, now = new Date()): string {
    const sealed = this.encryption.sealJson({ ...target, expiresAt: now.getTime() + CODE_LINK_MS }, CONTEXT);
    return `${this.base}/code/${Buffer.from(JSON.stringify(sealed), 'utf8').toString('base64url')}`;
  }

  /** What a link's token names; 'expired' once its 10 minutes are over; undefined for a token FF didn't make. */
  open(token: string, now = new Date()): CodeLinkTarget | 'expired' | undefined {
    let opened: CodeLinkTarget & { expiresAt: number };
    try {
      const sealed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Sealed;
      opened = this.encryption.openJson(sealed, CONTEXT);
    } catch {
      return undefined;
    }
    if (!(opened.expiresAt > now.getTime())) return 'expired';
    return { accountId: opened.accountId, functionId: opened.functionId, ...(opened.version !== undefined ? { version: opened.version } : {}) };
  }
}

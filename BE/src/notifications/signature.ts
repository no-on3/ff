import { createHmac, randomBytes } from 'node:crypto';

/** A new signing secret: "whsec_" and 32 random bytes, in base64url. */
export const newSecret = (): string => `whsec_${randomBytes(32).toString('base64url')}`;

/**
 * The FF-Signature header of a webhook: when it was signed, in Unix seconds,
 * and the hex HMAC-SHA256 of "<t>.<body>" with each secret given, keyed with
 * the secret as written. A receiver recomputes it with its secret, and checks
 * that t is recent.
 */
export function signatureHeader(secrets: string[], body: string, at: Date): string {
  const t = Math.floor(at.getTime() / 1000);
  return [`t=${t}`, ...secrets.map((secret) => `v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`)].join(',');
}

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';

export interface WebhookRequest {
  url: URL;
  /** The address the host was checked to have: the request goes there, and nowhere else. */
  address: string;
  family: 4 | 6;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

/**
 * POSTs a webhook, and answers its HTTP status once it starts, without
 * reading the body; a redirect is a status like any other, never followed.
 * Rejects when the address can't be reached, or nothing answers within the
 * timeout, with what went wrong.
 */
export function postWebhook({ url, address, family, headers, body, timeoutMs }: WebhookRequest): Promise<number> {
  // Every connection goes to the address checked, whatever a second lookup would say; TLS still checks the host's name.
  const pinned = ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) =>
    options?.all ? callback(null, [{ address, family }]) : callback(null, address, family)) as unknown as LookupFunction;
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(url, {
      method: 'POST',
      headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
      lookup: pinned,
      agent: false,
    });
    const timer = setTimeout(() => req.destroy(new Error(`timed out after ${timeoutMs / 1000} s`)), timeoutMs);
    req.on('response', (res) => {
      clearTimeout(timer);
      res.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end(body);
  });
}

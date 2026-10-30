// AWS Signature Version 4 for a request to the S3 store, its body unsigned, as the backend's StoreClient signs FF's
// own requests there; and a key encoded as S3 encodes a path. Node.js's standard library only.
import { createHash, createHmac } from 'node:crypto';

const hmac = (key, data) => createHmac('sha256', key).update(data, 'utf8').digest();
const sha256hex = (data) => createHash('sha256').update(data).digest('hex');

/** A key in a path: each segment encoded as S3 encodes it, its slashes kept. */
export const encodeKey = (key) =>
  key
    .split('/')
    .map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');

/** The headers to send: the given ones, with host, date, payload hash and the signature of the three. */
export function signed({ method, host, path, query = '', headers = {}, key, secret }) {
  const now = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const date = now.slice(0, 8);
  const all = { ...headers, host, 'x-amz-date': now, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' };
  const names = ['host', 'x-amz-content-sha256', 'x-amz-date'];
  const canonical = [method, path, query, names.map((name) => `${name}:${all[name]}\n`).join(''), names.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = `${date}/us-east-1/s3/aws4_request`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secret}`, date), 'us-east-1'), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(['AWS4-HMAC-SHA256', now, scope, sha256hex(canonical)].join('\n')).digest('hex');
  return { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${key}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

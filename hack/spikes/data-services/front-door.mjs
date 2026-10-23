#!/usr/bin/env node
// Step 2's spike, its buckets half (the step-2 plan's V-01, for ADR 0009): a minimal S3 front door. It checks each
// request's AWS Signature Version 4, in its Authorization header or as a presigned URL, with keys of its own; reads
// the SDKs' streaming uploads (aws-chunked, signed chunk by chunk or not, with a trailing checksum or not); keeps a
// key to its buckets; and streams the request to the store behind it under the store's own name for the bucket,
// signed with the store's own credentials, and its answer back, both ways without holding a body. Each request is
// logged as one JSON line: what the client sent (addressing, signature, payload, checksum), what it was counted as.
// Node.js 22 or later, its standard library only.
//   UPSTREAM=http://127.0.0.1:9003 KEYS_FILE=keys.json LOG=requests.jsonl PORT=55480 node front-door.mjs
// keys.json: {"keys": {"<access key ID>": {"secret": "…", "buckets": ["photos"]}}, "buckets": {"photos": "<store's>"}}
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer, request as upstreamRequest } from 'node:http';
import { Transform, pipeline } from 'node:stream';
import { crc32 } from 'node:zlib';

const PORT = Number(process.env.PORT ?? 55480);
const HOSTS = (process.env.LISTEN ?? '127.0.0.1,::1').split(',');
/** Virtual-hosted addresses are <bucket>.<DOMAIN>; anything else is path-style. */
const DOMAIN = process.env.DOMAIN ?? 's3.localhost';
const REGION = process.env.REGION ?? 'tn-tunis-1';
const UPSTREAM = new URL(process.env.UPSTREAM ?? 'http://127.0.0.1:9003');
const UPSTREAM_KEY = process.env.UPSTREAM_ACCESS_KEY ?? 'ffdevaccesskey';
const UPSTREAM_SECRET = process.env.UPSTREAM_SECRET_KEY ?? 'ffdevsecretkey-local-only';
const config = JSON.parse(readFileSync(process.env.KEYS_FILE ?? 'keys.json', 'utf8'));
const LOG = process.env.LOG;

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
const MAX_SKEW_MS = 15 * 60 * 1000;
/** What AWS bills as its two classes of request; DELETE and the abort of an upload are free. */
const counts = new Map();

class S3Error extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const denied = (message = 'Access Denied') => new S3Error(403, 'AccessDenied', message);
const mismatch = () =>
  new S3Error(403, 'SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided. Check your key and signing method.');

// ---------- Signature Version 4 ----------

const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const sha256hex = (data) => createHash('sha256').update(data).digest('hex');
function signingKey(secret, date, region) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), 's3'), 'aws4_request');
}

const UNRESERVED = /[A-Za-z0-9\-._~]/;
/** RFC 3986's encoding, as SigV4 wants it: every byte but the unreserved ones, upper-case hex; "/" kept in a path. */
function encode(text, keepSlash) {
  let out = '';
  for (const byte of Buffer.from(text, 'utf8')) {
    const char = String.fromCharCode(byte);
    out += UNRESERVED.test(char) || (keepSlash && char === '/') ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}
/** Decodes %XX escapes only ("+" stays "+", as SigV4 reads queries). */
function decode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
/** The path as S3 signs it: encoded once, each escape as the client meant it, nothing normalized. */
const canonicalUri = (rawPath) => rawPath.split('/').map((segment) => encode(decode(segment), false)).join('/') || '/';
function canonicalQuery(rawQuery, without) {
  if (!rawQuery) return '';
  return rawQuery
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const at = pair.indexOf('=');
      const name = decode(at < 0 ? pair : pair.slice(0, at));
      const value = decode(at < 0 ? '' : pair.slice(at + 1));
      return [encode(name, false), encode(value, false), name];
    })
    .filter(([, , name]) => name !== without)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}
/** A header's values as SigV4 joins them: each trimmed, inner spaces collapsed, joined by ",". */
function headerValue(rawHeaders, name) {
  const values = [];
  for (let i = 0; i < rawHeaders.length; i += 2) if (rawHeaders[i].toLowerCase() === name) values.push(rawHeaders[i + 1].trim().replace(/\s+/g, ' '));
  return values.length ? values.join(',') : undefined;
}

/** What a request's signature says, from its header or its query; null for an anonymous request. */
function credentialsOf(request, url) {
  const header = request.headers.authorization;
  if (header) {
    const match = /^AWS4-HMAC-SHA256\s+Credential=([^,]+),\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]{64})$/.exec(header.trim());
    if (!match) throw new S3Error(400, 'AuthorizationHeaderMalformed', 'The authorization header is malformed');
    const amzDate = request.headers['x-amz-date'];
    if (!amzDate) throw new S3Error(400, 'AuthorizationHeaderMalformed', 'x-amz-date is missing');
    return { kind: 'header', credential: match[1], signedHeaders: match[2].split(';'), signature: match[3], amzDate, payload: request.headers['x-amz-content-sha256'] };
  }
  const query = url.searchParams;
  if (query.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256') {
    const expires = Number(query.get('X-Amz-Expires'));
    return {
      kind: 'presigned',
      credential: query.get('X-Amz-Credential') ?? '',
      signedHeaders: (query.get('X-Amz-SignedHeaders') ?? '').split(';'),
      signature: query.get('X-Amz-Signature') ?? '',
      amzDate: query.get('X-Amz-Date') ?? '',
      expires,
      payload: 'UNSIGNED-PAYLOAD',
    };
  }
  if (query.get('X-Amz-Signature') || request.headers.authorization) throw denied('Only AWS Signature Version 4 is supported');
  return null;
}

/** Checks a request's signature: the key, its scope, its time, then the signature itself. Answers the key and what chunks need. */
function verify(request, url, rawPath, rawQuery) {
  const auth = credentialsOf(request, url);
  if (!auth) throw denied('Anonymous requests are not allowed');
  const [keyId, date, region, service, terminator] = auth.credential.split('/');
  const key = config.keys[keyId];
  if (!key) throw new S3Error(403, 'InvalidAccessKeyId', 'The AWS Access Key Id you provided does not exist in our records.');
  if (service !== 's3' || terminator !== 'aws4_request' || !/^\d{8}$/.test(date) || !auth.amzDate.startsWith(date)) {
    throw new S3Error(400, 'AuthorizationHeaderMalformed', 'The credential scope is malformed');
  }
  const signedAt = Date.parse(auth.amzDate.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
  if (Number.isNaN(signedAt)) throw new S3Error(400, 'AuthorizationHeaderMalformed', 'The date is malformed');
  if (auth.kind === 'header' && Math.abs(Date.now() - signedAt) > MAX_SKEW_MS) {
    throw new S3Error(403, 'RequestTimeTooSkewed', 'The difference between the request time and the current time is too large.');
  }
  if (auth.kind === 'presigned') {
    if (!(auth.expires >= 1 && auth.expires <= 604800)) throw new S3Error(400, 'AuthorizationQueryParametersError', 'X-Amz-Expires must be 1 to 604800');
    if (Date.now() > signedAt + auth.expires * 1000) throw denied('Request has expired');
  }
  if (!auth.signedHeaders.includes('host')) throw new S3Error(400, 'AuthorizationHeaderMalformed', 'host must be signed');
  const payload = auth.payload ?? (auth.kind === 'header' ? undefined : 'UNSIGNED-PAYLOAD');
  if (!payload) throw new S3Error(400, 'InvalidRequest', 'Missing required header for this request: x-amz-content-sha256');
  const headers = auth.signedHeaders.map((name) => `${name}:${headerValue(request.rawHeaders, name) ?? ''}\n`).join('');
  const scope = `${date}/${region}/s3/aws4_request`;
  const signingFor = signingKey(key.secret, date, region);
  // Some clients sign the path exactly as they sent it; the canonical form first, then that.
  for (const path of new Set([canonicalUri(rawPath), rawPath || '/'])) {
    const canonical = [request.method, path, canonicalQuery(rawQuery, auth.kind === 'presigned' ? 'X-Amz-Signature' : undefined), headers, auth.signedHeaders.join(';'), payload].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', auth.amzDate, scope, sha256hex(canonical)].join('\n');
    const expected = hmac(signingFor, stringToSign).toString('hex');
    if (expected.length === auth.signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(auth.signature))) {
      return { keyId, key, kind: auth.kind, payload, region, chain: { key: signingFor, scope, amzDate: auth.amzDate, previous: auth.signature } };
    }
  }
  throw mismatch();
}

// ---------- bodies ----------

/** CRC-32C (Castagnoli), table-driven: S3's crc32c checksum. */
const CRC32C = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function checksumOf(algorithm) {
  switch (algorithm) {
    case 'crc32': {
      let value = 0;
      return { update: (chunk) => (value = crc32(chunk, value)), digest: () => Buffer.from([value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]).toString('base64') };
    }
    case 'crc32c': {
      let value = 0xffffffff;
      return {
        update: (chunk) => {
          for (const byte of chunk) value = CRC32C[(value ^ byte) & 255] ^ (value >>> 8);
        },
        digest: () => {
          const final = (value ^ 0xffffffff) >>> 0;
          return Buffer.from([final >>> 24, (final >>> 16) & 255, (final >>> 8) & 255, final & 255]).toString('base64');
        },
      };
    }
    case 'sha1':
    case 'sha256': {
      const hash = createHash(algorithm);
      return { update: (chunk) => hash.update(chunk), digest: () => hash.digest('base64') };
    }
    default:
      return null;
  }
}

/**
 * Reads an aws-chunked body: "<hex size>[;chunk-signature=<sig>]\r\n<data>\r\n" … "0…\r\n", then trailers, each
 * signature checked in its chain from the request's; the data alone goes on, its length and checksum checked at the
 * end, before the stream ends: a body that fails never completes upstream.
 */
function chunkDecoder({ signed, chain, trailer, decodedLength, checksum }) {
  let buffer = Buffer.alloc(0);
  let state = 'size';
  let remaining = 0;
  let chunkSignature = '';
  let chunkHash = null;
  let previous = chain.previous;
  let total = 0;
  const trailers = {};
  const sum = checksum?.algorithm ? checksumOf(checksum.algorithm) : null;
  const fail = (message) => new S3Error(400, 'IncompleteBody', message);
  const verifyChunk = (hash) => {
    const stringToSign = ['AWS4-HMAC-SHA256-PAYLOAD', chain.amzDate, chain.scope, previous, EMPTY_SHA256, hash].join('\n');
    const expected = hmac(chain.key, stringToSign).toString('hex');
    if (expected !== chunkSignature) throw mismatch();
    previous = expected;
  };
  return new Transform({
    transform(data, _encoding, done) {
      buffer = buffer.length ? Buffer.concat([buffer, data]) : data;
      try {
        for (;;) {
          if (state === 'size' || state === 'trailer') {
            const end = buffer.indexOf('\r\n');
            if (end < 0) {
              if (buffer.length > 4096) throw fail('A chunk header is too long');
              break;
            }
            const line = buffer.subarray(0, end).toString('latin1');
            buffer = buffer.subarray(end + 2);
            if (state === 'trailer') {
              if (line === '') {
                state = 'done';
                continue;
              }
              const at = line.indexOf(':');
              trailers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
              continue;
            }
            const [size, ...extensions] = line.split(';');
            remaining = Number.parseInt(size, 16);
            if (!/^[0-9a-fA-F]+$/.test(size) || !Number.isSafeInteger(remaining)) throw fail(`A chunk's size is malformed: ${JSON.stringify(line.slice(0, 40))}`);
            chunkSignature = extensions.find((e) => e.startsWith('chunk-signature='))?.slice(16) ?? '';
            if (signed && !chunkSignature) throw mismatch();
            chunkHash = signed ? createHash('sha256') : null;
            if (remaining === 0) {
              if (signed) verifyChunk(EMPTY_SHA256);
              state = trailer ? 'trailer' : 'final';
              continue;
            }
            state = 'data';
          } else if (state === 'data') {
            if (!buffer.length) break;
            const piece = buffer.subarray(0, Math.min(remaining, buffer.length));
            buffer = buffer.subarray(piece.length);
            remaining -= piece.length;
            total += piece.length;
            chunkHash?.update(piece);
            sum?.update(piece);
            this.push(piece);
            if (remaining === 0) state = 'data-end';
          } else if (state === 'data-end') {
            if (buffer.length < 2) break;
            if (buffer[0] !== 13 || buffer[1] !== 10) throw fail('A chunk does not end with CRLF');
            buffer = buffer.subarray(2);
            if (signed) verifyChunk(chunkHash.digest('hex'));
            state = 'size';
          } else if (state === 'final') {
            if (buffer.length < 2) break;
            buffer = buffer.subarray(2);
            state = 'done';
          } else {
            buffer = Buffer.alloc(0);
            break;
          }
        }
        done();
      } catch (error) {
        done(error);
      }
    },
    flush(done) {
      try {
        if (state !== 'done') throw fail('The body ended before its last chunk');
        if (decodedLength !== undefined && total !== decodedLength) throw fail(`The body has ${total} bytes, not the ${decodedLength} x-amz-decoded-content-length says`);
        if (trailer && signed) {
          const signature = trailers['x-amz-trailer-signature'];
          const lines = Object.entries(trailers)
            .filter(([name]) => name !== 'x-amz-trailer-signature')
            .map(([name, value]) => `${name}:${value}\n`)
            .join('');
          const stringToSign = ['AWS4-HMAC-SHA256-TRAILER', chain.amzDate, chain.scope, previous, sha256hex(lines)].join('\n');
          if (hmac(chain.key, stringToSign).toString('hex') !== signature) throw mismatch();
        }
        if (checksum) {
          const sent = trailers[checksum.header] ?? checksum.value;
          if (sent === undefined) throw new S3Error(400, 'InvalidRequest', `The trailer ${checksum.header} is missing`);
          if (sum && sum.digest() !== sent) throw new S3Error(400, 'BadDigest', `The ${checksum.algorithm.toUpperCase()} you specified did not match the calculated checksum.`);
        }
        done();
      } catch (error) {
        done(error);
      }
    },
  });
}

/** A plain body whose SHA-256 was signed: checked at its end, before the stream ends. */
function hashChecker(expected) {
  const hash = createHash('sha256');
  return new Transform({
    transform(data, _encoding, done) {
      hash.update(data);
      done(null, data);
    },
    flush(done) {
      done(hash.digest('hex') === expected ? null : new S3Error(400, 'XAmzContentSHA256Mismatch', "The provided 'x-amz-content-sha256' header does not match what was computed."));
    },
  });
}

// ---------- requests ----------

/** The request's bucket and key, by its host (virtual-hosted) or its path's first segment (path-style). */
function addressOf(request, rawPath) {
  const host = (request.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  if (host.endsWith(`.${DOMAIN}`)) {
    const bucket = host.slice(0, -DOMAIN.length - 1);
    return { style: 'virtual-hosted', bucket, keyPath: rawPath.slice(1) };
  }
  const [, bucket = '', ...rest] = rawPath.split('/');
  return { style: 'path', bucket: decode(bucket), keyPath: rest.join('/') };
}

/** The operation, as S3 names it, and the class AWS bills it in. */
function operationOf(method, bucket, keyPath, query, headers) {
  const has = (name) => query.has(name);
  if (!bucket) return method === 'GET' ? ['ListBuckets', 'tier1'] : ['Unknown', 'tier2'];
  if (!keyPath) {
    if (method === 'GET' && has('location')) return ['GetBucketLocation', 'tier2'];
    if (method === 'GET' && has('uploads')) return ['ListMultipartUploads', 'tier1'];
    if (method === 'GET') return [query.get('list-type') === '2' ? 'ListObjectsV2' : 'ListObjects', 'tier1'];
    if (method === 'HEAD') return ['HeadBucket', 'tier2'];
    if (method === 'POST' && has('delete')) return ['DeleteObjects', 'free'];
    return ['NotImplemented', 'tier2'];
  }
  if (method === 'PUT' && has('partNumber')) return [headers['x-amz-copy-source'] ? 'UploadPartCopy' : 'UploadPart', 'tier1'];
  if (method === 'PUT' && headers['x-amz-copy-source']) return ['CopyObject', 'tier1'];
  if (method === 'PUT') return ['PutObject', 'tier1'];
  if (method === 'POST' && has('uploads')) return ['CreateMultipartUpload', 'tier1'];
  if (method === 'POST' && has('uploadId')) return ['CompleteMultipartUpload', 'tier1'];
  if (method === 'GET' && has('uploadId')) return ['ListParts', 'tier1'];
  if (method === 'DELETE' && has('uploadId')) return ['AbortMultipartUpload', 'free'];
  if (method === 'DELETE') return ['DeleteObject', 'free'];
  if (method === 'HEAD') return ['HeadObject', 'tier2'];
  if (method === 'GET') return ['GetObject', 'tier2'];
  return ['NotImplemented', 'tier2'];
}

/** The headers that go on to the store: the object's own and the conditions; never the client's signature. */
const FORWARDED = /^(content-type|content-md5|content-language|content-disposition|cache-control|expires|range|if-match|if-none-match|if-modified-since|if-unmodified-since|x-amz-meta-.*|x-amz-copy-source-range|x-amz-copy-source-if-.*|x-amz-tagging|x-amz-storage-class|x-amz-checksum-(crc32|crc32c|sha1|sha256)|x-amz-sdk-checksum-algorithm|x-amz-checksum-algorithm|x-amz-metadata-directive|x-amz-tagging-directive)$/;
const ANSWERED = /^(content-type|content-length|content-range|content-encoding|content-language|content-disposition|cache-control|expires|etag|last-modified|accept-ranges|x-amz-meta-.*|x-amz-checksum-.*|x-amz-storage-class|x-amz-version-id|x-amz-delete-marker|x-amz-mp-parts-count|x-amz-tagging-count|x-amz-copy-source-version-id)$/;

function signUpstream(method, path, query, headers) {
  const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const all = { ...headers, host: UPSTREAM.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' };
  const names = Object.keys(all).map((name) => name.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([name, value]) => [name.toLowerCase(), String(value)]));
  const canonical = [method, canonicalUri(path), canonicalQuery(query), names.map((name) => `${name}:${lower[name].trim()}\n`).join(''), names.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = `${date}/us-east-1/s3/aws4_request`;
  const signature = hmac(signingKey(UPSTREAM_SECRET, date, 'us-east-1'), ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n')).toString('hex');
  return { ...lower, authorization: `AWS4-HMAC-SHA256 Credential=${UPSTREAM_KEY}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

function xmlError(response, error, requestId, method) {
  const body =
    method === 'HEAD'
      ? ''
      : `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${error.code}</Code><Message>${error.message}</Message><RequestId>${requestId}</RequestId></Error>`;
  response.writeHead(error.status, { 'content-type': 'application/xml', 'x-amz-request-id': requestId, 'content-length': Buffer.byteLength(body) });
  response.end(body);
}
const xml = (body) => `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;

function count(bucket, klass, bytesIn, bytesOut) {
  const minute = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
  const id = `${bucket}|${minute}|${klass}`;
  const row = counts.get(id) ?? { bucket, minute, class: klass, requests: 0, bytesIn: 0, bytesOut: 0 };
  row.requests += 1;
  row.bytesIn += bytesIn;
  row.bytesOut += bytesOut;
  counts.set(id, row);
}

async function serve(request, response) {
  const requestId = randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase();
  const target = request.url ?? '/';
  const at = target.indexOf('?');
  const rawPath = at < 0 ? target : target.slice(0, at);
  const rawQuery = at < 0 ? '' : target.slice(at + 1);
  const url = new URL(target, 'http://front-door');
  const { style, bucket, keyPath } = addressOf(request, rawPath);
  const [operation, klass] = operationOf(request.method, bucket, keyPath, url.searchParams, request.headers);
  const entry = {
    requestId,
    method: request.method,
    operation,
    class: klass,
    style,
    bucket,
    userAgent: request.headers['user-agent'],
    payload: request.headers['x-amz-content-sha256']?.startsWith('STREAMING') || request.headers['x-amz-content-sha256']?.length !== 64 ? request.headers['x-amz-content-sha256'] : 'sha256',
    contentEncoding: request.headers['content-encoding'],
    trailer: request.headers['x-amz-trailer'],
    checksumAlgorithm: request.headers['x-amz-sdk-checksum-algorithm'],
    checksumHeader: Object.keys(request.headers).find((name) => /^x-amz-checksum-(crc|sha)/.test(name)),
    decodedLength: request.headers['x-amz-decoded-content-length'],
    contentLength: request.headers['content-length'],
    expect: request.headers.expect,
  };
  let bytesIn = 0;
  let bytesOut = 0;
  try {
    const auth = verify(request, url, rawPath, rawQuery);
    entry.auth = auth.kind;
    entry.region = auth.region;
    if (operation === 'ListBuckets') {
      const buckets = auth.key.buckets.map((name) => `<Bucket><Name>${name}</Name><CreationDate>2026-10-23T00:00:00.000Z</CreationDate></Bucket>`).join('');
      const body = xml(`<ListAllMyBucketsResult><Owner><ID>${auth.keyId}</ID></Owner><Buckets>${buckets}</Buckets></ListAllMyBucketsResult>`);
      response.writeHead(200, { 'content-type': 'application/xml', 'x-amz-request-id': requestId });
      response.end(body);
      entry.status = 200;
      count('(account)', klass, 0, Buffer.byteLength(body));
      return;
    }
    if (!auth.key.buckets.includes(bucket)) throw denied();
    if (operation === 'NotImplemented') throw new S3Error(501, 'NotImplemented', 'A header or query you provided implies functionality that is not implemented.');
    if (operation === 'GetBucketLocation') {
      response.writeHead(200, { 'content-type': 'application/xml', 'x-amz-request-id': requestId });
      response.end(xml(`<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${REGION}</LocationConstraint>`));
      entry.status = 200;
      count(bucket, klass, 0, 0);
      return;
    }
    const store = config.buckets[bucket];
    const headers = {};
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const name = request.rawHeaders[i].toLowerCase();
      if (FORWARDED.test(name)) headers[name] = request.rawHeaders[i + 1];
    }
    const copySource = request.headers['x-amz-copy-source'];
    if (copySource) {
      const [sourceBucket, ...sourceKey] = decode(copySource.replace(/^\//, '')).split('/');
      if (!auth.key.buckets.includes(sourceBucket)) throw denied();
      headers['x-amz-copy-source'] = `/${config.buckets[sourceBucket]}/${encode(sourceKey.join('/'), true)}`;
    }
    // The body's own encoding, without aws-chunked: what the store keeps is what the client meant.
    const encodings = (request.headers['content-encoding'] ?? '').split(',').map((e) => e.trim()).filter((e) => e && e !== 'aws-chunked');
    if (encodings.length) headers['content-encoding'] = encodings.join(',');
    const payload = auth.payload;
    const streaming = payload.startsWith('STREAMING-');
    const hasBody = request.method === 'PUT' || request.method === 'POST';
    if (streaming) {
      const decoded = Number(request.headers['x-amz-decoded-content-length']);
      if (!Number.isSafeInteger(decoded)) throw new S3Error(411, 'MissingContentLength', 'You must provide x-amz-decoded-content-length');
      headers['content-length'] = String(decoded);
      // The checksum the trailer will carry is checked here; the store gets the object, not the trailer.
      delete headers['x-amz-sdk-checksum-algorithm'];
    } else if (hasBody) {
      headers['content-length'] = request.headers['content-length'] ?? '0';
    }
    // Presigned: the signature's own parameters stay here, and so do the checksum's, which S3 signs and ignores: AWS's
    // SDK for JavaScript signs the CRC-32 of an empty body into every presigned upload, which a store that checks it
    // (SeaweedFS does) would refuse.
    const query = rawQuery
      .split('&')
      .filter(
        (pair) =>
          pair &&
          !/^X-Amz-(Algorithm|Credential|Date|Expires|SignedHeaders|Signature|Security-Token|Content-Sha256)=/i.test(pair) &&
          !/^x-id=/.test(pair) &&
          !(auth.kind === 'presigned' && /^x-amz-(checksum-[a-z0-9]+|sdk-checksum-algorithm)=/i.test(pair)),
      )
      .join('&');
    const path = `/${store}/${keyPath}`;
    const signed = signUpstream(request.method, path, query, headers);
    const upstream = upstreamRequest({ host: UPSTREAM.hostname, port: UPSTREAM.port, method: request.method, path: query ? `${path}?${query}` : path, headers: signed });
    const answered = new Promise((resolve, reject) => {
      upstream.on('response', resolve);
      upstream.on('error', reject);
    });
    if (hasBody) {
      let body = request;
      const counter = new Transform({
        transform(data, _encoding, done) {
          bytesIn += data.length;
          done(null, data);
        },
      });
      const stages = [request, counter];
      if (streaming) {
        const trailerName = request.headers['x-amz-trailer']?.toLowerCase();
        const algorithm = (trailerName ?? Object.keys(request.headers).find((name) => /^x-amz-checksum-(crc32c?|sha1|sha256)$/.test(name)))?.replace('x-amz-checksum-', '');
        stages.push(
          chunkDecoder({
            signed: payload.startsWith('STREAMING-AWS4-HMAC-SHA256-PAYLOAD'),
            chain: auth.chain,
            trailer: payload.endsWith('-TRAILER'),
            decodedLength: Number(request.headers['x-amz-decoded-content-length']),
            checksum: algorithm ? { algorithm, header: `x-amz-checksum-${algorithm}`, value: request.headers[`x-amz-checksum-${algorithm}`] } : undefined,
          }),
        );
        entry.checksumChecked = algorithm ?? null;
      } else if (/^[0-9a-f]{64}$/.test(payload)) {
        stages.push(hashChecker(payload));
      }
      body = stages;
      await new Promise((resolve, reject) => {
        pipeline(...body, upstream, (error) => (error ? reject(error) : resolve()));
      });
    } else {
      upstream.end();
    }
    const answer = await answered;
    const out = { 'x-amz-request-id': requestId };
    for (const [name, value] of Object.entries(answer.headers)) if (ANSWERED.test(name)) out[name] = value;
    const type = answer.headers['content-type'] ?? '';
    if (/xml/.test(type) && Number(answer.headers['content-length'] ?? 0) < 1_048_576) {
      // An answer that names the bucket names the client's, not the store's.
      const chunks = [];
      for await (const chunk of answer) chunks.push(chunk);
      const text = Buffer.concat(chunks)
        .toString('utf8')
        .split(store)
        .join(bucket)
        .replace(/<Location>[^<]*<\/Location>/, `<Location>http://${request.headers.host}/${bucket}/${keyPath}</Location>`);
      out['content-length'] = String(Buffer.byteLength(text));
      response.writeHead(answer.statusCode, out);
      response.end(request.method === 'HEAD' ? undefined : text);
      bytesOut = Buffer.byteLength(text);
    } else {
      response.writeHead(answer.statusCode, out);
      await new Promise((resolve, reject) => {
        const counter = new Transform({
          transform(data, _encoding, done) {
            bytesOut += data.length;
            done(null, data);
          },
        });
        pipeline(answer, counter, response, (error) => (error ? reject(error) : resolve()));
      });
    }
    entry.status = answer.statusCode;
    count(bucket, klass, bytesIn, bytesOut);
  } catch (error) {
    const s3 = error instanceof S3Error ? error : new S3Error(500, 'InternalError', 'We encountered an internal error. Please try again.');
    if (!(error instanceof S3Error)) entry.internal = String(error?.stack ?? error);
    entry.status = s3.status;
    entry.error = s3.code;
    if (!response.headersSent) xmlError(response, s3, requestId, request.method);
    else response.destroy();
    // A client that sent a body we refused early has the rest of it in flight: drain it, then close.
    request.resume();
  } finally {
    entry.bytesIn = bytesIn;
    entry.bytesOut = bytesOut;
    if (LOG) appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
  }
}

for (const host of HOSTS) {
  const server = createServer((request, response) => void serve(request, response));
  server.listen(PORT, host, () => console.error(`front door on ${host}:${PORT}, virtual-hosted under ${DOMAIN}, the store at ${UPSTREAM.origin}`));
}
const report = () => {
  if (process.env.COUNTS) appendFileSync(process.env.COUNTS, `${JSON.stringify([...counts.values()])}\n`);
  process.exit(0);
};
process.on('SIGTERM', report);
process.on('SIGINT', report);

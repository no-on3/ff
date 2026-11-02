/**
 * L1: Signature Version 4, read and checked once for every front door,
 * against AWS's published test suite (signature-v4-suite/, from aws-c-auth):
 * each case's canonical request, string to sign and signature, signed in a
 * header and presigned in a query, each path in S3's form or every other
 * service's as the case says, and its signed request read and checked whole.
 */
import { SignatureV4 } from '@smithy/signature-v4';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import {
  SignatureProblem,
  SignedRequest,
  SignedService,
  canonicalPath,
  canonicalQuery,
  canonicalRequest,
  canonicalUri,
  checkAuthorization,
  hmac,
  matchSignature,
  normalizedPath,
  readAuthorization,
  scopeOf,
  sha256Hex,
  signingKey,
  stringToSign,
  uriEncode,
} from './signature-v4';

interface SuiteForm {
  signedRequest: string;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

interface SuiteCase {
  name: string;
  context: {
    credentials: { access_key_id: string; secret_access_key: string; token?: string };
    /** A token added after signing: no part of what was signed. */
    omit_session_token?: boolean;
    normalize: boolean;
    region: string;
    service: string;
    timestamp: string;
  };
  header: SuiteForm;
  query: SuiteForm;
}

const SUITE: { cases: SuiteCase[] } = JSON.parse(readFileSync(join(__dirname, 'signature-v4-suite', 'cases.json'), 'utf8'));

class Refused extends Error {
  constructor(readonly problem: SignatureProblem) {
    super(problem.kind);
  }
}

/** The suite's service: its paths in S3's form when the case doesn't normalize them, every other service's when it does. */
const serviceOf = ({ context }: SuiteCase): SignedService => ({
  name: context.service,
  paths: context.normalize ? 'twice' : 'once',
  refuse: (problem) => new Refused(problem),
});

/** A request as the suite writes it, read as the front doors get it: its target unparsed, its headers as sent, a folded value kept whole. */
function parse(text: string): { request: SignedRequest; headers: IncomingHttpHeaders; body: Buffer } {
  const end = text.indexOf('\n\n');
  const [requestLine, ...lines] = (end < 0 ? text : text.slice(0, end)).split('\n');
  const method = requestLine.slice(0, requestLine.indexOf(' '));
  const target = requestLine.slice(method.length + 1, requestLine.lastIndexOf(' HTTP/'));
  const rawHeaders: string[] = [];
  for (const line of lines) {
    if (/^\s/.test(line)) rawHeaders[rawHeaders.length - 1] += `\n${line}`;
    else rawHeaders.push(line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1));
  }
  const headers: IncomingHttpHeaders = {};
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i].toLowerCase();
    const value = rawHeaders[i + 1].trim();
    headers[name] = headers[name] === undefined ? value : `${headers[name] as string}, ${value}`;
  }
  const at = target.indexOf('?');
  return {
    request: { method, rawPath: at < 0 ? target : target.slice(0, at), rawQuery: at < 0 ? '' : target.slice(at + 1), rawHeaders },
    headers,
    body: Buffer.from(end < 0 ? '' : text.slice(end + 2)),
  };
}

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof Refused) return error.problem.kind;
    throw error;
  }
  return 'accepted';
};

const at = (testCase: SuiteCase) => new Date(testCase.context.timestamp);
const secretOf = (testCase: SuiteCase) => testCase.context.credentials.secret_access_key;

describe("AWS's Signature Version 4 test suite, signed in a header", () => {
  it.each(SUITE.cases.map((testCase) => [testCase.name, testCase] as const))('%s: the canonical request, the string to sign and the signature', (_name, testCase) => {
    const service = serviceOf(testCase);
    const { request, headers, body } = parse(testCase.header.signedRequest);
    const read = readAuthorization({ ...headers, 'x-amz-security-token': undefined }, service);
    expect(read).not.toBeNull();
    const { date, region, amzDate, signedHeaders } = read!;

    const canonical = canonicalRequest(request, canonicalPath(request.rawPath, service.paths), signedHeaders, sha256Hex(body));
    const signed = stringToSign(amzDate, scopeOf(date, region, service.name), canonical);
    expect(canonical).toBe(testCase.header.canonicalRequest);
    expect(signed).toBe(testCase.header.stringToSign);
    expect(hmac(signingKey(secretOf(testCase), date, region, service.name), signed).toString('hex')).toBe(testCase.header.signature);
  });

  it.each(SUITE.cases.map((testCase) => [testCase.name, testCase] as const))("%s: read and checked whole, passed with the key's secret, refused changed or with a token", (_name, testCase) => {
    const service = serviceOf(testCase);
    const { request, headers, body } = parse(testCase.header.signedRequest);
    if (testCase.context.credentials.token !== undefined) {
      expect(refusal(() => readAuthorization(headers, service))).toBe('token');
      return;
    }
    const read = readAuthorization(headers, service)!;

    expect(read.accessKeyId).toBe(testCase.context.credentials.access_key_id);
    expect(refusal(() => checkAuthorization(request, body, read, secretOf(testCase), at(testCase), service))).toBe('accepted');
    expect(refusal(() => checkAuthorization({ ...request, method: 'DELETE' }, body, read, secretOf(testCase), at(testCase), service))).toBe('mismatch');
    expect(refusal(() => checkAuthorization(request, body, read, `${secretOf(testCase)}x`, at(testCase), service))).toBe('mismatch');
  });
});

describe("AWS's Signature Version 4 test suite, presigned in a query", () => {
  it.each(SUITE.cases.map((testCase) => [testCase.name, testCase] as const))('%s: the canonical request without the signature, the string to sign, and the signature matched', (_name, testCase) => {
    const service = serviceOf(testCase);
    const sent = parse(testCase.query.signedRequest);
    const { body } = sent;
    const request = testCase.context.omit_session_token
      ? { ...sent.request, rawQuery: sent.request.rawQuery.split('&').filter((pair) => !pair.startsWith('X-Amz-Security-Token=')).join('&') }
      : sent.request;
    const query = new URLSearchParams(request.rawQuery);
    const [, date, region] = (query.get('X-Amz-Credential') as string).split('/');
    const signedHeaders = (query.get('X-Amz-SignedHeaders') as string).split(';');
    const amzDate = query.get('X-Amz-Date') as string;
    const signature = query.get('X-Amz-Signature') as string;

    const canonical = canonicalRequest(request, canonicalPath(request.rawPath, service.paths), signedHeaders, sha256Hex(body), 'X-Amz-Signature');
    expect(canonical).toBe(testCase.query.canonicalRequest);
    expect(stringToSign(amzDate, scopeOf(date, region, service.name), canonical)).toBe(testCase.query.stringToSign);
    expect(signature).toBe(testCase.query.signature);
    const presigned = { date, region, amzDate, signedHeaders, signature };
    expect(refusal(() => matchSignature(request, presigned, sha256Hex(body), secretOf(testCase), service, 'X-Amz-Signature'))).toBe('accepted');
    expect(refusal(() => matchSignature({ ...request, rawQuery: `${request.rawQuery}&extra=1` }, presigned, sha256Hex(body), secretOf(testCase), service, 'X-Amz-Signature'))).toBe(
      'mismatch',
    );
  });
});

describe('the canonical request', () => {
  it('encodes each path segment once, as the client meant it, and normalizes nothing', () => {
    expect(canonicalUri('/photos/2026/a b.jpg')).toBe('/photos/2026/a%20b.jpg');
    expect(canonicalUri('/photos//a%2ab')).toBe('/photos//a%2Ab');
    expect(canonicalUri('/photos/./../x')).toBe('/photos/./../x');
    expect(canonicalUri('/k%C3%A9y%2Fslash')).toBe('/k%C3%A9y%2Fslash');
    expect(canonicalUri('')).toBe('/');
    expect(uriEncode('a/b~c', true)).toBe('a/b~c');
  });

  it('sorts the query by name, then by value, each encoded; "+" is a plus sign, as Signature Version 4 reads it', () => {
    expect(canonicalQuery('prefix=J&max-keys=2&list-type=2')).toBe('list-type=2&max-keys=2&prefix=J');
    expect(canonicalQuery('a=2&a=1&b')).toBe('a=1&a=2&b=');
    expect(canonicalQuery('prefix=a+b&delimiter=%2F')).toBe('delimiter=%2F&prefix=a%2Bb');
    expect(canonicalQuery('X-Amz-Signature=00&X-Amz-Date=1', 'X-Amz-Signature')).toBe('X-Amz-Date=1');
  });
});

/** SHA-256 and its HMAC, as AWS's signer takes them: from node's crypto. */
class Sha256 {
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

describe("every service's path but S3's, as Lambda's carry ARNs", () => {
  const ARN_PATH = '/2015-03-31/functions/arn%3Aaws%3Alambda%3Atn-tunis-1%3A000000000001%3Afunction%3Aorders/invocations';
  const LAMBDA: SignedService = { name: 'lambda', paths: 'twice', refuse: (problem) => new Refused(problem) };

  it('normalizes the path, then escapes it once more: an ARN\'s colon, %3A on the wire, is signed %253A', () => {
    expect(canonicalPath(ARN_PATH, 'twice')).toBe('/2015-03-31/functions/arn%253Aaws%253Alambda%253Atn-tunis-1%253A000000000001%253Afunction%253Aorders/invocations');
    expect([normalizedPath('//a//b/'), normalizedPath('/a/./b/../c'), normalizedPath('/a/..'), normalizedPath('')]).toEqual(['/a/b/', '/a/c', '/', '/']);
  });

  it("passes a call signed for lambda by AWS's own signer, and refuses it signed with the path escaped once, as for S3", async () => {
    const credentials = { accessKeyId: 'AKFFAAAAAAAAAAAAAAAA', secretAccessKey: 'a'.repeat(40) };
    const sign = (uriEscapePath: boolean) =>
      new SignatureV4({ service: 'lambda', region: 'tn-tunis-1', credentials, sha256: Sha256, uriEscapePath }).sign({
        method: 'POST',
        protocol: 'http:',
        hostname: 'localhost',
        path: ARN_PATH,
        query: {},
        headers: { host: 'localhost:3006' },
        body: '{}',
      });
    const check = async (uriEscapePath: boolean) => {
      const sent = await sign(uriEscapePath);
      const headers = Object.fromEntries(Object.entries(sent.headers).map(([name, value]) => [name.toLowerCase(), value]));
      const request = { method: 'POST', rawPath: ARN_PATH, rawQuery: '', rawHeaders: Object.entries(sent.headers).flat() };
      return refusal(() => checkAuthorization(request, Buffer.from('{}'), readAuthorization(headers, LAMBDA)!, credentials.secretAccessKey, new Date(), LAMBDA));
    };

    expect(await check(true)).toBe('accepted');
    expect(await check(false)).toBe('mismatch');
  });
});

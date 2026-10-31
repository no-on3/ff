/**
 * L1: SES v2's signatures (ADR 0012), as AWS's own signer makes them for the
 * service ses: the path escaped twice, as for every service but S3, so that
 * an address's "@" is %2540 in what is signed; the key, the day and the
 * region read; a wrong secret, another service, an old time and a path signed
 * once refused, each in SES's words.
 */
import { SignatureV4 } from '@smithy/signature-v4';
import { createHash, createHmac } from 'node:crypto';
import { SesError } from './ses-error';
import { SesSignature, canonicalUriTwice, checkSesSignature, readSesSignature } from './ses-signature';

const KEY = { accessKeyId: 'AKFFAAAAAAAAAAAAAAAA', secretAccessKey: 'a'.repeat(40) };

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

/** A request as AWS's SDK sends it, signed for `service`: its path as on the wire, escaped once. */
async function signed(path: string, { service = 'ses', credentials = KEY, body = '', at = new Date(), escapeTwice = true } = {}) {
  const signer = new SignatureV4({ service, region: 'tn-tunis-1', credentials, sha256: Sha256, uriEscapePath: escapeTwice });
  const request = await signer.sign(
    { method: 'GET', protocol: 'http:', hostname: 'localhost', port: 3005, path, query: {}, headers: { host: 'localhost:3005', 'content-type': 'application/json' }, body },
    { signingDate: at },
  );
  const rawHeaders = Object.entries(request.headers).flat();
  return { headers: Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value])), rawHeaders, body: Buffer.from(body) };
}

function refusal(check: () => unknown): { type: string; status: number; message: string } {
  try {
    check();
  } catch (error) {
    if (error instanceof SesError) return { type: error.type, status: error.status, message: error.message };
    throw error;
  }
  throw new Error('not refused');
}

const PATH = '/v2/email/identities/b%40shop.example.tn';

describe("SES v2's signatures, as AWS's signer makes them (L1, ADR 0012)", () => {
  it('escapes the path twice, as AWS signs it for every service but S3, a segment sent unescaped as the client meant it', () => {
    expect([canonicalUriTwice(PATH), canonicalUriTwice('/v2/email/identities/b@shop.example.tn'), canonicalUriTwice('/v2/email/account'), canonicalUriTwice('')]).toEqual([
      '/v2/email/identities/b%2540shop.example.tn',
      '/v2/email/identities/b%2540shop.example.tn',
      '/v2/email/account',
      '/',
    ]);
  });

  it("reads the key, the day and the region signed for, and passes a request signed with the key's secret", async () => {
    const { headers, rawHeaders, body } = await signed(PATH);
    const signature = readSesSignature(headers) as SesSignature;

    expect(signature).toMatchObject({ accessKeyId: KEY.accessKeyId, region: 'tn-tunis-1' });
    expect(() => checkSesSignature({ method: 'GET', rawPath: PATH, rawQuery: '', rawHeaders }, body, signature, KEY.secretAccessKey, new Date())).not.toThrow();
  });

  it('refuses another secret, a changed body, a path signed escaped once, as for S3, and a time more than 15 minutes away', async () => {
    const check = async (sent: Awaited<ReturnType<typeof signed>>, secret = KEY.secretAccessKey, body = sent.body) =>
      refusal(() => checkSesSignature({ method: 'GET', rawPath: PATH, rawQuery: '', rawHeaders: sent.rawHeaders }, body, readSesSignature(sent.headers) as SesSignature, secret, new Date()));
    const mismatch = { type: 'SignatureDoesNotMatch', status: 403 };

    expect(await check(await signed(PATH), 'b'.repeat(40))).toMatchObject(mismatch);
    expect(await check(await signed(PATH, { body: '{}' }), KEY.secretAccessKey, Buffer.from('{"a":1}'))).toMatchObject(mismatch);
    expect(await check(await signed(PATH, { escapeTwice: false }))).toMatchObject(mismatch);
    expect(await check(await signed(PATH, { at: new Date(Date.now() - 20 * 60_000) }))).toMatchObject({ ...mismatch, message: expect.stringContaining('Signature expired') });
  });

  it('refuses a signature for another service, one without a key, and a session token FF never issued', async () => {
    const sqs = await signed(PATH, { service: 'sqs' });
    expect(refusal(() => readSesSignature(sqs.headers))).toEqual({ type: 'SignatureDoesNotMatch', status: 403, message: "Credential should be scoped to correct service: 'ses'." });
    expect(readSesSignature({})).toBeNull();
    expect(refusal(() => readSesSignature({ authorization: 'Basic abc' }))).toMatchObject({ type: 'IncompleteSignatureException', status: 400 });
    const withToken = await signed(PATH, { credentials: { ...KEY, sessionToken: 'token' } as typeof KEY });
    expect(refusal(() => readSesSignature(withToken.headers))).toMatchObject({ type: 'UnrecognizedClientException', status: 403 });
  });
});

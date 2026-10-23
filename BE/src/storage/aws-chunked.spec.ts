import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import { ChunkedBodyReader, PlainBodyChecker } from './aws-chunked';
import { S3Error } from './s3-error';
import { RequestSignature, SignedRequest, SigningChain, checkSignature, readSignature, sha256Hex, signingKey } from './sigv4';

// AWS's documented aws-chunked uploads (the S3 API reference, "Signature Calculations for the Authorization Header:
// Transferring Payload in Multiple Chunks", with and without a trailer): 66,560 bytes of "a" in a chunk of 64 KB and
// one of 1 KB, signed with AWS's example key on 2013-05-24 at midnight, UTC.
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const DATA = Buffer.alloc(66_560, 'a');
const chain = (seed: string): SigningChain => ({
  key: signingKey(SECRET, '20130524', 'us-east-1'),
  scope: '20130524/us-east-1/s3/aws4_request',
  amzDate: '20130524T000000Z',
  seed,
});

/** The body, chunk by chunk, as a client frames it: each chunk's header with its signature if any, its data, CRLF. */
function framed(chunks: Array<{ data: Buffer; signature?: string }>, after = '\r\n'): Buffer {
  const parts: Buffer[] = [];
  chunks.forEach(({ data, signature }, n) => {
    parts.push(Buffer.from(`${data.length.toString(16)}${signature ? `;chunk-signature=${signature}` : ''}\r\n`), data);
    if (n < chunks.length - 1 || data.length) parts.push(Buffer.from('\r\n'));
  });
  parts.push(Buffer.from(after));
  return Buffer.concat(parts);
}

/** A body through a reader, in pieces of any size, into a sink that tells whether the stream completed. */
async function through(reader: Transform, body: Buffer, pieceSize = 7_919): Promise<{ data: Buffer; completed: boolean; error?: string }> {
  const pieces: Buffer[] = [];
  for (let at = 0; at < body.length; at += pieceSize) pieces.push(body.subarray(at, at + pieceSize));
  const received: Buffer[] = [];
  let completed = false;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      received.push(chunk);
      done();
    },
    final(done) {
      completed = true;
      done();
    },
  });
  try {
    await pipeline(Readable.from(pieces), reader, sink);
    return { data: Buffer.concat(received), completed };
  } catch (error) {
    return { data: Buffer.concat(received), completed, error: error instanceof S3Error ? `${error.status} ${error.code}` : String(error) };
  }
}

const SIGNED_CHUNKS = [
  { data: DATA.subarray(0, 65_536), signature: 'ad80c730a21e5b8d04586a2213dd63b9a0e99e0e2307b0ade35a65485a288648' },
  { data: DATA.subarray(65_536), signature: '0055627c9e194cb4542bae2aa5492e3c1575bbb81b612b7d234b86a503ef5497' },
  { data: Buffer.alloc(0), signature: 'b6c6ea8a5354eaf15b3cb7646744f4275b71ea724fed81ceb9323e279d449df9' },
];
const SIGNED_SEED = '4f232c4386841ef735655705268965c44a0e4690baa4adea153f7db9fa80a0a9';

describe('aws-chunked, signed chunk by chunk', () => {
  it("AWS's example: the request's own signature, then each chunk's in its chain, the data alone passed on", async () => {
    const headers: Array<[string, string]> = [
      ['Host', 's3.amazonaws.com'],
      ['x-amz-date', '20130524T000000Z'],
      ['x-amz-storage-class', 'REDUCED_REDUNDANCY'],
      ['x-amz-content-sha256', 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD'],
      ['Content-Encoding', 'aws-chunked'],
      ['x-amz-decoded-content-length', '66560'],
      ['Content-Length', '66824'],
    ];
    const signedHeaders = headers.map(([name]) => name.toLowerCase()).sort();
    const authorization = `AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=${signedHeaders.join(';')},Signature=${SIGNED_SEED}`;
    const all: Array<[string, string]> = [...headers, ['Authorization', authorization]];
    const request: SignedRequest = { method: 'PUT', rawPath: '/examplebucket/chunkObject.txt', rawQuery: '', rawHeaders: all.flat() };
    const signature = readSignature(Object.fromEntries(all.map(([name, value]) => [name.toLowerCase(), value])), new URLSearchParams()) as RequestSignature;

    const checked = checkSignature(request, signature, SECRET, new Date('2013-05-24T00:00:00Z'));
    const body = framed(SIGNED_CHUNKS);
    const { data, completed, error } = await through(new ChunkedBodyReader({ signed: true, trailer: false, chain: checked, decodedLength: 66_560 }), body);

    expect(body.length).toBe(66_824);
    expect(error).toBeUndefined();
    expect(completed).toBe(true);
    expect(data.equals(DATA)).toBe(true);
  });

  it('a chunk signed wrong, or a chunk changed, is refused, and the stream never completes', async () => {
    const wrong = SIGNED_CHUNKS.map((chunk, n) => (n === 1 ? { ...chunk, signature: chunk.signature.replace(/^0/, '1') } : chunk));
    const changed = SIGNED_CHUNKS.map((chunk, n) => (n === 0 ? { ...chunk, data: Buffer.concat([Buffer.from('b'), chunk.data.subarray(1)]) } : chunk));
    const unsigned = SIGNED_CHUNKS.map(({ data }) => ({ data }));

    for (const chunks of [wrong, changed, unsigned]) {
      const result = await through(new ChunkedBodyReader({ signed: true, trailer: false, chain: chain(SIGNED_SEED), decodedLength: 66_560 }), framed(chunks));
      expect([result.error, result.completed, result.data.length < DATA.length]).toEqual(['403 SignatureDoesNotMatch', false, true]);
    }
  });

  it('a body cut short, longer than it says, or framed wrong, is incomplete', async () => {
    const reader = () => new ChunkedBodyReader({ signed: true, trailer: false, chain: chain(SIGNED_SEED), decodedLength: 66_560 });
    const body = framed(SIGNED_CHUNKS);

    expect((await through(reader(), body.subarray(0, 40_000))).error).toBe('400 IncompleteBody');
    expect((await through(new ChunkedBodyReader({ signed: true, trailer: false, chain: chain(SIGNED_SEED), decodedLength: 66_000 }), body)).error).toBe('400 IncompleteBody');
    expect((await through(reader(), Buffer.from(`zz;chunk-signature=${'0'.repeat(64)}\r\n`))).error).toBe('400 IncompleteBody');
    expect((await through(reader(), Buffer.concat([Buffer.from(`10000;chunk-signature=${SIGNED_CHUNKS[0].signature}\r\n`), DATA.subarray(0, 65_536), Buffer.from('xx')]))).error).toBe(
      '400 IncompleteBody',
    );
  });
});

describe('aws-chunked, signed, with a signed trailer', () => {
  const SEED = '106e2a8a18243abcf37539882f36619c00e2dfc72633413f02d3b74544bfeb8e';
  const chunks = [
    { data: DATA.subarray(0, 65_536), signature: 'b474d8862b1487a5145d686f57f013e54db672cee1c953b3010fb58501ef5aa2' },
    { data: DATA.subarray(65_536), signature: '1c1344b170168f8e65b41376b44b20fe354e373826ccbbe2c1d40a8cae51e5c7' },
    { data: Buffer.alloc(0), signature: '2ca2aba2005185cf7159c6277faf83795951dd77a3a99e6e65d5c9f85863f992' },
  ];
  const TRAILER_SIGNATURE = 'd81f82fc3505edab99d459891051a732e8730629a2e4a59689829ca17fe2e435';
  const reader = () =>
    new ChunkedBodyReader({ signed: true, trailer: true, chain: chain(SEED), decodedLength: 66_560, checksum: { algorithm: 'crc32c' }, trailerName: 'x-amz-checksum-crc32c' });

  it("AWS's example: the chunks, then the CRC-32C in the trailer and the trailer's own signature", async () => {
    const { data, completed, error } = await through(reader(), framed(chunks, `x-amz-checksum-crc32c:sOO8/Q==\r\nx-amz-trailer-signature:${TRAILER_SIGNATURE}\r\n\r\n`));

    expect([error, completed, data.equals(DATA)]).toEqual([undefined, true, true]);
  });

  it("a trailer changed, its signature wrong, or the trailer it announced missing, is refused", async () => {
    const wrongValue = await through(reader(), framed(chunks, `x-amz-checksum-crc32c:AAAAAA==\r\nx-amz-trailer-signature:${TRAILER_SIGNATURE}\r\n\r\n`));
    const wrongSignature = await through(reader(), framed(chunks, `x-amz-checksum-crc32c:sOO8/Q==\r\nx-amz-trailer-signature:${'0'.repeat(64)}\r\n\r\n`));
    const missing = await through(reader(), framed(chunks, `x-amz-trailer-signature:${TRAILER_SIGNATURE}\r\n\r\n`));

    expect([wrongValue.error, wrongSignature.error, missing.error]).toEqual(['403 SignatureDoesNotMatch', '403 SignatureDoesNotMatch', '403 SignatureDoesNotMatch']);
    // The last piece waits for the trailer: the data is never all there.
    for (const result of [wrongValue, wrongSignature, missing]) expect([result.completed, result.data.length < DATA.length]).toEqual([false, true]);
  });
});

describe("aws-chunked, unsigned, with a trailing checksum: AWS's SDK for JavaScript's streams", () => {
  const crc = (data: Buffer) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(crc32(data));
    return bytes.toString('base64');
  };
  const body = (checksum: string) => framed([{ data: DATA.subarray(0, 8192) }, { data: DATA.subarray(8192) }, { data: Buffer.alloc(0) }], `x-amz-checksum-crc32:${checksum}\r\n\r\n`);
  const reader = () => new ChunkedBodyReader({ signed: false, trailer: true, decodedLength: 66_560, checksum: { algorithm: 'crc32' }, trailerName: 'x-amz-checksum-crc32' });

  it('passes the data on, its CRC-32 checked at the end', async () => {
    const { data, completed, error } = await through(reader(), body(crc(DATA)), 1000);

    expect([error, completed, data.equals(DATA)]).toEqual([undefined, true, true]);
  });

  it('refuses a CRC-32 that does not match, and a trailer without it, the stream never completing', async () => {
    const wrong = await through(reader(), body(crc(Buffer.from('other'))));
    const none = await through(reader(), framed([{ data: DATA }, { data: Buffer.alloc(0) }], '\r\n'));

    expect([wrong.error, wrong.completed, wrong.data.length < DATA.length]).toEqual(['400 BadDigest', false, true]);
    expect([none.error, none.completed, none.data.length < DATA.length]).toEqual(['400 InvalidRequest', false, true]);
  });
});

describe('a plain body', () => {
  it('whose SHA-256 was signed: passed on, then checked at its end', async () => {
    const ok = await through(new PlainBodyChecker({ sha256: sha256Hex(DATA) }), DATA);
    const changed = await through(new PlainBodyChecker({ sha256: sha256Hex(Buffer.from('other')) }), DATA);

    expect([ok.error, ok.completed, ok.data.equals(DATA)]).toEqual([undefined, true, true]);
    expect([changed.error, changed.completed, changed.data.length < DATA.length]).toEqual(['400 XAmzContentSHA256Mismatch', false, true]);
  });

  it('with a checksum in its header: checked the same way', async () => {
    const ok = await through(new PlainBodyChecker({ checksum: { algorithm: 'crc32c', value: 'sOO8/Q==' } }), DATA);
    const wrong = await through(new PlainBodyChecker({ checksum: { algorithm: 'crc32c', value: 'AAAAAA==' } }), DATA);

    expect([ok.error, ok.completed]).toEqual([undefined, true]);
    expect([wrong.error, wrong.completed, wrong.data.length < DATA.length]).toEqual(['400 BadDigest', false, true]);
  });
});

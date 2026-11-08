import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import { ChunkedBodyReader, PlainBodyChecker } from './aws-chunked';
import { S3Error } from './s3-error';
import { SignedRequest, SigningChain, sha256Hex, signingKey } from '../common/signature-v4';
import { RequestSignature, checkSignature, readSignature } from './s3-signature';

interface ExampleChunk {
  size: number;
  signature: string;
}
/** AWS's documented aws-chunked uploads, with and without a trailer: the table ff's tests read too. */
const EXAMPLES = JSON.parse(readFileSync(join(__dirname, 'aws-chunked-examples.json'), 'utf8')) as {
  accessKeyId: string;
  secret: string;
  date: string;
  amzDate: string;
  region: string;
  service: string;
  data: { byte: string; length: number };
  signed: { request: { method: string; rawPath: string; headers: Array<[string, string]> }; seed: string; chunks: ExampleChunk[]; encodedLength: number };
  signedWithTrailer: { seed: string; chunks: ExampleChunk[]; trailer: { name: string; value: string }; trailerSignature: string };
};
const SECRET = EXAMPLES.secret;
const DATA = Buffer.alloc(EXAMPLES.data.length, EXAMPLES.data.byte);
const chain = (seed: string): SigningChain => ({
  key: signingKey(SECRET, EXAMPLES.date, EXAMPLES.region, EXAMPLES.service),
  scope: `${EXAMPLES.date}/${EXAMPLES.region}/${EXAMPLES.service}/aws4_request`,
  amzDate: EXAMPLES.amzDate,
  seed,
});
/** An example's chunks, each with its slice of the data, in order. */
function exampleChunks(chunks: ExampleChunk[]): Array<{ data: Buffer; signature: string }> {
  let at = 0;
  return chunks.map(({ size, signature }) => {
    const data = DATA.subarray(at, at + size);
    at += size;
    return { data, signature };
  });
}

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

const SIGNED_CHUNKS = exampleChunks(EXAMPLES.signed.chunks);
const SIGNED_SEED = EXAMPLES.signed.seed;

describe('aws-chunked, signed chunk by chunk', () => {
  it("AWS's example: the request's own signature, then each chunk's in its chain, the data alone passed on", async () => {
    const { method, rawPath, headers } = EXAMPLES.signed.request;
    const signedHeaders = headers.map(([name]) => name.toLowerCase()).sort();
    const authorization = `AWS4-HMAC-SHA256 Credential=${EXAMPLES.accessKeyId}/${chain('').scope},SignedHeaders=${signedHeaders.join(';')},Signature=${SIGNED_SEED}`;
    const all: Array<[string, string]> = [...headers, ['Authorization', authorization]];
    const request: SignedRequest = { method, rawPath, rawQuery: '', rawHeaders: all.flat() };
    const signature = readSignature(Object.fromEntries(all.map(([name, value]) => [name.toLowerCase(), value])), new URLSearchParams()) as RequestSignature;

    const checked = checkSignature(request, signature, SECRET, new Date('2013-05-24T00:00:00Z'));
    const body = framed(SIGNED_CHUNKS);
    const { data, completed, error } = await through(new ChunkedBodyReader({ signed: true, trailer: false, chain: checked, decodedLength: DATA.length }), body);

    expect(body.length).toBe(EXAMPLES.signed.encodedLength);
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
  const { seed, trailer } = EXAMPLES.signedWithTrailer;
  const chunks = exampleChunks(EXAMPLES.signedWithTrailer.chunks);
  const TRAILER_SIGNATURE = EXAMPLES.signedWithTrailer.trailerSignature;
  const reader = () =>
    new ChunkedBodyReader({ signed: true, trailer: true, chain: chain(seed), decodedLength: DATA.length, checksum: { algorithm: 'crc32c' }, trailerName: trailer.name });

  it("AWS's example: the chunks, then the CRC-32C in the trailer and the trailer's own signature", async () => {
    const { data, completed, error } = await through(reader(), framed(chunks, `${trailer.name}:${trailer.value}\r\nx-amz-trailer-signature:${TRAILER_SIGNATURE}\r\n\r\n`));

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

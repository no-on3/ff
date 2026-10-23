import { createHash } from 'node:crypto';
import { Transform, TransformCallback } from 'node:stream';
import { ChecksumAlgorithm, RunningChecksum, runningChecksum } from './checksums';
import { S3Error, badDigest, incompleteBody, invalidRequest, signatureMismatch } from './s3-error';
import { EMPTY_SHA256, SigningChain, hmac, sha256Hex } from './sigv4';

/** The payloads of aws-chunked bodies, as x-amz-content-sha256 names them: signed chunk by chunk or not, with a trailer or not. */
export const STREAMING_SIGNED = 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD';
export const STREAMING_SIGNED_TRAILER = 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER';
export const STREAMING_UNSIGNED_TRAILER = 'STREAMING-UNSIGNED-PAYLOAD-TRAILER';

export const isStreaming = (payload: string): boolean => payload.startsWith('STREAMING-');

/** The checksum an upload must have, from its x-amz-checksum-<algorithm> header, or from its trailer when the value comes there. */
export interface ExpectedChecksum {
  algorithm: ChecksumAlgorithm;
  /** The header's value; undefined when the trailer brings it. */
  value?: string;
}

/** The longest chunk header or trailer line read: anything longer is no aws-chunked body. */
const MAX_LINE = 4096;
/** The trailer's lines together, at most. */
const MAX_TRAILER = 16 * 1024;

const sameDigest = (expected: string, actual: string): boolean => expected === actual;

/**
 * Passes data on one piece behind: the last piece waits until the body's end is
 * checked. The store has every byte of an object only once it is checked, so a
 * body that fails never completes there, whatever its declared length.
 */
abstract class HeldBackTransform extends Transform {
  private held: Buffer | null = null;

  protected hold(piece: Buffer): void {
    if (this.held) this.push(this.held);
    this.held = piece;
  }

  /** The last piece, once the end is checked. */
  protected releaseHeld(): void {
    if (this.held) this.push(this.held);
    this.held = null;
  }
}

/**
 * Reads an aws-chunked body: "<hex size>[;chunk-signature=<signature>]\r\n<data>\r\n"
 * for each chunk, a last one of size 0, then the trailer's lines and an empty
 * one. Each chunk's signature is checked in its chain from the request's; the
 * data alone goes on, as it comes, but for its last piece. The decoded length,
 * the trailer's signature and the checksum are checked when the body ends, and
 * only then does the last piece go: a body that fails never completes, so the
 * store never keeps it.
 */
export class ChunkedBodyReader extends HeldBackTransform {
  private buffer: Buffer = Buffer.alloc(0);
  private state: 'size' | 'data' | 'data-end' | 'final' | 'trailer' | 'done' = 'size';
  private remaining = 0;
  private chunkSignature = '';
  private chunkHash: ReturnType<typeof createHash> | null = null;
  private previous: string;
  private decoded = 0;
  private trailerBytes = 0;
  private readonly trailers = new Map<string, string>();
  private readonly checksum: RunningChecksum | null;

  constructor(
    private readonly options: {
      signed: boolean;
      trailer: boolean;
      /** The request's signature chain, for signed bodies. */
      chain?: SigningChain;
      /** x-amz-decoded-content-length: the data's bytes without the chunks' framing. */
      decodedLength: number;
      checksum?: ExpectedChecksum;
      /** The trailer's header, as x-amz-trailer names it. */
      trailerName?: string;
    },
  ) {
    super();
    if (options.signed && !options.chain) throw new Error('A signed aws-chunked body needs its signature chain');
    this.previous = options.chain?.seed ?? '';
    this.checksum = options.checksum ? runningChecksum(options.checksum.algorithm) : null;
  }

  _transform(data: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
    try {
      this.consume();
      done();
    } catch (error) {
      done(error as Error);
    }
  }

  _flush(done: TransformCallback): void {
    this.checkEnd().then(
      () => {
        this.releaseHeld();
        done();
      },
      (error: unknown) => done(error as Error),
    );
  }

  /** As much of the buffer as can be read now. */
  private consume(): void {
    for (;;) {
      if (this.state === 'size' || this.state === 'trailer') {
        const end = this.buffer.indexOf('\r\n');
        if (end < 0) {
          if (this.buffer.length > MAX_LINE) throw incompleteBody('A chunk header or trailer line of the aws-chunked body is too long');
          return;
        }
        const line = this.buffer.subarray(0, end).toString('latin1');
        this.buffer = this.buffer.subarray(end + 2);
        if (this.state === 'trailer') this.trailerLine(line);
        else this.chunkHeader(line);
      } else if (this.state === 'data') {
        if (!this.buffer.length) return;
        const piece = this.buffer.subarray(0, Math.min(this.remaining, this.buffer.length));
        this.buffer = this.buffer.subarray(piece.length);
        this.remaining -= piece.length;
        this.decoded += piece.length;
        if (this.decoded > this.options.decodedLength) {
          throw incompleteBody(`The body has more than the ${this.options.decodedLength} bytes x-amz-decoded-content-length says`);
        }
        this.chunkHash?.update(piece);
        this.checksum?.update(piece);
        this.hold(piece);
        if (this.remaining === 0) this.state = 'data-end';
      } else if (this.state === 'data-end' || this.state === 'final') {
        if (this.buffer.length < 2) return;
        if (this.buffer[0] !== 13 || this.buffer[1] !== 10) throw incompleteBody('A chunk of the aws-chunked body does not end with CRLF');
        this.buffer = this.buffer.subarray(2);
        if (this.state === 'final') {
          this.state = 'done';
          continue;
        }
        if (this.options.signed) this.chunkSigned(this.chunkHash?.digest('hex') ?? EMPTY_SHA256);
        this.state = 'size';
      } else {
        // Done: what may follow the body's end is no part of it.
        this.buffer = Buffer.alloc(0);
        return;
      }
    }
  }

  private chunkHeader(line: string): void {
    const [size, ...extensions] = line.split(';');
    if (!/^[0-9a-fA-F]{1,16}$/.test(size)) throw incompleteBody(`A chunk's size is malformed: ${JSON.stringify(line.slice(0, 40))}`);
    this.remaining = Number.parseInt(size, 16);
    if (!Number.isSafeInteger(this.remaining)) throw incompleteBody("A chunk's size is too large");
    this.chunkSignature = extensions.find((extension) => extension.startsWith('chunk-signature='))?.slice('chunk-signature='.length) ?? '';
    if (this.options.signed && !/^[0-9a-f]{64}$/.test(this.chunkSignature)) throw signatureMismatch();
    this.chunkHash = this.options.signed ? createHash('sha256') : null;
    if (this.remaining > 0) {
      this.state = 'data';
      return;
    }
    // The last chunk: empty, signed as any other, then the trailer's lines or the body's last CRLF.
    if (this.options.signed) this.chunkSigned(EMPTY_SHA256);
    this.state = this.options.trailer ? 'trailer' : 'final';
  }

  /** Checks the chunk's signature: the previous one's, chained, over the hash of its data. */
  private chunkSigned(hash: string): void {
    const chain = this.options.chain as SigningChain;
    const expected = hmac(chain.key, ['AWS4-HMAC-SHA256-PAYLOAD', chain.amzDate, chain.scope, this.previous, EMPTY_SHA256, hash].join('\n')).toString('hex');
    if (!sameDigest(expected, this.chunkSignature)) throw signatureMismatch();
    this.previous = expected;
  }

  private trailerLine(line: string): void {
    if (line === '') {
      this.state = 'done';
      return;
    }
    this.trailerBytes += line.length + 2;
    if (this.trailerBytes > MAX_TRAILER) throw invalidRequest('The trailer of the aws-chunked body is too large');
    const at = line.indexOf(':');
    if (at <= 0) throw invalidRequest(`A trailer line is malformed: ${JSON.stringify(line.slice(0, 40))}`);
    this.trailers.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }

  private async checkEnd(): Promise<void> {
    if (this.state !== 'done') throw incompleteBody();
    if (this.decoded !== this.options.decodedLength) {
      throw incompleteBody(`The body has ${this.decoded} bytes, not the ${this.options.decodedLength} x-amz-decoded-content-length says`);
    }
    if (this.options.trailer && this.options.signed) this.trailerSigned();
    if (this.options.trailerName && !this.trailers.has(this.options.trailerName)) {
      throw invalidRequest(`The body's trailer has no ${this.options.trailerName}, which x-amz-trailer announced`);
    }
    await checkChecksum(this.options.checksum, this.checksum, this.trailers);
  }

  /** The trailer's signature: chained from the last chunk's, over its lines but the signature, each "name:value\n". */
  private trailerSigned(): void {
    const chain = this.options.chain as SigningChain;
    const lines = [...this.trailers]
      .filter(([name]) => name !== 'x-amz-trailer-signature')
      .map(([name, value]) => `${name}:${value}\n`)
      .join('');
    const expected = hmac(chain.key, ['AWS4-HMAC-SHA256-TRAILER', chain.amzDate, chain.scope, this.previous, sha256Hex(lines)].join('\n')).toString('hex');
    if (!sameDigest(expected, this.trailers.get('x-amz-trailer-signature') ?? '')) throw signatureMismatch();
  }
}

/** The checksum sent, in its header or the trailer, against the one computed. */
async function checkChecksum(expected: ExpectedChecksum | undefined, computed: RunningChecksum | null, trailers: Map<string, string>): Promise<void> {
  if (!expected || !computed) return;
  const sent = expected.value ?? trailers.get(`x-amz-checksum-${expected.algorithm}`);
  if (sent === undefined) throw invalidRequest(`The x-amz-checksum-${expected.algorithm} value is missing`);
  if (!sameDigest(sent, await computed.digest())) throw badDigest(expected.algorithm);
}

/**
 * A plain body, passed on as it comes but for its last piece, checked when it
 * ends: its SHA-256 when the signature signed it, its checksum when a header
 * gave one. The last piece goes once both match.
 */
export class PlainBodyChecker extends HeldBackTransform {
  private readonly hash: ReturnType<typeof createHash> | null;
  private readonly checksum: RunningChecksum | null;

  constructor(private readonly options: { sha256?: string; checksum?: ExpectedChecksum }) {
    super();
    this.hash = options.sha256 ? createHash('sha256') : null;
    this.checksum = options.checksum ? runningChecksum(options.checksum.algorithm) : null;
  }

  _transform(data: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.hash?.update(data);
    this.checksum?.update(data);
    this.hold(data);
    done();
  }

  _flush(done: TransformCallback): void {
    const sha256 = this.hash?.digest('hex');
    if (this.options.sha256 && sha256 !== this.options.sha256) {
      done(new S3Error(400, 'XAmzContentSHA256Mismatch', "The provided 'x-amz-content-sha256' header does not match what was computed."));
      return;
    }
    checkChecksum(this.options.checksum, this.checksum, new Map()).then(
      () => {
        this.releaseHeld();
        done();
      },
      (error: unknown) => done(error as Error),
    );
  }
}

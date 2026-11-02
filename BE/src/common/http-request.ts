import type { IncomingMessage } from 'node:http';

/** A header's value, the first when it came more than once. */
export const single = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/** The request's path and query: an absolute target, as a proxy may send one, without its scheme and host; "*" is the root. */
export function originForm(target: string | undefined): string {
  if (target?.startsWith('/')) return target;
  try {
    const url = new URL(target ?? '');
    return `${url.pathname}${url.search}`;
  } catch {
    return '/';
  }
}

/** How a server refuses a body it won't read whole, in its own words. */
export interface BodyRefusals {
  /** A body past the limit, declared or sent. */
  tooLarge(limit: number): Error;
  /** A client gone before its request ended. */
  incomplete(): Error;
}

/**
 * The request's body, whole, `limit` bytes at most. One that declares more is
 * refused before a byte is read; one that sends more, at the byte past it,
 * and the rest isn't read: the answer then closes the connection, and a
 * client still sending gets it. A client gone before its body ended is
 * refused as incomplete, in the server's words, not as a failure of its own.
 */
export function readBody(request: IncomingMessage, limit: number, refuse: BodyRefusals): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (Number(single(request.headers['content-length']) ?? 0) > limit) return reject(refuse.tooLarge(limit));
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) return void chunks.push(chunk);
      request.off('data', onData);
      request.pause();
      reject(refuse.tooLarge(limit));
    };
    request.on('data', onData);
    request.once('end', () => resolve(Buffer.concat(chunks)));
    // A client gone mid-body comes as Node's "aborted" error, before the close.
    request.once('error', (error: NodeJS.ErrnoException) => reject(error.code === 'ECONNRESET' && !request.complete ? refuse.incomplete() : error));
    request.once('close', () => request.complete || reject(refuse.incomplete()));
  });
}

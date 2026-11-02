import { IncomingMessage, Server, createServer, request as httpRequest } from 'node:http';
import { AddressInfo } from 'node:net';
import { BodyRefusals, originForm, readBody, single } from './http-request';

class Refused extends Error {}

const REFUSALS: BodyRefusals = {
  tooLarge: (limit) => new Refused(`over ${limit}`),
  incomplete: () => new Refused('gone'),
};

describe('a request', () => {
  let server: Server;
  let port: number;
  /** What the server's reader gave the last request: its body, or its refusal's message. */
  let read: Promise<string>;

  beforeAll(async () => {
    server = createServer((request: IncomingMessage, response) => {
      read = readBody(request, 1024, REFUSALS).then(
        (body) => `body ${body.length}`,
        (error: Error) => `refused ${error.message}`,
      );
      void read.then((outcome) => response.writeHead(outcome.startsWith('body') ? 200 : 413, { connection: 'close' }).end(outcome));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  /** Sends chunks one after another, as a client that doesn't say its length does; resolves with the answer, or how the request ended. */
  function send(chunks: Buffer[], headers: Record<string, string> = {}): Promise<string> {
    return new Promise((resolve) => {
      const request = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/', headers }, (response) => {
        let text = '';
        response.on('data', (chunk: Buffer) => (text += chunk.toString()));
        response.on('end', () => resolve(`${response.statusCode} ${text}`));
      });
      request.on('error', () => undefined);
      for (const chunk of chunks) request.write(chunk);
      request.end();
    });
  }

  it('is read whole, up to the limit', async () => {
    expect(await send([Buffer.alloc(1000), Buffer.alloc(24)])).toBe('200 body 1024');
    expect(await send([])).toBe('200 body 0');
  });

  it("is refused before a byte is read when it declares more than the limit, and at the byte past it when it doesn't say", async () => {
    expect(await send([], { 'content-length': '1025' })).toBe('413 refused over 1024');
    // The client is still sending as the answer comes: it gets the refusal.
    expect(await send(Array.from({ length: 64 }, () => Buffer.alloc(64 * 1024, 1)))).toBe('413 refused over 1024');
  });

  it('is refused as incomplete when its client goes before it ends', async () => {
    const request = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'content-length': '100' } });
    request.on('error', () => undefined);
    request.write(Buffer.alloc(10));
    await new Promise((resolve) => setTimeout(resolve, 50));
    request.destroy();
    expect(await read).toBe('refused gone');
  });
});

describe('originForm', () => {
  it('keeps a path and its query, and takes them from an absolute target, as a proxy may send one', () => {
    expect(originForm('/a/b?c=d')).toBe('/a/b?c=d');
    expect(originForm('http://host.example/a%2Fb?c=d')).toBe('/a%2Fb?c=d');
    expect(originForm('*')).toBe('/');
    expect(originForm(undefined)).toBe('/');
  });
});

describe('single', () => {
  it("gives a header's first value when it came more than once", () => {
    expect(single(['a', 'b'])).toBe('a');
    expect(single('a')).toBe('a');
    expect(single(undefined)).toBeUndefined();
  });
});

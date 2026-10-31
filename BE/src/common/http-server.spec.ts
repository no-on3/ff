import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { KEEP_ALIVE_TIMEOUT_MS, closeHttp, listenHttp } from './http-server';

/** One request on a fresh connection; the raw answer's head. */
async function head(port: number): Promise<string> {
  const socket = connect(port, '127.0.0.1');
  socket.write('GET / HTTP/1.1\r\nHost: test\r\n\r\n');
  let got = '';
  for await (const chunk of socket) {
    got += String(chunk);
    if (got.includes('\r\n\r\n')) break;
  }
  socket.destroy();
  return got;
}

describe('listenHttp', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
  });
  const server = () => {
    const s = createServer((_request, response) => response.end('ok'));
    servers.push(s);
    return s;
  };

  it("keeps an idle connection longer than the proxies in front keep theirs (Caddy's 2 minutes), and says so to clients", async () => {
    const { port } = await listenHttp(server(), 0, '127.0.0.1');
    expect(KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThan(120_000);
    // Without it, Node.js answers "timeout=5" and closes the connection after 5 seconds.
    expect(await head(port)).toMatch(/\r\nKeep-Alive: timeout=130\r\n/i);
  });

  it('resolves with the address it is bound to, and leaves no error listener behind', async () => {
    const s = server();
    const address = await listenHttp(s, 0, '127.0.0.1');
    expect(address.port).toBeGreaterThan(0);
    expect(s.listenerCount('error')).toBe(0);
  });

  it('closes as soon as the requests under way are answered, not after the keep-alive', async () => {
    const s = createServer((_request, response) => setTimeout(() => response.end('ok'), 300));
    const { port } = await listenHttp(s, 0, '127.0.0.1');
    // A client that keeps its connection open, as a proxy does.
    const socket = connect(port, '127.0.0.1');
    let got = '';
    socket.on('data', (chunk) => (got += String(chunk)));
    socket.write('GET / HTTP/1.1\r\nHost: test\r\n\r\n');
    await new Promise((resolve) => setTimeout(resolve, 100));

    const closed = await Promise.race([
      closeHttp(s).then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('still open after 3 s'), 3_000)),
    ]);
    socket.destroy();

    expect(closed).toBe('closed');
    // The answer came first, on the connection kept alive, which closeHttp then closed.
    expect(got).toMatch(/^HTTP\/1\.1 200 .*\r\nConnection: keep-alive\r\n/s);
  });

  it('rejects when the port is taken', async () => {
    const { port } = await listenHttp(server(), 0, '127.0.0.1');
    await expect(listenHttp(createServer(), port, '127.0.0.1')).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});

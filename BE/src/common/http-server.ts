import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * How long an idle keep-alive connection stays open: longer than any proxy in front of FF's servers keeps one idle,
 * Caddy's reverse proxy (2 minutes) and the cluster API's service proxy (90 seconds). When the server closes first,
 * the proxy can send its next request on the closing connection, and a POST, which it never retries, fails as a 502
 * or an EOF. Node.js's own default is 5 seconds.
 */
export const KEEP_ALIVE_TIMEOUT_MS = 130_000;

/** Applies the keep-alive rule to a server made elsewhere, as Nest makes the API's. */
export function keepIdleConnections(server: Server): Server {
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  return server;
}

/**
 * Stops taking connections and resolves once the requests under way are answered. A connection whose request ends
 * after this would stay open for the keep-alive above, and the close with it: each one is closed as it goes idle.
 */
export async function closeHttp(server: Server): Promise<void> {
  const sweep = setInterval(() => server.closeIdleConnections(), 100);
  try {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } finally {
    clearInterval(sweep);
  }
}

/** Listens with the keep-alive rule; resolves with the address once bound, rejects on the first error (a port taken). */
export async function listenHttp(server: Server, port: number, host?: string): Promise<AddressInfo> {
  keepIdleConnections(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server.address() as AddressInfo;
}

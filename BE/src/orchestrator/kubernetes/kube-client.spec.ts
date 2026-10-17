import * as fs from 'node:fs';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { KubeApiError, KubeClient, KubeRequestTimeoutError } from './kube-client';

interface Captured {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A local fake API server: records requests, answers with the handler's reply. */
async function fakeApiServer(reply: (req: Captured) => { status: number; body?: unknown; delayMs?: number }) {
  const captured: Captured[] = [];
  const pendingReplies = new Set<NodeJS.Timeout>();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const request = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
      captured.push(request);
      const { status, body: out, delayMs } = reply(request);
      const timer = setTimeout(() => {
        pendingReplies.delete(timer);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(out === undefined ? '' : JSON.stringify(out));
      }, delayMs ?? 0);
      pendingReplies.add(timer);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    captured,
    // Delayed replies the client gave up on must not outlive the test.
    close: () => {
      pendingReplies.forEach(clearTimeout);
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('KubeClient', () => {
  let tmp: string;
  let tokenFile: string;
  const servers: Array<{ close: () => Promise<void> }> = [];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-kube-client-'));
    tokenFile = path.join(tmp, 'token');
    fs.writeFileSync(tokenFile, 'token-one\n');
  });

  afterEach(async () => {
    while (servers.length) await servers.pop()!.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function setup(reply: Parameters<typeof fakeApiServer>[0], options: Partial<ConstructorParameters<typeof KubeClient>[0]> = {}) {
    const server = await fakeApiServer(reply);
    servers.push(server);
    return { server, client: new KubeClient({ server: server.url, tokenFile, ...options }) };
  }

  it('applies objects with server-side apply as the ff-controller field manager', async () => {
    const { server, client } = await setup(() => ({ status: 200, body: { kind: 'ConfigMap' } }));

    await client.apply('/api/v1/namespaces/ff-t-a/configmaps/c', { kind: 'ConfigMap', data: { a: 'b' } });

    const [req] = server.captured;
    expect(req.method).toBe('PATCH');
    expect(req.url).toBe('/api/v1/namespaces/ff-t-a/configmaps/c?fieldManager=ff-controller&force=true');
    expect(req.headers['content-type']).toBe('application/apply-patch+yaml');
    expect(req.headers.authorization).toBe('Bearer token-one');
    expect(JSON.parse(req.body)).toEqual({ kind: 'ConfigMap', data: { a: 'b' } });
  });

  it('returns null for missing objects and the parsed object otherwise', async () => {
    const { client } = await setup((req) =>
      req.url.endsWith('/missing') ? { status: 404, body: { kind: 'Status', reason: 'NotFound' } } : { status: 200, body: { ok: 1 } },
    );

    await expect(client.get('/x/missing')).resolves.toBeNull();
    await expect(client.get('/x/present')).resolves.toEqual({ ok: 1 });
  });

  it('turns Status errors into KubeApiError with status, reason and message', async () => {
    const { client } = await setup(() => ({
      status: 403,
      body: { kind: 'Status', reason: 'Forbidden', message: 'ff-controller may only manage ff-t-* namespaces' },
    }));

    const error = await client.get('/x').catch((err) => err);

    expect(error).toBeInstanceOf(KubeApiError);
    expect(error).toMatchObject({ status: 403, reason: 'Forbidden', message: 'ff-controller may only manage ff-t-* namespaces' });
  });

  it('deletes with background propagation and reports whether the object existed', async () => {
    const { server, client } = await setup((req) => (req.url.includes('/gone') ? { status: 404 } : { status: 200, body: { kind: 'Status' } }));

    await expect(client.delete('/x/present')).resolves.toBe(true);
    await expect(client.delete('/x/gone')).resolves.toBe(false);
    expect(server.captured[0].url).toBe('/x/present?propagationPolicy=Background');
  });

  it('deletes collections and lists by label selector', async () => {
    const { server, client } = await setup((req) => (req.method === 'GET' ? { status: 200, body: { items: [{ a: 1 }] } } : { status: 200, body: {} }));

    await client.deleteCollection('/api/v1/namespaces/n/configmaps', 'ff.dev/function-id=abc');
    const items = await client.list('/api/v1/namespaces/n/pods', 'ff.dev/function-id=abc');

    expect(server.captured[0]).toMatchObject({ method: 'DELETE', url: '/api/v1/namespaces/n/configmaps?labelSelector=ff.dev%2Ffunction-id%3Dabc' });
    expect(items).toEqual([{ a: 1 }]);
  });

  it('scales through the deployment scale subresource with a merge patch', async () => {
    const { server, client } = await setup(() => ({ status: 200, body: {} }));

    await client.scaleDeployment('ff-t-a', 'fn-1', 3);

    expect(server.captured[0]).toMatchObject({
      method: 'PATCH',
      url: '/apis/apps/v1/namespaces/ff-t-a/deployments/fn-1/scale?fieldManager=ff-scaler',
      body: JSON.stringify({ spec: { replicas: 3 } }),
    });
    expect(server.captured[0].headers['content-type']).toBe('application/merge-patch+json');
  });

  it('re-reads the token file after its TTL, so rotated ServiceAccount tokens are picked up', async () => {
    const { server, client } = await setup(() => ({ status: 200, body: {} }), { tokenTtlMs: 0 });

    await client.get('/a');
    fs.writeFileSync(tokenFile, 'token-two\n');
    await client.get('/b');

    expect(server.captured.map((r) => r.headers.authorization)).toEqual(['Bearer token-one', 'Bearer token-two']);
  });

  it('fails requests that exceed their timeout with KubeRequestTimeoutError, so callers can tell a timeout apart', async () => {
    const { client } = await setup(() => ({ status: 200, body: {}, delayMs: 2000 }));

    const error = await client.request('POST', '/slow', { timeoutMs: 100 }).catch((err) => err);

    expect(error).toBeInstanceOf(KubeRequestTimeoutError);
    expect(error).toMatchObject({ timeoutMs: 100, message: 'Kubernetes API request timed out after 100 ms: POST /slow' });
  });

  it('does not report other failures as timeouts', async () => {
    const { server } = await setup(() => ({ status: 200 }));
    const url = server.url;
    await server.close(); // nothing listens there any more

    const error = await new KubeClient({ server: url, token: 't' }).request('GET', '/x').catch((err) => err);

    expect(error).toMatchObject({ code: 'ECONNREFUSED' });
    expect(error).not.toBeInstanceOf(KubeRequestTimeoutError);
  });

  it('rejects unsupported URL schemes', () => {
    expect(() => new KubeClient({ server: 'ftp://example' })).toThrow('Unsupported Kubernetes API URL');
  });
});

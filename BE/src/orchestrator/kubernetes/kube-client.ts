/**
 * Minimal Kubernetes API client: just what the FF driver needs. Authenticates
 * with a ServiceAccount bearer token (re-read periodically, because projected
 * tokens rotate) and verifies the API server with its CA. Zero dependencies.
 * Plain http:// servers are accepted for tests only.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';

export const FIELD_MANAGER = 'ff-controller';

export interface KubeClientOptions {
  server: string;
  token?: string;
  tokenFile?: string;
  ca?: string;
  caFile?: string;
  /** How long a token read from tokenFile is reused. */
  tokenTtlMs?: number;
  requestTimeoutMs?: number;
}

export interface KubeResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface RequestOptions {
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** A non-2xx answer from the API server, parsed from its Status object when possible. */
export class KubeApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'KubeApiError';
  }
}

/** No answer within the request's timeout: the request was abandoned. */
export class KubeRequestTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    method: string,
    path: string,
  ) {
    super(`Kubernetes API request timed out after ${timeoutMs} ms: ${method} ${path}`);
    this.name = 'KubeRequestTimeoutError';
  }
}

/** The surface the orchestrator depends on (lets tests substitute a fake). */
export interface KubeApi {
  request(method: string, path: string, options?: RequestOptions): Promise<KubeResponse>;
  apply<T>(path: string, manifest: object): Promise<T>;
  get<T>(path: string): Promise<T | null>;
  delete(path: string): Promise<boolean>;
  deleteCollection(path: string, labelSelector: string): Promise<void>;
  scaleDeployment(namespace: string, name: string, replicas: number): Promise<void>;
  list<T>(path: string, labelSelector: string): Promise<T[]>;
  podLog(namespace: string, pod: string, container: string, tailLines: number): Promise<string>;
}

export const paths = {
  namespace: (name: string) => `/api/v1/namespaces/${name}`,
  core: (ns: string, plural: string, name?: string) => `/api/v1/namespaces/${ns}/${plural}${name ? `/${name}` : ''}`,
  apps: (ns: string, plural: string, name?: string) => `/apis/apps/v1/namespaces/${ns}/${plural}${name ? `/${name}` : ''}`,
  networking: (ns: string, plural: string, name?: string) =>
    `/apis/networking.k8s.io/v1/namespaces/${ns}/${plural}${name ? `/${name}` : ''}`,
  serviceProxy: (ns: string, service: string, port: string, path: string) =>
    `/api/v1/namespaces/${ns}/services/${service}:${port}/proxy${path}`,
};

function toApiError(res: KubeResponse): KubeApiError {
  try {
    const status = JSON.parse(res.body) as { kind?: unknown; reason?: unknown; message?: unknown } | null;
    if (status?.kind === 'Status') {
      const text = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback);
      return new KubeApiError(res.status, text(status.reason, ''), text(status.message, res.body));
    }
  } catch {
    // not JSON
  }
  return new KubeApiError(res.status, '', res.body.slice(0, 500) || `HTTP ${res.status}`);
}

export class KubeClient implements KubeApi {
  private readonly url: URL;
  private readonly agent?: https.Agent;
  private cachedToken?: { value: string; readAt: number };

  constructor(private readonly options: KubeClientOptions) {
    this.url = new URL(options.server);
    if (this.url.protocol === 'https:') {
      const ca = options.ca ?? (options.caFile ? fs.readFileSync(options.caFile, 'utf8') : undefined);
      this.agent = new https.Agent({ ca, keepAlive: true, maxSockets: 16 });
    } else if (this.url.protocol !== 'http:') {
      throw new Error(`Unsupported Kubernetes API URL "${options.server}"`);
    }
  }

  private token(): string | undefined {
    if (this.options.token) return this.options.token;
    if (!this.options.tokenFile) return undefined;
    const now = Date.now();
    const ttl = this.options.tokenTtlMs ?? 60_000;
    if (!this.cachedToken || now - this.cachedToken.readAt >= ttl) {
      this.cachedToken = { value: fs.readFileSync(this.options.tokenFile, 'utf8').trim(), readAt: now };
    }
    return this.cachedToken.value;
  }

  request(method: string, path: string, options: RequestOptions = {}): Promise<KubeResponse> {
    const transport = this.url.protocol === 'https:' ? https : http;
    const headers: Record<string, string | number> = { accept: 'application/json', ...options.headers };
    const token = this.token();
    if (token) headers.authorization = `Bearer ${token}`;
    if (options.body !== undefined) {
      headers['content-type'] = options.contentType ?? 'application/json';
      headers['content-length'] = Buffer.byteLength(options.body);
    }
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? 15_000;
    return new Promise((resolve, reject) => {
      const req = transport.request(
        {
          protocol: this.url.protocol,
          hostname: this.url.hostname,
          port: this.url.port,
          method,
          path: this.url.pathname.replace(/\/$/, '') + path,
          headers,
          agent: this.agent,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
          );
          res.on('error', reject);
        },
      );
      req.setTimeout(timeoutMs, () => req.destroy(new KubeRequestTimeoutError(timeoutMs, method, path)));
      req.on('error', reject);
      if (options.body !== undefined) req.write(options.body);
      req.end();
    });
  }

  private async json<T>(method: string, path: string, options?: RequestOptions, notFoundIsNull = false): Promise<T | null> {
    const res = await this.request(method, path, options);
    if (res.status === 404 && notFoundIsNull) return null;
    if (res.status < 200 || res.status >= 300) throw toApiError(res);
    return res.body ? (JSON.parse(res.body) as T) : null;
  }

  /** Server-side apply: create or update, idempotent, FF owns the fields it sets. */
  async apply<T>(path: string, manifest: object): Promise<T> {
    const result = await this.json<T>('PATCH', `${path}?fieldManager=${FIELD_MANAGER}&force=true`, {
      body: JSON.stringify(manifest),
      contentType: 'application/apply-patch+yaml',
    });
    return result as T;
  }

  get<T>(path: string): Promise<T | null> {
    return this.json<T>('GET', path, undefined, true);
  }

  /** Returns false if the object did not exist. */
  async delete(path: string): Promise<boolean> {
    return (await this.json('DELETE', `${path}?propagationPolicy=Background`, undefined, true)) !== null;
  }

  async deleteCollection(path: string, labelSelector: string): Promise<void> {
    await this.json('DELETE', `${path}?labelSelector=${encodeURIComponent(labelSelector)}`);
  }

  async scaleDeployment(namespace: string, name: string, replicas: number): Promise<void> {
    await this.json('PATCH', `${paths.apps(namespace, 'deployments', name)}/scale?fieldManager=ff-scaler`, {
      body: JSON.stringify({ spec: { replicas } }),
      contentType: 'application/merge-patch+json',
    });
  }

  async list<T>(path: string, labelSelector: string): Promise<T[]> {
    const list = await this.json<{ items?: T[] }>('GET', `${path}?labelSelector=${encodeURIComponent(labelSelector)}`);
    return list?.items ?? [];
  }

  /** Best effort: diagnostics must never fail the caller. */
  async podLog(namespace: string, pod: string, container: string, tailLines: number): Promise<string> {
    try {
      const res = await this.request('GET', `${paths.core(namespace, 'pods', pod)}/log?container=${container}&tailLines=${tailLines}`);
      return res.status === 200 ? res.body : '';
    } catch {
      return '';
    }
  }
}

import { request } from 'node:https';
import { CacheSettings } from '../config/configuration';
import { SERVER_NAME } from './cache-names';

/** Injection token for the server of customers' caches; null when FF has none (no FF_CACHE_HOST). */
export const CACHE_SERVER = Symbol('CACHE_SERVER');

/** What the backend says a cache is: its port, its memory, its password's SHA-256, and whether its user may log in. */
export interface CacheSpec {
  port: number;
  memoryMb: number;
  passwordSha256: string;
  enabled: boolean;
}

/** A cache's measures now, as ElastiCache names its metrics. */
export interface CacheUse {
  bytesUsedForCache: number;
  currConnections: number;
  cacheHits: number;
  cacheMisses: number;
  evictions: number;
}

/**
 * What the backend does on the server of customers' caches (ADR 0013), through its agent: each cache a Valkey process
 * of its own, named fc- and 24 hexadecimal characters.
 */
export interface CacheServer {
  /** Made, or changed: a new port or memory starts it again, its keys gone; a new password or switch applies at once. */
  put(name: string, spec: CacheSpec): Promise<void>;
  /** Gone, its process stopped; nothing for one that doesn't exist. */
  remove(name: string): Promise<void>;
  /** The measures of each of these caches the server runs now. */
  use(names: string[]): Promise<Map<string, CacheUse>>;
}

/** A cache's view as the agent answers it. */
interface AgentView {
  name: string;
  running: boolean;
  measures: (CacheUse & { uptimeSeconds: number }) | null;
}

/** A name the backend made, checked before it goes into a path. */
function checked(name: string): string {
  if (!SERVER_NAME.test(name)) throw new Error(`Not a cache name of FF's: ${JSON.stringify(name)}`);
  return name;
}

/** The server, through its agent's API, over HTTPS, the certificate checked: against the server's CA when it isn't a public one. */
export class AgentCacheServer implements CacheServer {
  constructor(private readonly settings: Pick<CacheSettings, 'agentUrl' | 'agentToken' | 'ca'>) {}

  async put(name: string, spec: CacheSpec): Promise<void> {
    await this.call('PUT', `/caches/${checked(name)}`, spec, [200, 201]);
  }

  async remove(name: string): Promise<void> {
    await this.call('DELETE', `/caches/${checked(name)}`, undefined, [204, 404]);
  }

  async use(names: string[]): Promise<Map<string, CacheUse>> {
    const wanted = new Set(names);
    const views = (await this.call('GET', '/caches', undefined, [200])) as AgentView[];
    const use = new Map<string, CacheUse>();
    for (const view of views) {
      if (!wanted.has(view.name) || !view.measures) continue;
      const { bytesUsedForCache, currConnections, cacheHits, cacheMisses, evictions } = view.measures;
      use.set(view.name, { bytesUsedForCache, currConnections, cacheHits, cacheMisses, evictions });
    }
    return use;
  }

  /** One request to the agent; its JSON answer, or an error naming its status and message. */
  private call(method: string, path: string, body: unknown, expected: number[]): Promise<unknown> {
    const url = new URL(path, this.settings.agentUrl);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const sent = request(
        url,
        {
          method,
          headers: {
            authorization: `Bearer ${this.settings.agentToken}`,
            ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
          },
          ...(this.settings.ca ? { ca: this.settings.ca } : {}),
          timeout: 15_000,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (!expected.includes(response.statusCode ?? 0)) {
              let message = text;
              try {
                message = (JSON.parse(text) as { message?: string }).message ?? text;
              } catch {
                // not JSON: its text
              }
              return reject(new Error(`the cache server's agent answered ${response.statusCode} to ${method} ${path}: ${message}`));
            }
            try {
              resolve(text === '' ? undefined : JSON.parse(text));
            } catch {
              reject(new Error(`the cache server's agent answered ${method} ${path} with something other than JSON`));
            }
          });
          response.on('error', reject);
        },
      );
      sent.on('timeout', () => sent.destroy(new Error(`the cache server's agent didn't answer ${method} ${path} within 15 s`)));
      sent.on('error', reject);
      sent.end(payload);
    });
  }
}

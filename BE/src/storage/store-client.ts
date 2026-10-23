import { Agent as HttpAgent, ClientRequest, IncomingMessage, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { signedForStore } from './sigv4';

/** The store behind the front door, and FF's credentials there: the only ones it knows. */
export interface StoreSettings {
  /** Its S3 endpoint, such as http://localhost:9003. */
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** The region FF's own signatures to the store name: S3-compatible stores accept any. */
const STORE_REGION = 'us-east-1';

/** How long the store may stay silent on a request before it is given up. */
const STORE_TIMEOUT_MS = 120_000;

/** A request to the store under way: its body still to write, and its answer to come. */
export interface StoreRequest {
  request: ClientRequest;
  response: Promise<IncomingMessage>;
}

/**
 * FF's requests to the store, each signed with FF's credentials and an
 * unsigned body, which the front door has checked itself, over connections
 * kept alive between requests.
 */
export class StoreClient {
  private readonly url: URL;
  private readonly agent: HttpAgent;

  constructor(private readonly settings: StoreSettings) {
    this.url = new URL(settings.endpoint);
    const options = { keepAlive: true, maxSockets: 128 };
    this.agent = this.url.protocol === 'https:' ? new HttpsAgent(options) : new HttpAgent(options);
  }

  /** The store's host, as its answers may name it. */
  get origin(): string {
    return this.url.origin;
  }

  /** A request to the store: the path and query as they go there, encoded; the headers to send, which it signs. */
  send(method: string, rawPath: string, rawQuery: string, headers: Record<string, string>): StoreRequest {
    const signed = signedForStore(
      { method, host: this.url.host, rawPath, rawQuery, headers },
      { accessKeyId: this.settings.accessKeyId, secretAccessKey: this.settings.secretAccessKey, region: STORE_REGION },
      new Date(),
    );
    const send = this.url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = send({
      protocol: this.url.protocol,
      hostname: this.url.hostname,
      port: this.url.port,
      method,
      path: rawQuery ? `${rawPath}?${rawQuery}` : rawPath,
      headers: signed,
      agent: this.agent,
    });
    request.setTimeout(STORE_TIMEOUT_MS, () => request.destroy(new Error(`The store did not answer within ${STORE_TIMEOUT_MS / 1000} s`)));
    const response = new Promise<IncomingMessage>((resolve, reject) => {
      request.once('response', resolve);
      request.once('error', reject);
    });
    // Its answer is awaited where it is used; a request refused before then rejects with nobody waiting yet.
    response.catch(() => undefined);
    return { request, response };
  }

  close(): void {
    this.agent.destroy();
  }
}

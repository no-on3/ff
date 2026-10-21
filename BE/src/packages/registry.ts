import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

/** The media types of a code image: an OCI image manifest, its configuration, its gzip-compressed layer. */
export const MEDIA_TYPES = {
  manifest: 'application/vnd.oci.image.manifest.v1+json',
  config: 'application/vnd.oci.image.config.v1+json',
  layer: 'application/vnd.oci.image.layer.v1.tar+gzip',
} as const;

/** What a registry answered when it refused, or no answer: the push failed, the platform's fault. */
export class RegistryError extends Error {}

/** A blob to push: its digest and size, and its bytes, which a retry reads again. */
export interface Blob {
  digest: string;
  size: number;
  bytes: () => Readable | Buffer;
}

/** A file on disk as a blob. */
export const fileBlob = (file: string, digest: string, size: number): Blob => ({ digest, size, bytes: () => createReadStream(file) });

/** Bytes in memory as a blob, its digest computed. */
export function bytesBlob(bytes: Buffer): Blob {
  return { digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, size: bytes.length, bytes: () => bytes };
}

const ATTEMPTS = 3;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The OCI distribution API, as far as code images need it (ADR 0003): push a
 * blob in one request unless the registry has it, push a manifest, ask for one,
 * delete one. Over HTTP or HTTPS, anonymous or with a login (Basic); each
 * request is tried three times when the registry fails or can't be reached.
 */
export class Registry {
  private readonly authorization?: string;

  constructor(
    /** The registry's base URL, such as http://127.0.0.1:5056. */
    private readonly base: string,
    credentials?: { username: string; password: string },
    private readonly retryPauseMs = 500,
  ) {
    if (credentials?.username) this.authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
  }

  /** A request, tried again when the registry answers 5xx or doesn't answer; `body` is made again for each try. */
  private async request(
    method: string,
    url: string,
    headers: Record<string, string> = {},
    body?: () => Readable | Buffer,
    attempts = ATTEMPTS,
  ): Promise<Response> {
    let failure: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const payload = body?.();
        const response = await fetch(new URL(url, this.base), {
          method,
          headers: { ...(this.authorization ? { authorization: this.authorization } : {}), ...headers },
          ...(payload === undefined
            ? {}
            : Buffer.isBuffer(payload)
              ? { body: new Uint8Array(payload) }
              : { body: Readable.toWeb(payload) as ReadableStream, duplex: 'half' as const }),
        });
        if (response.status < 500) return response;
        failure = new RegistryError(`${method} ${new URL(url, this.base).pathname} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
      } catch (error) {
        failure = new RegistryError(`${method} ${new URL(url, this.base).pathname} got no answer: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (attempt < attempts) await pause(this.retryPauseMs * attempt);
    }
    throw failure;
  }

  private static async refused(response: Response, what: string): Promise<never> {
    throw new RegistryError(`The registry refused ${what}: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }

  /** Whether the repository has the blob. */
  async hasBlob(repository: string, digest: string): Promise<boolean> {
    const response = await this.request('HEAD', `/v2/${repository}/blobs/${digest}`);
    if (response.status === 200) return true;
    if (response.status === 404) return false;
    return Registry.refused(response, `a check of blob ${digest}`);
  }

  /**
   * Pushes the blob, unless the repository has it: an upload started, then its
   * bytes in one request. An upload that fails is started again, as a registry
   * may forget the one a failed request was part of.
   */
  async pushBlob(repository: string, blob: Blob): Promise<void> {
    if (await this.hasBlob(repository, blob.digest)) return;
    let failure: unknown;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const started = await this.request('POST', `/v2/${repository}/blobs/uploads/`, { 'content-length': '0' }, undefined, 1);
        if (started.status !== 202) return Registry.refused(started, `an upload to ${repository}`);
        const location = new URL(started.headers.get('location') ?? '', this.base);
        location.searchParams.set('digest', blob.digest);
        const done = await this.request('PUT', location.toString(), { 'content-type': 'application/octet-stream' }, blob.bytes, 1);
        if (done.status !== 201) return Registry.refused(done, `blob ${blob.digest}`);
        return;
      } catch (error) {
        // A refusal is final; a failure or no answer starts the upload again.
        if (!(error instanceof RegistryError) || error.message.startsWith('The registry refused')) throw error;
        failure = error;
      }
      if (attempt < ATTEMPTS) await pause(this.retryPauseMs * attempt);
    }
    throw failure;
  }

  /** Pushes a manifest under a tag; answers its digest. */
  async pushManifest(repository: string, tag: string, manifest: Buffer): Promise<string> {
    const response = await this.request('PUT', `/v2/${repository}/manifests/${tag}`, { 'content-type': MEDIA_TYPES.manifest }, () => manifest);
    if (response.status !== 201) return Registry.refused(response, `the manifest ${repository}:${tag}`);
    return `sha256:${createHash('sha256').update(manifest).digest('hex')}`;
  }

  /** Whether the repository has the manifest of this digest. */
  async hasManifest(repository: string, digest: string): Promise<boolean> {
    const response = await this.request('HEAD', `/v2/${repository}/manifests/${digest}`, { accept: MEDIA_TYPES.manifest });
    if (response.status === 200) return true;
    if (response.status === 404) return false;
    return Registry.refused(response, `a check of manifest ${digest}`);
  }

  /** Deletes the manifest of this digest, which the registry's garbage collection follows; one already gone is no error. */
  async deleteManifest(repository: string, digest: string): Promise<void> {
    const response = await this.request('DELETE', `/v2/${repository}/manifests/${digest}`);
    if (response.status !== 202 && response.status !== 404) return Registry.refused(response, `the deletion of ${repository}@${digest}`);
  }
}

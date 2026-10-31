import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { AccountStatus } from '../accounts/entities/account.entity';
import { describeError } from '../common/describe-error';
import { closeHttp, listenHttp } from '../common/http-server';
import { originForm } from '../storage/front-door';
import { StorageDirectory } from '../storage/storage-directory.service';
import { EmailIdentitiesService } from './email-identities.service';
import { SesError, accessDenied, badRequest, internalFailure, missingAuthenticationToken, requestTooLarge, unrecognizedClient } from './ses-error';
import { SesOperations } from './ses-operations';
import { checkSesSignature, readSesSignature } from './ses-signature';

/** The most a request's body holds: a raw message of 10 MB, SES's, in base64, and its JSON around it. */
const MAX_BODY_BYTES = 14 * 1024 * 1024;

const single = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/** The request's body, whole, `limit` bytes at most: past it, what is left isn't read, and the answer closes the connection. */
function bodyOf(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (Number(single(request.headers['content-length']) ?? 0) > limit) return reject(requestTooLarge(limit));
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) return void chunks.push(chunk);
      request.off('data', onData);
      request.pause();
      reject(requestTooLarge(limit));
    };
    request.on('data', onData);
    request.once('end', () => resolve(Buffer.concat(chunks)));
    request.once('error', reject);
    request.once('close', () => request.complete || reject(badRequest('The client went before its request ended.')));
  });
}

/** A page of the address's link: a sentence in French, then in English. */
const page = (title: string, french: string, english: string): string =>
  `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title></head>` +
  `<body style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.25rem">${title}</h1><p>${french}</p><p lang="en">${english}</p></body></html>`;
const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/**
 * The SES endpoint (ADR 0012): a server of its own, on FF_SES_PORT, which
 * answers AWS's SDKs and CLI as Amazon SES v2 does, in its REST API and JSON,
 * with only the endpoint changed (AWS_ENDPOINT_URL_SESV2): signed with
 * Signature Version 4 for the service ses, the path escaped twice, by one of
 * FF's access keys that reaches the whole account, its own or a function's,
 * a read-only one only reading. Its account must be active. Each answer
 * carries its request ID, x-amzn-RequestId; each error its name in
 * x-amzn-ErrorType. GET /verify, unsigned, is the link FF e-mails an address
 * to prove it.
 */
@Injectable()
export class SesFrontDoor implements OnModuleDestroy {
  private readonly logger = new Logger(SesFrontDoor.name);
  private server?: Server;
  /** Once the server stops, each answer closes its connection: a client kept alive doesn't hold the stop up. */
  private stopping = false;

  constructor(
    private readonly directory: StorageDirectory,
    private readonly operations: SesOperations,
    private readonly identities: EmailIdentitiesService,
  ) {}

  /** Starts answering on the port; main.ts calls it once the API listens. Port 0 takes any free one, as the tests do. */
  async listen(port: number, host?: string): Promise<AddressInfo> {
    const server = createServer((request, response) => void this.serve(request, response));
    const address = await listenHttp(server, port, host);
    this.server = server;
    return address;
  }

  /** Stops taking requests, and waits for those under way. */
  async onModuleDestroy(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.stopping = true;
    if (server) await closeHttp(server);
  }

  /** Answers one request; never throws, as nothing would catch it. */
  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const id = randomUUID();
    try {
      const target = originForm(request.url);
      const at = target.indexOf('?');
      const rawPath = at < 0 ? target : target.slice(0, at);
      const rawQuery = at < 0 ? '' : target.slice(at + 1);
      if (request.method === 'GET' && rawPath === '/verify') return await this.verify(response, id, new URLSearchParams(rawQuery));
      this.reply(request, response, id, 200, await this.answer(request, rawPath, rawQuery));
    } catch (error) {
      if (!(error instanceof SesError)) this.logger.error(`An SES request failed (request ${id}): ${describeError(error)}`, error instanceof Error ? error.stack : undefined);
      const refusal = error instanceof SesError ? error : internalFailure();
      this.reply(request, response, id, refusal.status, refusal.document(), { 'x-amzn-errortype': refusal.errorType() });
    }
  }

  /** The answer, as JSON, unless the client went; a body not read is not waited for. */
  private reply(request: IncomingMessage, response: ServerResponse, id: string, status: number, document: unknown, headers: Record<string, string> = {}): void {
    if (response.headersSent || response.destroyed) return;
    const body = JSON.stringify(document);
    response.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'x-amzn-requestid': id,
      ...(request.complete && !this.stopping ? {} : { connection: 'close' }),
      ...headers,
    });
    response.end(body);
  }

  /** The operation's answer, once the request is signed by a key that reaches its account's mail. */
  private async answer(request: IncomingMessage, rawPath: string, rawQuery: string): Promise<unknown> {
    const body = await bodyOf(request, MAX_BODY_BYTES);
    const signature = readSesSignature(request.headers);
    if (!signature) throw missingAuthenticationToken();
    const key = await this.directory.key(signature.accessKeyId);
    if (!key) throw unrecognizedClient();
    const method = request.method ?? 'GET';
    checkSesSignature({ method, rawPath, rawQuery, rawHeaders: request.rawHeaders }, body, signature, key.secret, new Date());
    this.directory.touch(key.id);
    // A key that names buckets or queues reaches those alone, as at the S3 front door and the SQS endpoint.
    if (key.buckets !== null || key.queues !== null) throw accessDenied(`The access key ${key.id} names buckets or queues, and reaches those alone: not the account's mail.`);
    const account = await this.directory.account(key.accountId);
    if (!account || account.status !== AccountStatus.ACTIVE) throw accessDenied(`The account is ${account?.status ?? 'gone'}: its mail answers no key.`);
    let input: Record<string, unknown> = {};
    if (body.length > 0) {
      try {
        input = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      } catch {
        throw badRequest('The request body is not JSON.');
      }
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('The request body must be a JSON object.');
    }
    // The path's segments are matched as sent, each name then decoded, so that an escaped "/" in a name stays in its segment.
    return this.operations.run(
      { method, path: rawPath, query: new URLSearchParams(rawQuery), input },
      { accountId: key.accountId, keyId: key.id, readOnly: key.readOnly, actor: { id: `access_key:${key.id}`, label: `access key ${key.id}` }, ip: request.socket.remoteAddress },
    );
  }

  /** The link FF e-mails an address: followed, it proves the address; a page says so, or that the link is no longer good. */
  private async verify(response: ServerResponse, id: string, query: URLSearchParams): Promise<void> {
    const proved = await this.identities.verifyAddress(query.get('token') ?? '');
    const html = proved
      ? page(
          'Adresse confirmée',
          `L'adresse ${escapeHtml(proved.identity)} est confirmée : le compte FF ${proved.accountId} peut envoyer des e-mails depuis elle, et vers elle.`,
          `The address ${escapeHtml(proved.identity)} is confirmed: the FF account ${proved.accountId} may send e-mail from it, and to it.`,
        )
      : page(
          'Lien expiré',
          "Ce lien ne sert plus : l'adresse est peut-être déjà confirmée. Un nouveau lien se demande depuis la console, ou avec ff email identities verify.",
          'This link is no longer good: the address may be confirmed already. A new link is asked for from the console, or with ff email identities verify.',
        );
    response.writeHead(proved ? 200 : 404, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html), 'x-amzn-requestid': id, 'cache-control': 'no-store' });
    response.end(html);
  }
}

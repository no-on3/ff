import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { IncomingHttpHeaders, Server, createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { SignedRequest } from '../storage/sigv4';
import { SqsError } from './sqs-error';
import { SqsSignature, checkSqsSignature, readSqsSignature } from './sqs-signature';

const KEY = { accessKeyId: 'AKFFAAAAAAAAAAAAAAAA', secretAccessKey: 'a'.repeat(40) };

/** A request as it came: what the checks read. */
interface Captured {
  request: SignedRequest;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

function refusal(check: () => unknown): { type: string; message: string } {
  try {
    check();
  } catch (error) {
    if (error instanceof SqsError) return { type: error.type, message: error.message };
    throw error;
  }
  throw new Error('not refused');
}

describe("SQS's signatures, as AWS's SDK makes them", () => {
  let server: Server;
  let endpoint: string;
  const captured: Captured[] = [];

  beforeAll(async () => {
    // Keeps each request AWS's SDK sends, as it came, and answers as SQS would.
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        captured.push({ request: { method: request.method ?? '', rawPath: request.url ?? '/', rawQuery: '', rawHeaders: request.rawHeaders }, headers: request.headers, body: Buffer.concat(chunks) });
        response.writeHead(200, { 'content-type': 'application/x-amz-json-1.0' }).end(JSON.stringify({ QueueUrl: 'http://localhost:3003/000000000001/orders' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  /** The request AWS's SDK signs and sends for GetQueueUrl, with these credentials. */
  async function signed(credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } = KEY): Promise<Captured> {
    const client = new SQSClient({ endpoint, region: 'tn-tunis-1', credentials, maxAttempts: 1 });
    await client.send(new GetQueueUrlCommand({ QueueName: 'orders' }));
    client.destroy();
    return captured[captured.length - 1];
  }

  it('reads the key, the day and the region signed for, from the Authorization header', async () => {
    const { headers } = await signed();
    const signature = readSqsSignature(headers) as SqsSignature;
    expect(signature).toMatchObject({ accessKeyId: KEY.accessKeyId, region: 'tn-tunis-1' });
    expect(signature.date).toMatch(/^\d{8}$/);
    expect(signature.amzDate.startsWith(signature.date)).toBe(true);
    expect(signature.signedHeaders).toContain('host');
    expect(signature.signedHeaders).toContain('x-amz-target');
  });

  it("accepts a request signed with the key's secret, its body's SHA-256 signed, as SQS's clients sign it", async () => {
    const { request, headers, body } = await signed();
    expect(JSON.parse(body.toString('utf8'))).toEqual({ QueueName: 'orders' });
    expect(() => checkSqsSignature(request, body, readSqsSignature(headers) as SqsSignature, KEY.secretAccessKey, new Date())).not.toThrow();
  });

  it('refuses another secret, or another body than the one signed', async () => {
    const { request, headers, body } = await signed();
    const signature = readSqsSignature(headers) as SqsSignature;
    expect(refusal(() => checkSqsSignature(request, body, signature, 'b'.repeat(40), new Date())).type).toBe('SignatureDoesNotMatch');
    expect(refusal(() => checkSqsSignature(request, Buffer.from('{"QueueName":"payroll"}'), signature, KEY.secretAccessKey, new Date())).type).toBe('SignatureDoesNotMatch');
  });

  it('refuses a signature more than 15 minutes from the request, either way', async () => {
    const { request, headers, body } = await signed();
    const signature = readSqsSignature(headers) as SqsSignature;
    for (const minutes of [16, -16]) {
      const at = new Date(Date.now() + minutes * 60_000);
      expect(refusal(() => checkSqsSignature(request, body, signature, KEY.secretAccessKey, at)).message).toMatch(/^Signature expired: \d{8}T\d{6}Z is more than 15 minutes/);
    }
  });

  it('refuses a signature whose headers leave the host out', async () => {
    const { request, headers, body } = await signed();
    const signature = readSqsSignature(headers) as SqsSignature;
    const hostless = { ...signature, signedHeaders: signature.signedHeaders.filter((name) => name !== 'host') };
    expect(refusal(() => checkSqsSignature(request, body, hostless, KEY.secretAccessKey, new Date())).message).toBe("'Host' must be a 'SignedHeader' in the AWS Authorization.");
  });

  it('finds no signature without an Authorization header', () => {
    expect(readSqsSignature({ 'x-amz-date': '20261023T080000Z' })).toBeNull();
  });

  it('refuses a session token: FF never issues one', async () => {
    const { headers } = await signed({ ...KEY, sessionToken: 'a-token-from-sts' });
    expect(refusal(() => readSqsSignature(headers)).type).toBe('InvalidClientTokenId');
  });

  it("refuses a signature for another service than sqs, or not AWS4-HMAC-SHA256's, or without its parts", async () => {
    const { headers } = await signed();
    const authorization = headers.authorization as string;
    expect(refusal(() => readSqsSignature({ ...headers, authorization: authorization.replace('/sqs/aws4_request', '/s3/aws4_request') }))).toEqual({
      type: 'SignatureDoesNotMatch',
      message: "Credential should be scoped to correct service: 'sqs'.",
    });
    expect(refusal(() => readSqsSignature({ ...headers, authorization: authorization.replace('AWS4-HMAC-SHA256', 'AWS4-ECDSA-P256-SHA256') })).type).toBe('IncompleteSignature');
    expect(refusal(() => readSqsSignature({ ...headers, authorization: 'AWS4-HMAC-SHA256 Credential=AKFF/20261023/tn-tunis-1/sqs/aws4_request' })).type).toBe('IncompleteSignature');
    expect(refusal(() => readSqsSignature({ ...headers, 'x-amz-date': undefined })).type).toBe('IncompleteSignature');
  });
});

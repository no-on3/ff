#!/usr/bin/env node
// A minimal Amazon SES v2 endpoint, Node.js's standard library only, for step 4's spike (the step-4 plan's W-01): SES
// v2's REST API in JSON, AWS Signature Version 4 for the service ses with one key, identities, the account, the
// suppression list and SendEmail kept in memory, its errors as AWS's REST JSON protocol gives them (the error's name in
// x-amzn-ErrorType, a JSON body with its message). What AWS's SDK for JavaScript v3, boto3 and the AWS CLI make of it is
// ses.sh's question; so is how each signs a path whose segment has an escape (an e-mail address's @): it says, in its
// log, whether the signature was made over the path escaped once or twice.
//   PORT=… KEY=AKFF… SECRET=… [REGION=tn-tunis-1] node ses-endpoint.mjs
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const { PORT, KEY, SECRET } = process.env;
const REGION = process.env.REGION ?? 'tn-tunis-1';
const MAX_SKEW_MS = 15 * 60_000;
const asked = {};
const signedPaths = { once: 0, twice: 0 };

const hmac = (key, data) => createHmac('sha256', key).update(data, 'utf8').digest();
const sha256hex = (data) => createHash('sha256').update(data).digest('hex');
/** RFC 3986's escaping, as SigV4 makes it: everything but the unreserved characters. */
const uriEncode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

class SesError extends Error {
  constructor(status, type, message) {
    super(message);
    this.status = status;
    this.type = type;
  }
}
const notFound = (message) => new SesError(404, 'NotFoundException', message);
const badRequest = (message) => new SesError(400, 'BadRequestException', message);

/** The request's signature, checked as AWS checks one; which canonical path it was made over, counted. */
function verify(request, body) {
  const auth = request.headers.authorization ?? '';
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, ?SignedHeaders=([^,]+), ?Signature=([0-9a-f]{64})$/.exec(auth);
  if (!match) throw new SesError(403, 'MissingAuthenticationTokenException', 'Missing Authentication Token');
  const [, key, date, region, service, signedHeaders, signature] = match;
  if (key !== KEY) throw new SesError(403, 'UnrecognizedClientException', 'The security token included in the request is invalid.');
  if (service !== 'ses' || region !== REGION) throw new SesError(403, 'InvalidSignatureException', `Credential should be scoped to a valid region and the service ses, not '${region}/${service}'.`);
  const amzDate = request.headers['x-amz-date'] ?? '';
  const signedAt = Date.parse(`${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`);
  if (!Number.isFinite(signedAt) || Math.abs(Date.now() - signedAt) > MAX_SKEW_MS) throw new SesError(403, 'InvalidSignatureException', 'Signature expired');
  const values = new Map();
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i].toLowerCase();
    const value = request.rawHeaders[i + 1].trim().replace(/\s+/g, ' ');
    values.set(name, values.has(name) ? `${values.get(name)},${value}` : value);
  }
  const names = signedHeaders.split(';');
  const [rawPath, rawQuery = ''] = (request.url ?? '/').split('?');
  const query = rawQuery
    .split('&')
    .filter(Boolean)
    .map((pair) => pair.split('=').map((part) => uriEncode(decodeURIComponent(part.replace(/\+/g, '%20')))))
    .map(([name, value = '']) => [name, value])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${SECRET}`, date), region), service), 'aws4_request');
  const signatureOver = (path) => {
    const canonical = [request.method, path, query, names.map((name) => `${name}:${values.get(name) ?? ''}\n`).join(''), signedHeaders, sha256hex(body)].join('\n');
    return createHmac('sha256', signingKey).update(['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n')).digest('hex');
  };
  // AWS's rule for every service but S3: each segment of the path escaped twice; once, as the client sent it, is S3's.
  const twice = rawPath.split('/').map(uriEncode).join('/');
  if (signatureOver(twice) === signature) signedPaths.twice++;
  else if (signatureOver(rawPath) === signature) signedPaths.once++;
  else throw new SesError(403, 'SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided.');
}

const identities = new Map();
const suppressed = new Map();
const sent = [];
const epochSeconds = (date) => Math.floor(date.getTime() / 1000);

function identityView(identity) {
  return {
    IdentityType: identity.type,
    VerifiedForSendingStatus: identity.verified,
    VerificationStatus: identity.verified ? 'SUCCESS' : 'PENDING',
    FeedbackForwardingStatus: true,
    DkimAttributes:
      identity.type === 'DOMAIN'
        ? { SigningEnabled: true, Status: identity.verified ? 'SUCCESS' : 'PENDING', Tokens: ['ff1'], SigningAttributesOrigin: 'EXTERNAL', CurrentSigningKeyLength: 'RSA_2048_BIT', LastKeyGenerationTimestamp: epochSeconds(identity.createdAt) }
        : undefined,
    MailFromAttributes: { BehaviorOnMxFailure: 'USE_DEFAULT_VALUE', MailFromDomainStatus: 'PENDING' },
    Policies: {},
    Tags: [],
  };
}

/** The operation a request is, SES v2's routes; its answer's status and body. */
function operate(method, path, query, input) {
  const identity = /^\/v2\/email\/identities\/([^/]+)$/.exec(path);
  const suppression = /^\/v2\/email\/suppression\/addresses\/([^/]+)$/.exec(path);
  if (method === 'POST' && path === '/v2/email/identities') {
    asked.CreateEmailIdentity = (asked.CreateEmailIdentity ?? 0) + 1;
    const name = input.EmailIdentity;
    if (typeof name !== 'string' || !name) throw badRequest('EmailIdentity is required');
    if (identities.has(name)) throw new SesError(400, 'AlreadyExistsException', `Email identity ${name} already exist.`);
    const type = name.includes('@') ? 'EMAIL_ADDRESS' : 'DOMAIN';
    const created = { name, type, verified: name.startsWith('verified'), createdAt: new Date() };
    identities.set(name, created);
    const { IdentityType, VerifiedForSendingStatus, DkimAttributes } = identityView(created);
    return [200, { IdentityType, VerifiedForSendingStatus, DkimAttributes }];
  }
  // Today's SDKs list with a POST and a JSON body; older ones, as SES v2's first model had it, with a GET and a query.
  const listing = method === 'POST' && path === '/v2/email/list-identities' ? 'post' : method === 'GET' && path === '/v2/email/identities' ? 'get' : null;
  if (listing) {
    asked[`ListEmailIdentities (${listing})`] = (asked[`ListEmailIdentities (${listing})`] ?? 0) + 1;
    const all = [...identities.values()].map((one) => ({ IdentityType: one.type, IdentityName: one.name, SendingEnabled: one.verified, VerificationStatus: one.verified ? 'SUCCESS' : 'PENDING' }));
    const size = Number((listing === 'post' ? input.PageSize : query.get('PageSize')) ?? 1000);
    const from = Number((listing === 'post' ? input.NextToken : query.get('NextToken')) ?? 0);
    const page = all.slice(from, from + size);
    return [200, { EmailIdentities: page, ...(from + size < all.length ? { NextToken: String(from + size) } : {}) }];
  }
  if (identity) {
    const name = decodeURIComponent(identity[1]);
    const found = identities.get(name);
    if (!found) throw notFound(`Email identity ${name} does not exist.`);
    if (method === 'GET') {
      asked.GetEmailIdentity = (asked.GetEmailIdentity ?? 0) + 1;
      return [200, identityView(found)];
    }
    if (method === 'DELETE') {
      asked.DeleteEmailIdentity = (asked.DeleteEmailIdentity ?? 0) + 1;
      identities.delete(name);
      return [200, {}];
    }
  }
  if (method === 'POST' && path === '/v2/email/outbound-emails') {
    asked.SendEmail = (asked.SendEmail ?? 0) + 1;
    const raw = input.Content?.Raw?.Data;
    const rawText = raw === undefined ? undefined : Buffer.from(raw, 'base64').toString('utf8');
    // A raw message says its sender in its From header, as SES reads it when FromEmailAddress is left out.
    const fromHeader = rawText && /^From:[^\r\n]*?<?([^\s<>]+@[^\s<>]+)>?\s*$/im.exec(rawText.split(/\r?\n\r?\n/)[0])?.[1];
    const from = input.FromEmailAddress ?? fromHeader ?? '';
    const domain = from.split('@')[1] ?? '';
    if (!identities.get(domain)?.verified && !identities.get(from)?.verified) {
      throw new SesError(400, 'MessageRejected', `Email address is not verified. The following identities failed the check in region ${REGION}: ${from}`);
    }
    const recipients = ['ToAddresses', 'CcAddresses', 'BccAddresses'].flatMap((field) => input.Destination?.[field] ?? []);
    if (input.Content?.Raw === undefined && recipients.length === 0) throw badRequest('Missing final @ domain');
    if (recipients.length > 50) throw badRequest('Recipient count exceeds 50.');
    const message = { from, recipients, simple: input.Content?.Simple, raw: rawText };
    sent.push(message);
    return [200, { MessageId: `${Date.now().toString(16)}-${randomUUID()}-000000` }];
  }
  if (method === 'GET' && path === '/v2/email/account') {
    asked.GetAccount = (asked.GetAccount ?? 0) + 1;
    return [
      200,
      {
        DedicatedIpAutoWarmupEnabled: false,
        EnforcementStatus: 'HEALTHY',
        ProductionAccessEnabled: false,
        SendQuota: { Max24HourSend: 200, MaxSendRate: 1, SentLast24Hours: sent.length },
        SendingEnabled: true,
        SuppressionAttributes: { SuppressedReasons: ['BOUNCE', 'COMPLAINT'] },
      },
    ];
  }
  if (method === 'PUT' && path === '/v2/email/suppression/addresses') {
    asked.PutSuppressedDestination = (asked.PutSuppressedDestination ?? 0) + 1;
    if (!['BOUNCE', 'COMPLAINT'].includes(input.Reason)) throw badRequest('Reason must be BOUNCE or COMPLAINT');
    suppressed.set(input.EmailAddress, { EmailAddress: input.EmailAddress, Reason: input.Reason, LastUpdateTime: epochSeconds(new Date()) });
    return [200, {}];
  }
  if (method === 'GET' && path === '/v2/email/suppression/addresses') {
    asked.ListSuppressedDestinations = (asked.ListSuppressedDestinations ?? 0) + 1;
    const reasons = query.getAll('Reason');
    return [200, { SuppressedDestinationSummaries: [...suppressed.values()].filter((one) => reasons.length === 0 || reasons.includes(one.Reason)) }];
  }
  if (suppression) {
    const address = decodeURIComponent(suppression[1]);
    const found = suppressed.get(address);
    if (!found) throw notFound(`Email address ${address} does not exist on your suppression list.`);
    if (method === 'GET') {
      asked.GetSuppressedDestination = (asked.GetSuppressedDestination ?? 0) + 1;
      return [200, { SuppressedDestination: { ...found, Attributes: { MessageId: 'spike', FeedbackId: 'spike' } } }];
    }
    if (method === 'DELETE') {
      asked.DeleteSuppressedDestination = (asked.DeleteSuppressedDestination ?? 0) + 1;
      suppressed.delete(address);
      return [200, {}];
    }
  }
  throw new SesError(404, 'NotFoundException', `No route for ${method} ${path}`);
}

createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks);
    const requestId = randomUUID();
    let status = 200;
    let answer;
    try {
      verify(request, body);
      const [rawPath, rawQuery = ''] = (request.url ?? '/').split('?');
      const input = body.length ? JSON.parse(body.toString('utf8')) : {};
      [status, answer] = operate(request.method, rawPath, new URLSearchParams(rawQuery), input);
    } catch (error) {
      const refusal = error instanceof SesError ? error : new SesError(500, 'InternalFailure', error.message);
      status = refusal.status;
      answer = { message: refusal.message };
      response.setHeader('x-amzn-ErrorType', `${refusal.type}:http://internal.amazon.com/coral/com.amazon.coral.service/`);
    }
    const text = JSON.stringify(answer);
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'x-amzn-RequestId': requestId });
    response.end(text);
  });
}).listen(Number(PORT), '127.0.0.1');

const stop = () => {
  console.error(JSON.stringify({ asked, signedPaths, sent: sent.length, rawMessages: sent.filter((message) => message.raw).length }));
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

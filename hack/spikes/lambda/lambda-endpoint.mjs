#!/usr/bin/env node
// A minimal AWS Lambda endpoint, Node.js's standard library only, for step 5's spike (the step-5 plan's X-01): Lambda's
// REST API in JSON at its dated paths, Signature Version 4 for the service lambda with one key, the 41 operations of
// the plan's D2 kept in memory, and every other operation refused in Lambda's error shape, saying it comes later. A
// function is Pending for PENDING_MS after it is made, and an update InProgress for UPDATE_MS, as Lambda's are, so that
// the clients' waiters poll; an update asked while one is in progress is refused as Lambda refuses it. Nothing runs:
// Invoke answers with the event it was given. Every request is one line of REQUESTS (JSON): the tool, from its
// User-Agent; the operation; the path as sent and whether its signature was made over it escaped once or twice; the
// signed headers; the bodies' sizes; the answer's status and error. What AWS's tools call, and how, is run.sh's question.
//   PORT=… KEY=AKFF… SECRET=… REQUESTS=<file> [REGION=tn-tunis-1] [ACCOUNT=123456789012] node lambda-endpoint.mjs
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const { PORT, KEY, SECRET, REQUESTS } = process.env;
const REGION = process.env.REGION ?? 'tn-tunis-1';
const ACCOUNT = process.env.ACCOUNT ?? '123456789012';
const PENDING_MS = Number(process.env.PENDING_MS ?? 3000);
const UPDATE_MS = Number(process.env.UPDATE_MS ?? 2000);
const MAX_SKEW_MS = 15 * 60_000;

const hmac = (key, data) => createHmac('sha256', key).update(data, 'utf8').digest();
const sha256hex = (data) => createHash('sha256').update(data).digest('hex');
/** RFC 3986's escaping, as SigV4 makes it: everything but the unreserved characters. */
const uriEncode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

class LambdaError extends Error {
  constructor(status, type, message) {
    super(message);
    this.status = status;
    this.type = type;
  }
}
const notFound = (message) => new LambdaError(404, 'ResourceNotFoundException', message);
const invalid = (message) => new LambdaError(400, 'InvalidParameterValueException', message);
const conflict = (message) => new LambdaError(409, 'ResourceConflictException', message);

/** Which canonical path the signature was made over: 'twice' (every service but S3), 'once' (S3's), or it throws. */
function verify(request, body) {
  const auth = request.headers.authorization ?? '';
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, ?SignedHeaders=([^,]+), ?Signature=([0-9a-f]{64})$/.exec(auth);
  if (!match) throw new LambdaError(403, 'MissingAuthenticationTokenException', 'Missing Authentication Token');
  const [, key, date, region, service, signedHeaders, signature] = match;
  if (key !== KEY) throw new LambdaError(403, 'UnrecognizedClientException', 'The security token included in the request is invalid.');
  if (service !== 'lambda' || region !== REGION) {
    throw new LambdaError(403, 'InvalidSignatureException', `Credential should be scoped to a valid region and the service lambda, not '${region}/${service}'.`);
  }
  const amzDate = request.headers['x-amz-date'] ?? '';
  const signedAt = Date.parse(`${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`);
  if (!Number.isFinite(signedAt) || Math.abs(Date.now() - signedAt) > MAX_SKEW_MS) throw new LambdaError(403, 'InvalidSignatureException', 'Signature expired');
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
  const payloadHash = values.get('x-amz-content-sha256') ?? sha256hex(body);
  const signatureOver = (path) => {
    const canonical = [request.method, path, query, names.map((name) => `${name}:${values.get(name) ?? ''}\n`).join(''), signedHeaders, payloadHash].join('\n');
    return createHmac('sha256', signingKey).update(['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n')).digest('hex');
  };
  if (signatureOver(rawPath.split('/').map(uriEncode).join('/')) === signature) return { signedPath: 'twice', signedHeaders: names };
  if (signatureOver(rawPath) === signature) return { signedPath: 'once', signedHeaders: names };
  throw new LambdaError(403, 'InvalidSignatureException', 'The request signature we calculated does not match the signature you provided.');
}

// The account's functions: each one's $LATEST, its versions, aliases, URL, policy, async settings, concurrency, tags.
const functions = new Map();
const mappings = new Map();
const now = () => Date.now();
const lambdaTime = (ms) => new Date(ms).toISOString().replace('Z', '+0000');
const functionArn = (name, qualifier) => `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${name}${qualifier ? `:${qualifier}` : ''}`;

/** A function's name and qualifier, from its name, its ARN, or its partial ARN, with or without a qualifier. */
function parseName(raw, qualifierParam) {
  const value = decodeURIComponent(raw);
  const parts = value.startsWith('arn:') ? value.split(':').slice(6) : value.includes(':function:') ? value.split(':').slice(2) : value.split(':');
  return { name: parts[0], qualifier: parts[1] ?? qualifierParam ?? undefined };
}
function find(raw, qualifierParam) {
  const { name, qualifier } = parseName(raw, qualifierParam);
  const fn = functions.get(name);
  if (!fn) throw notFound(`Function not found: ${functionArn(name, qualifier)}`);
  return { fn, qualifier };
}
/** Lambda's lazy states, read now: Pending, then Active; InProgress, then Successful. */
function settle(config) {
  if (config.State === 'Pending' && now() >= config.readyAt) Object.assign(config, { State: 'Active', StateReason: undefined, StateReasonCode: undefined });
  if (config.LastUpdateStatus === 'InProgress' && now() >= config.updatedAt) Object.assign(config, { LastUpdateStatus: 'Successful', LastUpdateStatusReason: undefined, LastUpdateStatusReasonCode: undefined });
  return config;
}
const view = (config) => {
  const { readyAt, updatedAt, ...shown } = settle(config);
  return shown;
};
function configOf(fn, qualifier) {
  if (!qualifier || qualifier === '$LATEST') return fn.latest;
  const version = fn.aliases.get(qualifier)?.FunctionVersion ?? qualifier;
  const found = fn.versions.get(version);
  if (!found) throw notFound(`Function not found: ${functionArn(fn.latest.FunctionName, qualifier)}`);
  return found;
}
function code(input) {
  if (input.ZipFile) {
    const zip = Buffer.from(input.ZipFile, 'base64');
    return { CodeSize: zip.length, CodeSha256: createHash('sha256').update(zip).digest('base64') };
  }
  if (input.S3Bucket) return { CodeSize: 0, CodeSha256: createHash('sha256').update(`${input.S3Bucket}/${input.S3Key}`).digest('base64') };
  throw invalid('Please do not provide both or neither of ZipFile and S3 location.');
}
function busy(fn) {
  settle(fn.latest);
  if (fn.latest.State === 'Pending') throw conflict(`The operation cannot be performed at this time. The function is currently in the following state: Pending`);
  if (fn.latest.LastUpdateStatus === 'InProgress') throw conflict(`The operation cannot be performed at this time. An update is in progress for resource: ${fn.latest.FunctionArn}`);
}
const settings = ['Description', 'Handler', 'MemorySize', 'Role', 'Runtime', 'Timeout', 'Environment', 'TracingConfig', 'Layers', 'EphemeralStorage', 'LoggingConfig', 'VpcConfig', 'DeadLetterConfig', 'KMSKeyArn'];
function applySettings(config, input) {
  for (const field of settings) if (input[field] !== undefined) config[field] = input[field];
  if (input.Environment) config.Environment = { Variables: input.Environment.Variables ?? {} };
}
function updated(fn) {
  Object.assign(fn.latest, { LastModified: lambdaTime(now()), RevisionId: randomUUID(), LastUpdateStatus: 'InProgress', LastUpdateStatusReason: 'The function is being created.', LastUpdateStatusReasonCode: 'Creating', updatedAt: now() + UPDATE_MS });
}
function publish(fn, description) {
  busy(fn);
  const last = [...fn.versions.values()].at(-1);
  if (last && last.CodeSha256 === fn.latest.CodeSha256 && last.configHash === hashOf(fn.latest)) return last;
  const version = String(fn.nextVersion++);
  const snapshot = { ...structuredClone(view(fn.latest)), Version: version, FunctionArn: functionArn(fn.latest.FunctionName, version), Description: description ?? fn.latest.Description, configHash: hashOf(fn.latest) };
  fn.versions.set(version, snapshot);
  return snapshot;
}
const hashOf = (config) => sha256hex(JSON.stringify(settings.map((field) => config[field])));
const versionView = ({ configHash, ...shown }) => view(shown);
const aliasView = (fn, alias) => ({ AliasArn: functionArn(fn.latest.FunctionName, alias.Name), ...alias });
function policyOf(fn) {
  if (fn.policy.size === 0) throw notFound('The resource you requested does not exist.');
  return { Policy: JSON.stringify({ Version: '2012-10-17', Id: 'default', Statement: [...fn.policy.values()] }), RevisionId: fn.latest.RevisionId };
}
function mappingView(mapping) {
  const age = now() - mapping.changedAt;
  if (mapping.State === 'Creating' && age > UPDATE_MS) mapping.State = mapping.wantEnabled ? 'Enabled' : 'Disabled';
  if (mapping.State === 'Updating' && age > UPDATE_MS) mapping.State = mapping.wantEnabled ? 'Enabled' : 'Disabled';
  if (mapping.State === 'Deleting' && age > UPDATE_MS) {
    mappings.delete(mapping.UUID);
    throw notFound(`The resource you requested does not exist. (Service: Lambda, Status Code: 404)`);
  }
  const { changedAt, wantEnabled, ...shown } = mapping;
  return shown;
}
const tagsOfArn = (arn) => {
  const name = /:function:([^:]+)/.exec(decodeURIComponent(arn))?.[1];
  const fn = functions.get(name);
  if (!fn) throw notFound(`Function not found: ${decodeURIComponent(arn)}`);
  return fn.tags;
};

/** Each operation: its method, its path, and what it does. The order matters where one path is another's prefix. */
const routes = [
  ['POST', /^\/2015-03-31\/functions\/?$/, 'CreateFunction', (m, q, input) => {
    const name = input.FunctionName;
    if (!name) throw invalid('FunctionName is required');
    if (functions.has(name)) throw conflict(`Function already exist: ${name}`);
    if (!input.Role) throw invalid('Role is required');
    const at = now();
    const latest = {
      FunctionName: name, FunctionArn: functionArn(name), Runtime: input.Runtime, Role: input.Role, Handler: input.Handler, ...code(input.Code ?? {}),
      Description: input.Description ?? '', Timeout: input.Timeout ?? 3, MemorySize: input.MemorySize ?? 128, LastModified: lambdaTime(at), Version: '$LATEST',
      Environment: { Variables: input.Environment?.Variables ?? {} }, TracingConfig: { Mode: input.TracingConfig?.Mode ?? 'PassThrough' }, RevisionId: randomUUID(),
      State: 'Pending', StateReason: 'The function is being created.', StateReasonCode: 'Creating', LastUpdateStatus: 'Successful', PackageType: input.PackageType ?? 'Zip',
      Architectures: input.Architectures ?? ['x86_64'], EphemeralStorage: { Size: input.EphemeralStorage?.Size ?? 512 }, SnapStart: { ApplyOn: 'None', OptimizationStatus: 'Off' },
      LoggingConfig: { LogFormat: 'Text', LogGroup: `/aws/lambda/${name}` }, readyAt: at + (name.includes('slow') ? PENDING_MS * 3 : PENDING_MS),
    };
    const fn = { latest, versions: new Map(), aliases: new Map(), nextVersion: 1, url: null, policy: new Map(), invokeConfigs: new Map(), concurrency: null, tags: { ...(input.Tags ?? {}) } };
    functions.set(name, fn);
    if (input.Publish) {
      latest.State = 'Active';
      publish(fn);
      latest.State = 'Pending';
    }
    return [201, view(latest)];
  }],
  ['GET', /^\/2015-03-31\/functions\/?$/, 'ListFunctions', (m, q) => {
    const all = [...functions.values()].map((fn) => view(fn.latest));
    const size = Number(q.get('MaxItems') ?? 50);
    const from = Number(q.get('Marker') ?? 0);
    return [200, { Functions: all.slice(from, from + size), ...(from + size < all.length ? { NextMarker: String(from + size) } : {}) }];
  }],
  ['POST', /^\/2015-03-31\/functions\/([^/]+)\/invocations$/, 'Invoke', (m, q, input, request, body) => {
    const { fn, qualifier } = find(m[1], q.get('Qualifier'));
    settle(fn.latest);
    if (fn.latest.State === 'Pending') throw conflict('The operation cannot be performed at this time. The function is currently in the following state: Pending');
    const config = configOf(fn, qualifier);
    const type = request.headers['x-amz-invocation-type'] ?? 'RequestResponse';
    if (type === 'DryRun') return [204, null];
    if (type === 'Event') return [202, null];
    const id = randomUUID();
    const log = `START RequestId: ${id} Version: ${config.Version}\nthe spike's endpoint ran nothing\nEND RequestId: ${id}\nREPORT RequestId: ${id}\tDuration: 1.00 ms\tBilled Duration: 1 ms\tMemory Size: ${config.MemorySize} MB\tMax Memory Used: 40 MB\n`;
    const headers = { 'x-amz-executed-version': config.Version, ...(request.headers['x-amz-log-type'] === 'Tail' ? { 'x-amz-log-result': Buffer.from(log).toString('base64') } : {}) };
    return [200, { echo: body.length ? JSON.parse(body.toString('utf8')) : null, version: config.Version }, headers];
  }],
  ['GET', /^\/2015-03-31\/functions\/([^/]+)\/configuration$/, 'GetFunctionConfiguration', (m, q) => {
    const { fn, qualifier } = find(m[1], q.get('Qualifier'));
    const config = configOf(fn, qualifier);
    return [200, config === fn.latest ? view(config) : versionView(config)];
  }],
  ['PUT', /^\/2015-03-31\/functions\/([^/]+)\/configuration$/, 'UpdateFunctionConfiguration', (m, q, input) => {
    const { fn } = find(m[1]);
    busy(fn);
    applySettings(fn.latest, input);
    updated(fn);
    return [200, view(fn.latest)];
  }],
  ['PUT', /^\/2015-03-31\/functions\/([^/]+)\/code$/, 'UpdateFunctionCode', (m, q, input) => {
    const { fn } = find(m[1]);
    busy(fn);
    if (input.DryRun) return [200, view(fn.latest)];
    Object.assign(fn.latest, code(input));
    if (input.Architectures) fn.latest.Architectures = input.Architectures;
    updated(fn);
    if (input.Publish) {
      fn.latest.LastUpdateStatus = 'Successful';
      return [200, versionView(publish(fn))];
    }
    return [200, view(fn.latest)];
  }],
  ['POST', /^\/2015-03-31\/functions\/([^/]+)\/versions$/, 'PublishVersion', (m, q, input) => {
    const { fn } = find(m[1]);
    if (input.CodeSha256 && input.CodeSha256 !== fn.latest.CodeSha256) throw new LambdaError(412, 'PreconditionFailedException', 'CodeSHA256 does not match');
    return [201, versionView(publish(fn, input.Description))];
  }],
  ['GET', /^\/2015-03-31\/functions\/([^/]+)\/versions$/, 'ListVersionsByFunction', (m) => {
    const { fn } = find(m[1]);
    return [200, { Versions: [view(fn.latest), ...[...fn.versions.values()].map(versionView)] }];
  }],
  ['POST', /^\/2015-03-31\/functions\/([^/]+)\/aliases$/, 'CreateAlias', (m, q, input) => {
    const { fn } = find(m[1]);
    if (fn.aliases.has(input.Name)) throw conflict(`Alias already exists: ${functionArn(fn.latest.FunctionName, input.Name)}`);
    if (input.FunctionVersion !== '$LATEST' && !fn.versions.has(input.FunctionVersion)) throw notFound(`Function not found: ${functionArn(fn.latest.FunctionName, input.FunctionVersion)}`);
    const alias = { Name: input.Name, FunctionVersion: input.FunctionVersion, Description: input.Description ?? '', RevisionId: randomUUID(), ...(input.RoutingConfig ? { RoutingConfig: input.RoutingConfig } : {}) };
    fn.aliases.set(input.Name, alias);
    return [201, aliasView(fn, alias)];
  }],
  ['GET', /^\/2015-03-31\/functions\/([^/]+)\/aliases$/, 'ListAliases', (m) => {
    const { fn } = find(m[1]);
    return [200, { Aliases: [...fn.aliases.values()].map((alias) => aliasView(fn, alias)) }];
  }],
  ['GET', /^\/2015-03-31\/functions\/([^/]+)\/aliases\/([^/]+)$/, 'GetAlias', (m) => {
    const { fn } = find(m[1]);
    const alias = fn.aliases.get(decodeURIComponent(m[2]));
    if (!alias) throw notFound(`Alias not found: ${functionArn(fn.latest.FunctionName, decodeURIComponent(m[2]))}`);
    return [200, aliasView(fn, alias)];
  }],
  ['PUT', /^\/2015-03-31\/functions\/([^/]+)\/aliases\/([^/]+)$/, 'UpdateAlias', (m, q, input) => {
    const { fn } = find(m[1]);
    const alias = fn.aliases.get(decodeURIComponent(m[2]));
    if (!alias) throw notFound(`Alias not found: ${functionArn(fn.latest.FunctionName, decodeURIComponent(m[2]))}`);
    for (const field of ['FunctionVersion', 'Description', 'RoutingConfig']) if (input[field] !== undefined) alias[field] = input[field];
    alias.RevisionId = randomUUID();
    return [200, aliasView(fn, alias)];
  }],
  ['DELETE', /^\/2015-03-31\/functions\/([^/]+)\/aliases\/([^/]+)$/, 'DeleteAlias', (m) => {
    const { fn } = find(m[1]);
    fn.aliases.delete(decodeURIComponent(m[2]));
    return [204, null];
  }],
  ['POST', /^\/2015-03-31\/functions\/([^/]+)\/policy$/, 'AddPermission', (m, q, input) => {
    const { fn } = find(m[1], q.get('Qualifier'));
    if (fn.policy.has(input.StatementId)) throw conflict(`The statement id (${input.StatementId}) provided already exists. Please provide a new statement id, or remove the existing statement.`);
    const statement = {
      Sid: input.StatementId, Effect: 'Allow', Principal: input.Principal === '*' ? '*' : { Service: input.Principal }, Action: input.Action, Resource: fn.latest.FunctionArn,
      ...(input.SourceArn ? { Condition: { ArnLike: { 'AWS:SourceArn': input.SourceArn } } } : {}),
      ...(input.FunctionUrlAuthType ? { Condition: { StringEquals: { 'lambda:FunctionUrlAuthType': input.FunctionUrlAuthType } } } : {}),
    };
    fn.policy.set(input.StatementId, statement);
    return [201, { Statement: JSON.stringify(statement) }];
  }],
  ['GET', /^\/2015-03-31\/functions\/([^/]+)\/policy$/, 'GetPolicy', (m) => [200, policyOf(find(m[1]).fn)]],
  ['DELETE', /^\/2015-03-31\/functions\/([^/]+)\/policy\/([^/]+)$/, 'RemovePermission', (m) => {
    const { fn } = find(m[1]);
    if (!fn.policy.delete(decodeURIComponent(m[2]))) throw notFound(`Statement ${decodeURIComponent(m[2])} is not found in resource policy.`);
    return [204, null];
  }],
  ['GET', /^\/2015-03-31\/functions\/([^/]+)$/, 'GetFunction', (m, q) => {
    const { fn, qualifier } = find(m[1], q.get('Qualifier'));
    const config = configOf(fn, qualifier);
    return [200, {
      Configuration: config === fn.latest ? view(config) : versionView(config), Code: { RepositoryType: 'S3', Location: `https://awslambda-${REGION}-tasks.s3.${REGION}.amazonaws.com/snapshots/${ACCOUNT}/${fn.latest.FunctionName}` },
      Tags: fn.tags, ...(fn.concurrency !== null ? { Concurrency: { ReservedConcurrentExecutions: fn.concurrency } } : {}),
    }];
  }],
  ['DELETE', /^\/2015-03-31\/functions\/([^/]+)$/, 'DeleteFunction', (m, q) => {
    const { fn, qualifier } = find(m[1], q.get('Qualifier'));
    if (qualifier) fn.versions.delete(qualifier);
    else functions.delete(fn.latest.FunctionName);
    return [204, null];
  }],
  ['POST', /^\/2021-10-31\/functions\/([^/]+)\/url$/, 'CreateFunctionUrlConfig', (m, q, input) => {
    const { fn } = find(m[1], q.get('Qualifier'));
    if (fn.url) throw conflict(`FunctionUrlConfig exists for this Lambda function`);
    const at = new Date().toISOString();
    fn.url = { FunctionUrl: `https://${randomUUID().replace(/-/g, '').slice(0, 32)}.lambda-url.${REGION}.on.aws/`, FunctionArn: fn.latest.FunctionArn, AuthType: input.AuthType, Cors: input.Cors, InvokeMode: input.InvokeMode ?? 'BUFFERED', CreationTime: at, LastModifiedTime: at };
    const { LastModifiedTime, ...created } = fn.url;
    return [201, created];
  }],
  ['GET', /^\/2021-10-31\/functions\/([^/]+)\/url$/, 'GetFunctionUrlConfig', (m, q) => {
    const { fn } = find(m[1], q.get('Qualifier'));
    if (!fn.url) throw notFound('The resource you requested does not exist.');
    return [200, fn.url];
  }],
  ['PUT', /^\/2021-10-31\/functions\/([^/]+)\/url$/, 'UpdateFunctionUrlConfig', (m, q, input) => {
    const { fn } = find(m[1], q.get('Qualifier'));
    if (!fn.url) throw notFound('The resource you requested does not exist.');
    for (const field of ['AuthType', 'Cors', 'InvokeMode']) if (input[field] !== undefined) fn.url[field] = input[field];
    fn.url.LastModifiedTime = new Date().toISOString();
    return [200, fn.url];
  }],
  ['DELETE', /^\/2021-10-31\/functions\/([^/]+)\/url$/, 'DeleteFunctionUrlConfig', (m) => {
    const { fn } = find(m[1]);
    if (!fn.url) throw notFound('The resource you requested does not exist.');
    fn.url = null;
    return [204, null];
  }],
  ['GET', /^\/2021-10-31\/functions\/([^/]+)\/urls$/, 'ListFunctionUrlConfigs', (m) => {
    const { fn } = find(m[1]);
    return [200, { FunctionUrlConfigs: fn.url ? [fn.url] : [] }];
  }],
  ['POST', /^\/2015-03-31\/event-source-mappings\/?$/, 'CreateEventSourceMapping', (m, q, input) => {
    const { fn, qualifier } = find(input.FunctionName);
    const mapping = {
      UUID: randomUUID(), EventSourceArn: input.EventSourceArn, FunctionArn: functionArn(fn.latest.FunctionName, qualifier), BatchSize: input.BatchSize ?? 10,
      MaximumBatchingWindowInSeconds: input.MaximumBatchingWindowInSeconds ?? 0, FunctionResponseTypes: input.FunctionResponseTypes ?? [], LastModified: now() / 1000,
      State: 'Creating', StateTransitionReason: 'USER_INITIATED', ...(input.ScalingConfig ? { ScalingConfig: input.ScalingConfig } : {}), wantEnabled: input.Enabled !== false, changedAt: now(),
    };
    mappings.set(mapping.UUID, mapping);
    return [202, mappingView(mapping)];
  }],
  ['GET', /^\/2015-03-31\/event-source-mappings\/?$/, 'ListEventSourceMappings', (m, q) => {
    const name = q.get('FunctionName') && parseName(q.get('FunctionName')).name;
    const all = [];
    for (const mapping of [...mappings.values()]) {
      if (name && !mapping.FunctionArn.includes(`:function:${name}`)) continue;
      if (q.get('EventSourceArn') && mapping.EventSourceArn !== q.get('EventSourceArn')) continue;
      try {
        all.push(mappingView(mapping));
      } catch {
        // deleted by now
      }
    }
    return [200, { EventSourceMappings: all }];
  }],
  ['GET', /^\/2015-03-31\/event-source-mappings\/([^/]+)$/, 'GetEventSourceMapping', (m) => {
    const mapping = mappings.get(m[1]);
    if (!mapping) throw notFound('The resource you requested does not exist. (Service: Lambda, Status Code: 404)');
    return [200, mappingView(mapping)];
  }],
  ['PUT', /^\/2015-03-31\/event-source-mappings\/([^/]+)$/, 'UpdateEventSourceMapping', (m, q, input) => {
    const mapping = mappings.get(m[1]);
    if (!mapping) throw notFound('The resource you requested does not exist.');
    mappingView(mapping);
    if (mapping.State !== 'Enabled' && mapping.State !== 'Disabled') throw conflict(`The resource you requested is currently in use by another operation. Please try again later.`);
    for (const field of ['BatchSize', 'MaximumBatchingWindowInSeconds', 'FunctionResponseTypes', 'ScalingConfig']) if (input[field] !== undefined) mapping[field] = input[field];
    if (input.Enabled !== undefined) mapping.wantEnabled = input.Enabled;
    Object.assign(mapping, { State: 'Updating', LastModified: now() / 1000, changedAt: now() });
    return [202, mappingView(mapping)];
  }],
  ['DELETE', /^\/2015-03-31\/event-source-mappings\/([^/]+)$/, 'DeleteEventSourceMapping', (m) => {
    const mapping = mappings.get(m[1]);
    if (!mapping) throw notFound('The resource you requested does not exist.');
    Object.assign(mapping, { State: 'Deleting', changedAt: now() });
    const { changedAt, wantEnabled, ...shown } = mapping;
    return [202, shown];
  }],
  ['GET', /^\/2019-09-25\/functions\/([^/]+)\/event-invoke-config\/list$/, 'ListFunctionEventInvokeConfigs', (m) => {
    const { fn } = find(m[1]);
    return [200, { FunctionEventInvokeConfigs: [...fn.invokeConfigs.values()] }];
  }],
  ['PUT', /^\/2019-09-25\/functions\/([^/]+)\/event-invoke-config$/, 'PutFunctionEventInvokeConfig', (m, q, input) => {
    const { fn, qualifier } = find(m[1], q.get('Qualifier'));
    const config = { FunctionArn: functionArn(fn.latest.FunctionName, qualifier ?? '$LATEST'), LastModified: now() / 1000, MaximumRetryAttempts: input.MaximumRetryAttempts ?? 2, MaximumEventAgeInSeconds: input.MaximumEventAgeInSeconds ?? 21600, DestinationConfig: input.DestinationConfig ?? { OnSuccess: {}, OnFailure: {} } };
    fn.invokeConfigs.set(qualifier ?? '$LATEST', config);
    return [200, config];
  }],
  ['POST', /^\/2019-09-25\/functions\/([^/]+)\/event-invoke-config$/, 'UpdateFunctionEventInvokeConfig', (m, q, input) => {
    const { fn, qualifier } = find(m[1], q.get('Qualifier'));
    const config = fn.invokeConfigs.get(qualifier ?? '$LATEST');
    if (!config) throw notFound(`The function ${functionArn(fn.latest.FunctionName, qualifier ?? '$LATEST')} doesn't have an EventInvokeConfig`);
    for (const field of ['MaximumRetryAttempts', 'MaximumEventAgeInSeconds', 'DestinationConfig']) if (input[field] !== undefined) config[field] = input[field];
    config.LastModified = now() / 1000;
    return [200, config];
  }],
  ['GET', /^\/2019-09-25\/functions\/([^/]+)\/event-invoke-config$/, 'GetFunctionEventInvokeConfig', (m, q) => {
    const { fn, qualifier } = find(m[1], q.get('Qualifier'));
    const config = fn.invokeConfigs.get(qualifier ?? '$LATEST');
    if (!config) throw notFound(`The function ${functionArn(fn.latest.FunctionName, qualifier ?? '$LATEST')} doesn't have an EventInvokeConfig`);
    return [200, config];
  }],
  ['DELETE', /^\/2019-09-25\/functions\/([^/]+)\/event-invoke-config$/, 'DeleteFunctionEventInvokeConfig', (m, q) => {
    const { fn, qualifier } = find(m[1], q.get('Qualifier'));
    fn.invokeConfigs.delete(qualifier ?? '$LATEST');
    return [204, null];
  }],
  ['PUT', /^\/2017-10-31\/functions\/([^/]+)\/concurrency$/, 'PutFunctionConcurrency', (m, q, input) => {
    const { fn } = find(m[1]);
    fn.concurrency = input.ReservedConcurrentExecutions;
    return [200, { ReservedConcurrentExecutions: fn.concurrency }];
  }],
  ['GET', /^\/2019-09-30\/functions\/([^/]+)\/concurrency$/, 'GetFunctionConcurrency', (m) => {
    const { fn } = find(m[1]);
    return [200, fn.concurrency === null ? {} : { ReservedConcurrentExecutions: fn.concurrency }];
  }],
  ['DELETE', /^\/2017-10-31\/functions\/([^/]+)\/concurrency$/, 'DeleteFunctionConcurrency', (m) => {
    find(m[1]).fn.concurrency = null;
    return [204, null];
  }],
  ['GET', /^\/2020-06-30\/functions\/([^/]+)\/code-signing-config$/, 'GetFunctionCodeSigningConfig', (m) => {
    const { fn } = find(m[1]);
    return [200, { CodeSigningConfigArn: '', FunctionName: fn.latest.FunctionName }];
  }],
  ['POST', /^\/2017-03-31\/tags\/(.+)$/, 'TagResource', (m, q, input) => {
    Object.assign(tagsOfArn(m[1]), input.Tags ?? {});
    return [204, null];
  }],
  ['DELETE', /^\/2017-03-31\/tags\/(.+)$/, 'UntagResource', (m, q) => {
    const tags = tagsOfArn(m[1]);
    for (const key of q.getAll('tagKeys')) delete tags[key];
    return [204, null];
  }],
  ['GET', /^\/2017-03-31\/tags\/(.+)$/, 'ListTags', (m) => [200, { Tags: tagsOfArn(m[1]) }]],
  ['GET', /^\/2016-08-19\/account-settings\/?$/, 'GetAccountSettings', () => {
    const total = [...functions.values()].reduce((sum, fn) => sum + fn.latest.CodeSize, 0);
    return [200, {
      AccountLimit: { TotalCodeSize: 80530636800, CodeSizeUnzipped: 262144000, CodeSizeZipped: 52428800, ConcurrentExecutions: 1000, UnreservedConcurrentExecutions: 1000 },
      AccountUsage: { TotalCodeSize: total, FunctionCount: functions.size },
    }];
  }],
];

/** The operation a request asks for, known or not: Lambda's dated paths name every one of its operations. */
const operationOf = (method, path) => routes.find(([m, pattern]) => m === method && pattern.test(path))?.[2];
const toolOf = (userAgent = '') => {
  const known = [/(aws-cli\/[\d.]+)/, /(aws-sdk-js\/[\d.]+)/, /(Boto3\/[\d.]+)/, /(OpenTofu\/[\d.]+)/, /(Terraform\/[\d.]+)/, /(aws-sam-cli\/[\d.]+)/i, /(Botocore\/[\d.]+)/];
  const found = known.map((pattern) => pattern.exec(userAgent)?.[1]).filter(Boolean);
  return found.length ? found.join(' ') : userAgent.split(' ')[0] || 'unknown';
};

createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks);
    const url = new URL(request.url ?? '/', 'http://lambda');
    const record = {
      at: new Date().toISOString(), tool: toolOf(request.headers['user-agent']), method: request.method, path: (request.url ?? '/').split('?')[0], query: url.search.slice(1),
      contentType: request.headers['content-type'], transferEncoding: request.headers['transfer-encoding'], requestBytes: body.length,
    };
    let status = 500;
    let answer = null;
    let headers = {};
    try {
      Object.assign(record, verify(request, body));
      const route = routes.find(([method, pattern]) => method === request.method && pattern.test(url.pathname));
      if (!route) {
        // What D2 leaves for later: 400, which no client retries, naming what was asked and what to do instead.
        throw new LambdaError(400, 'UnknownOperationException', `FF doesn't offer this operation of Lambda's API yet: ${request.method} ${url.pathname}. It comes in a later step.`);
      }
      record.operation = route[2];
      const input = body.length && /json/.test(request.headers['content-type'] ?? '') ? JSON.parse(body.toString('utf8')) : {};
      [status, answer, headers = {}] = route[3](route[1].exec(url.pathname), url.searchParams, input, request, body);
    } catch (error) {
      status = error instanceof LambdaError ? error.status : 500;
      const type = error instanceof LambdaError ? error.type : 'ServiceException';
      headers = { 'x-amzn-errortype': type };
      answer = { Type: status < 500 ? 'User' : 'Service', message: error.message };
      record.error = type;
      record.message = error.message;
      if (!(error instanceof LambdaError)) console.error(error);
    }
    const text = answer === null ? '' : JSON.stringify(answer);
    record.status = status;
    record.responseBytes = Buffer.byteLength(text);
    record.operation ??= operationOf(request.method, url.pathname) ?? 'later';
    if (REQUESTS) appendFileSync(REQUESTS, `${JSON.stringify(record)}\n`);
    response.writeHead(status, { 'content-type': 'application/json', 'x-amzn-requestid': randomUUID(), ...headers });
    response.end(text);
  });
}).listen(Number(PORT), '127.0.0.1', () => console.error(`the spike's Lambda endpoint on http://127.0.0.1:${PORT}`));

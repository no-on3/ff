import { Injectable } from '@nestjs/common';
import { IncomingHttpHeaders } from 'node:http';
import { Function } from '../functions/entities/function.entity';
import { PlanView } from '../plans/plan-limits';
import { ActiveKey } from '../storage/storage-directory.service';
import { FunctionAccess } from '../storage/storage-key.entity';

/**
 * Where an operation's function is named: in its path, in its JSON body's
 * FunctionName, in its query's FunctionName (none naming the account's), as a
 * tag's resource, by its ARN in the path; or nowhere: the account's
 * operations, and a mapping's, whose function its record names.
 */
export type NamedIn = 'path' | 'body' | 'query' | 'resource' | 'account' | 'mapping';

/** One of Lambda's operations, as its API reference has it: its method and dated path, and what a key needs to make it. */
export interface LambdaOperation {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Its path, as sent: a function's name, ARN or partial ARN in the first group where the path names one, its escapes as sent. */
  path: RegExp;
  /** The level a key needs with the function, as IAM groups Lambda's actions: its List and Read actions, InvokeFunction, the others. */
  access: FunctionAccess;
  namedIn: NamedIn;
  /** The most its body holds, and the error past it, as Lambda's. */
  maxBodyBytes: number;
  /** Its body is a call's payload, as sent, rather than the operation's JSON (Invoke's). */
  payload?: true;
}

/** Lambda's limit on a request that carries code: 50 MB zipped, in base64, in JSON. */
export const CODE_BODY_BYTES = 69_905_067;

/** Lambda's limit on an invocation's payload, and the most any other operation's body holds here: 6 MB. */
export const PAYLOAD_BYTES = 6 * 1024 * 1024;

/** A function's name, ARN or partial ARN in a path, as sent. */
const F = '([^/]+)';

const operation = (
  method: LambdaOperation['method'],
  path: string,
  name: string,
  access: FunctionAccess,
  namedIn: NamedIn,
  more: Partial<Pick<LambdaOperation, 'maxBodyBytes' | 'payload'>> = {},
): LambdaOperation => ({ name, method, path: new RegExp(`^${path}$`), access, namedIn, maxBodyBytes: PAYLOAD_BYTES, ...more });

/**
 * The 41 operations FF's Lambda endpoint takes (ADR 0014, 2): what AWS's CLI,
 * its SDKs, Terraform's provider and SAM's resources call, as the spike in
 * hack/spikes/lambda recorded them. A path that ends in "/" takes it or not, as
 * the tools send either.
 */
export const LAMBDA_OPERATIONS: readonly LambdaOperation[] = [
  // Functions.
  operation('POST', '/2015-03-31/functions/?', 'CreateFunction', 'write', 'body', { maxBodyBytes: CODE_BODY_BYTES }),
  operation('GET', '/2015-03-31/functions/?', 'ListFunctions', 'read', 'account'),
  operation('GET', `/2015-03-31/functions/${F}`, 'GetFunction', 'read', 'path'),
  operation('DELETE', `/2015-03-31/functions/${F}`, 'DeleteFunction', 'write', 'path'),
  operation('GET', `/2015-03-31/functions/${F}/configuration`, 'GetFunctionConfiguration', 'read', 'path'),
  operation('PUT', `/2015-03-31/functions/${F}/configuration`, 'UpdateFunctionConfiguration', 'write', 'path'),
  operation('PUT', `/2015-03-31/functions/${F}/code`, 'UpdateFunctionCode', 'write', 'path', { maxBodyBytes: CODE_BODY_BYTES }),
  operation('GET', `/2020-06-30/functions/${F}/code-signing-config`, 'GetFunctionCodeSigningConfig', 'read', 'path'),
  // Invoke.
  operation('POST', `/2015-03-31/functions/${F}/invocations`, 'Invoke', 'invoke', 'path', { payload: true }),
  // Versions and aliases.
  operation('POST', `/2015-03-31/functions/${F}/versions`, 'PublishVersion', 'write', 'path'),
  operation('GET', `/2015-03-31/functions/${F}/versions`, 'ListVersionsByFunction', 'read', 'path'),
  operation('POST', `/2015-03-31/functions/${F}/aliases`, 'CreateAlias', 'write', 'path'),
  operation('GET', `/2015-03-31/functions/${F}/aliases`, 'ListAliases', 'read', 'path'),
  operation('GET', `/2015-03-31/functions/${F}/aliases/([^/]+)`, 'GetAlias', 'read', 'path'),
  operation('PUT', `/2015-03-31/functions/${F}/aliases/([^/]+)`, 'UpdateAlias', 'write', 'path'),
  operation('DELETE', `/2015-03-31/functions/${F}/aliases/([^/]+)`, 'DeleteAlias', 'write', 'path'),
  // Function URLs.
  operation('POST', `/2021-10-31/functions/${F}/url`, 'CreateFunctionUrlConfig', 'write', 'path'),
  operation('GET', `/2021-10-31/functions/${F}/url`, 'GetFunctionUrlConfig', 'read', 'path'),
  operation('PUT', `/2021-10-31/functions/${F}/url`, 'UpdateFunctionUrlConfig', 'write', 'path'),
  operation('DELETE', `/2021-10-31/functions/${F}/url`, 'DeleteFunctionUrlConfig', 'write', 'path'),
  operation('GET', `/2021-10-31/functions/${F}/urls`, 'ListFunctionUrlConfigs', 'read', 'path'),
  // Event source mappings, for SQS.
  operation('POST', '/2015-03-31/event-source-mappings/?', 'CreateEventSourceMapping', 'write', 'body'),
  operation('GET', '/2015-03-31/event-source-mappings/?', 'ListEventSourceMappings', 'read', 'query'),
  operation('GET', '/2015-03-31/event-source-mappings/([^/]+)', 'GetEventSourceMapping', 'read', 'mapping'),
  operation('PUT', '/2015-03-31/event-source-mappings/([^/]+)', 'UpdateEventSourceMapping', 'write', 'mapping'),
  operation('DELETE', '/2015-03-31/event-source-mappings/([^/]+)', 'DeleteEventSourceMapping', 'write', 'mapping'),
  // Async settings.
  operation('PUT', `/2019-09-25/functions/${F}/event-invoke-config`, 'PutFunctionEventInvokeConfig', 'write', 'path'),
  operation('POST', `/2019-09-25/functions/${F}/event-invoke-config`, 'UpdateFunctionEventInvokeConfig', 'write', 'path'),
  operation('GET', `/2019-09-25/functions/${F}/event-invoke-config`, 'GetFunctionEventInvokeConfig', 'read', 'path'),
  operation('DELETE', `/2019-09-25/functions/${F}/event-invoke-config`, 'DeleteFunctionEventInvokeConfig', 'write', 'path'),
  operation('GET', `/2019-09-25/functions/${F}/event-invoke-config/list`, 'ListFunctionEventInvokeConfigs', 'read', 'path'),
  // Permissions, kept as sent.
  operation('POST', `/2015-03-31/functions/${F}/policy`, 'AddPermission', 'write', 'path'),
  operation('GET', `/2015-03-31/functions/${F}/policy`, 'GetPolicy', 'read', 'path'),
  operation('DELETE', `/2015-03-31/functions/${F}/policy/([^/]+)`, 'RemovePermission', 'write', 'path'),
  // Concurrency.
  operation('PUT', `/2017-10-31/functions/${F}/concurrency`, 'PutFunctionConcurrency', 'write', 'path'),
  operation('GET', `/2019-09-30/functions/${F}/concurrency`, 'GetFunctionConcurrency', 'read', 'path'),
  operation('DELETE', `/2017-10-31/functions/${F}/concurrency`, 'DeleteFunctionConcurrency', 'write', 'path'),
  // Tags, on a function by its ARN.
  operation('POST', '/2017-03-31/tags/(.+)', 'TagResource', 'write', 'resource'),
  operation('GET', '/2017-03-31/tags/(.+)', 'ListTags', 'read', 'resource'),
  operation('DELETE', '/2017-03-31/tags/(.+)', 'UntagResource', 'write', 'resource'),
  // The account.
  operation('GET', '/2016-08-19/account-settings/?', 'GetAccountSettings', 'read', 'account'),
];

/** The operation a request makes, by its method and its path as sent, and the path's groups, escapes decoded; null for one FF doesn't offer. */
export function operationOf(method: string, rawPath: string): { operation: LambdaOperation; groups: string[] } | null {
  for (const candidate of LAMBDA_OPERATIONS) {
    if (candidate.method !== method) continue;
    const match = candidate.path.exec(rawPath);
    if (!match) continue;
    try {
      return { operation: candidate, groups: match.slice(1).map((group) => decodeURIComponent(group)) };
    } catch {
      return null; // an escape that isn't one names nothing
    }
  }
  return null;
}

/** A request, as an operation reads it once the front door has let it through. */
export interface LambdaCall {
  operation: LambdaOperation;
  /** The path's groups, decoded: the function as named, then an alias's name, a statement's ID or a mapping's ID. */
  groups: string[];
  query: URLSearchParams;
  /** The request's JSON body; {} without one, or for a payload. */
  input: Record<string, unknown>;
  /** The request's body as sent: an invocation's payload. */
  body: Buffer;
  headers: IncomingHttpHeaders;
}

/** Who makes a request, and what it names, as the front door found them. */
export interface LambdaCaller {
  accountId: string;
  region: string;
  key: ActiveKey;
  plan: PlanView;
  /** The function a path or a tag's resource names, found in the key's account, and the version or the alias after its name. */
  function_?: Function;
  /** The function a request names, as named, its qualifier from its name or from the query's Qualifier; none for the account's operations and a mapping's. */
  named?: { name: string; qualifier?: string };
  /** Whether the key may do what `needed` is with the account's function of that name: a mapping's operations ask once they have read its function. */
  mayUse(name: string, needed: FunctionAccess): boolean;
  /** The audit log's actor: the key. */
  actor: { id: string; label: string };
  ip?: string;
}

/** An operation's answer: its status, its JSON document or its body as is (an invocation's), and its own headers. */
export interface LambdaAnswer {
  status: number;
  document?: unknown;
  body?: Buffer;
  headers?: Record<string, string>;
}

export type LambdaHandler = (call: LambdaCall, caller: LambdaCaller) => Promise<LambdaAnswer>;

/** An operation's answer of 200, its document Lambda's JSON. */
export const ok = (document: unknown): LambdaAnswer => ({ status: 200, document });

/** The function the front door found where the request's path or its tag's resource names one. */
export function namedFunction(caller: LambdaCaller): Function {
  if (!caller.function_) throw new Error('The front door finds the function a path names before its operation runs');
  return caller.function_;
}

/** A group of operations built over FF's services: each one's handler, by the operation's name. */
export interface LambdaHandlers {
  readonly handlers: Record<string, LambdaHandler>;
}

/**
 * What each of Lambda's operations does, by its name, over FF's own services:
 * an operation without one answers that FF doesn't offer it yet, in Lambda's
 * shape, which no client tries again.
 */
@Injectable()
export class LambdaOperations {
  private readonly handlers = new Map<string, LambdaHandler>();

  constructor(...groups: LambdaHandlers[]) {
    for (const group of groups) {
      for (const [name, handler] of Object.entries(group.handlers)) {
        if (this.handlers.has(name)) throw new Error(`Two handlers for Lambda's ${name}`);
        if (!LAMBDA_OPERATIONS.some((operation) => operation.name === name)) throw new Error(`A handler for ${name}, which isn't among Lambda's operations here`);
        this.handlers.set(name, handler);
      }
    }
  }

  /** What an operation does; undefined for one not built yet. */
  handler(name: string): LambdaHandler | undefined {
    return this.handlers.get(name);
  }
}

import { Injectable } from '@nestjs/common';
import { IncomingHttpHeaders } from 'node:http';
import { Function } from '../functions/entities/function.entity';
import { PlanView } from '../plans/plan-limits';
import { ActiveKey } from '../storage/storage-directory.service';
import { FunctionAccess } from '../storage/storage-key.entity';
import { invalidParameterValue } from './lambda-error';

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
  /** Its name in Lambda's refusal of a body too large, where that isn't its own. */
  refusedAs?: string;
}

/** Invoke's name in Lambda's refusal of a payload too large. */
export const INVOKE_FUNCTION = 'InvokeFunction';

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
  more: Partial<Pick<LambdaOperation, 'maxBodyBytes' | 'payload' | 'refusedAs'>> = {},
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
  operation('POST', `/2015-03-31/functions/${F}/invocations`, 'Invoke', 'invoke', 'path', { payload: true, refusedAs: INVOKE_FUNCTION }),
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

/**
 * One of Lambda's other operations, which FF doesn't offer yet: what tells it
 * in a request, so that its refusal names it, and what FF offers instead,
 * where it does.
 */
export interface LaterOperation {
  name: string;
  method: LambdaOperation['method'];
  path: RegExp;
  /** The query's parameter and value that tell it from the other operation at its path, as Lambda's model has them. */
  query?: [string, string];
  /** The most its body holds: Lambda's own, so that a large one is refused by its name too. */
  maxBodyBytes: number;
  /** What FF offers instead, said after the refusal. */
  instead?: string;
}

/** One segment of a path, as sent: a name or an ARN, escaped. */
const S = '[^/]+';

const later = (
  method: LaterOperation['method'],
  path: string,
  name: string,
  more: Partial<Pick<LaterOperation, 'query' | 'maxBodyBytes' | 'instead'>> = {},
): LaterOperation => ({ name, method, path: new RegExp(`^${path}/?$`), maxBodyBytes: PAYLOAD_BYTES, ...more });

const LAYERS = { instead: "A function's zip carries its libraries." };
const WARM = { instead: "FF keeps a function's instances warm with its minInstances, in FF's API (PUT /functions/{id}/scaling-config)." };

/**
 * Lambda's other operations, as its model has them (botocore's, beside the
 * specs in lambda-api-model): each answers that FF doesn't offer it yet,
 * naming it, as ADR 0014 (2) says. Where two share a path, the one its query
 * tells comes first.
 */
export const LATER_OPERATIONS: readonly LaterOperation[] = [
  // Layers.
  later('GET', '/2018-10-31/layers', 'GetLayerVersionByArn', { query: ['find', 'LayerVersion'], ...LAYERS }),
  later('GET', '/2018-10-31/layers', 'ListLayers', LAYERS),
  later('GET', `/2018-10-31/layers/${S}/versions`, 'ListLayerVersions', LAYERS),
  later('POST', `/2018-10-31/layers/${S}/versions`, 'PublishLayerVersion', { maxBodyBytes: CODE_BODY_BYTES, ...LAYERS }),
  later('GET', `/2018-10-31/layers/${S}/versions/${S}`, 'GetLayerVersion', LAYERS),
  later('DELETE', `/2018-10-31/layers/${S}/versions/${S}`, 'DeleteLayerVersion', LAYERS),
  later('POST', `/2018-10-31/layers/${S}/versions/${S}/policy`, 'AddLayerVersionPermission', LAYERS),
  later('GET', `/2018-10-31/layers/${S}/versions/${S}/policy`, 'GetLayerVersionPolicy', LAYERS),
  later('DELETE', `/2018-10-31/layers/${S}/versions/${S}/policy/${S}`, 'RemoveLayerVersionPermission', LAYERS),
  // Provisioned concurrency.
  later('GET', `/2019-09-30/functions/${S}/provisioned-concurrency`, 'ListProvisionedConcurrencyConfigs', { query: ['List', 'ALL'], ...WARM }),
  later('GET', `/2019-09-30/functions/${S}/provisioned-concurrency`, 'GetProvisionedConcurrencyConfig', WARM),
  later('PUT', `/2019-09-30/functions/${S}/provisioned-concurrency`, 'PutProvisionedConcurrencyConfig', WARM),
  later('DELETE', `/2019-09-30/functions/${S}/provisioned-concurrency`, 'DeleteProvisionedConcurrencyConfig', WARM),
  // Invoking otherwise.
  later('POST', `/2021-11-15/functions/${S}/response-streaming-invocations`, 'InvokeWithResponseStream'),
  later('POST', `/2014-11-13/functions/${S}/invoke-async`, 'InvokeAsync', { instead: 'AWS deprecated it for Invoke, with InvocationType Event.' }),
  // Code signing's own operations: GetFunctionCodeSigningConfig answers that a function has none.
  later('PUT', `/2020-06-30/functions/${S}/code-signing-config`, 'PutFunctionCodeSigningConfig'),
  later('DELETE', `/2020-06-30/functions/${S}/code-signing-config`, 'DeleteFunctionCodeSigningConfig'),
  later('POST', '/2020-04-22/code-signing-configs', 'CreateCodeSigningConfig'),
  later('GET', '/2020-04-22/code-signing-configs', 'ListCodeSigningConfigs'),
  later('GET', `/2020-04-22/code-signing-configs/${S}`, 'GetCodeSigningConfig'),
  later('PUT', `/2020-04-22/code-signing-configs/${S}`, 'UpdateCodeSigningConfig'),
  later('DELETE', `/2020-04-22/code-signing-configs/${S}`, 'DeleteCodeSigningConfig'),
  later('GET', `/2020-04-22/code-signing-configs/${S}/functions`, 'ListFunctionsByCodeSigningConfig'),
  // Runtime management, and recursion's detection.
  later('GET', `/2021-07-20/functions/${S}/runtime-management-config`, 'GetRuntimeManagementConfig'),
  later('PUT', `/2021-07-20/functions/${S}/runtime-management-config`, 'PutRuntimeManagementConfig'),
  later('GET', `/2024-08-31/functions/${S}/recursion-config`, 'GetFunctionRecursionConfig'),
  later('PUT', `/2024-08-31/functions/${S}/recursion-config`, 'PutFunctionRecursionConfig'),
  // AWS's additions of 2025: capacity providers, a function's scaling on them, durable executions.
  later('POST', '/2025-11-30/capacity-providers', 'CreateCapacityProvider'),
  later('GET', '/2025-11-30/capacity-providers', 'ListCapacityProviders'),
  later('GET', `/2025-11-30/capacity-providers/${S}`, 'GetCapacityProvider'),
  later('PUT', `/2025-11-30/capacity-providers/${S}`, 'UpdateCapacityProvider'),
  later('DELETE', `/2025-11-30/capacity-providers/${S}`, 'DeleteCapacityProvider'),
  later('GET', `/2025-11-30/capacity-providers/${S}/function-versions`, 'ListFunctionVersionsByCapacityProvider'),
  later('GET', `/2025-11-30/functions/${S}/function-scaling-config`, 'GetFunctionScalingConfig'),
  later('PUT', `/2025-11-30/functions/${S}/function-scaling-config`, 'PutFunctionScalingConfig'),
  later('GET', `/2025-12-01/functions/${S}/durable-executions`, 'ListDurableExecutionsByFunction'),
  later('GET', `/2025-12-01/durable-executions/${S}`, 'GetDurableExecution'),
  later('GET', `/2025-12-01/durable-executions/${S}/history`, 'GetDurableExecutionHistory'),
  later('GET', `/2025-12-01/durable-executions/${S}/state`, 'GetDurableExecutionState'),
  later('POST', `/2025-12-01/durable-executions/${S}/checkpoint`, 'CheckpointDurableExecution'),
  later('POST', `/2025-12-01/durable-executions/${S}/stop`, 'StopDurableExecution'),
  later('POST', `/2025-12-01/durable-execution-callbacks/${S}/succeed`, 'SendDurableExecutionCallbackSuccess'),
  later('POST', `/2025-12-01/durable-execution-callbacks/${S}/fail`, 'SendDurableExecutionCallbackFailure'),
  later('POST', `/2025-12-01/durable-execution-callbacks/${S}/heartbeat`, 'SendDurableExecutionCallbackHeartbeat'),
  // And of 2026: resource-based policies.
  later('PUT', `/2026-07-09/resource-policy/${S}`, 'PutResourcePolicy'),
  later('GET', `/2026-07-09/resource-policy/${S}`, 'GetResourcePolicy'),
  later('DELETE', `/2026-07-09/resource-policy/${S}`, 'DeleteResourcePolicy'),
];

/** Which of Lambda's other operations a request makes, by its method, its path as sent and its query; null for none of Lambda's. */
export function laterOperationOf(method: string, rawPath: string, rawQuery: string): LaterOperation | null {
  const query = new URLSearchParams(rawQuery);
  return (
    LATER_OPERATIONS.find(
      (candidate) => candidate.method === method && candidate.path.test(rawPath) && (!candidate.query || query.get(candidate.query[0]) === candidate.query[1]),
    ) ?? null
  );
}

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

/** The function the request names, for an operation that names it without a version or an alias; one named with either refused. */
export function unqualifiedFunction(caller: LambdaCaller, operation: string): Function {
  const function_ = namedFunction(caller);
  const qualifier = caller.named?.qualifier;
  if (qualifier !== undefined) throw invalidParameterValue(`${operation} names the function alone, not its version or alias ${qualifier}: send ${function_.name}.`);
  return function_;
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

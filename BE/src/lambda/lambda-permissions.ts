import { Injectable } from '@nestjs/common';
import { FunctionAliasesService } from '../functions/aliases.service';
import { qualifiedFunctionArn } from '../functions/arns';
import { Function } from '../functions/entities/function.entity';
import { UrlAuthType } from '../functions/entities/function-url.entity';
import { FunctionPoliciesService, policyDocument } from '../functions/policies.service';
import { parseQualifier } from '../functions/qualifier';
import { FunctionVersionsService } from '../functions/versions.service';
import { invalidParameterValue, preconditionFailed, resourceNotFound } from './lambda-error';
import { oneOf, refuseUnknownFields, said, text } from './lambda-fields';
import { LambdaAnswer, LambdaCall, LambdaCaller, LambdaHandler, LambdaHandlers, namedFunction, ok, qualifiedLookup } from './lambda-operations';

/** The fields AddPermission takes, as Lambda's model has them. */
const TAKEN = new Set([
  'StatementId',
  'Action',
  'Principal',
  'SourceArn',
  'SourceAccount',
  'EventSourceToken',
  'PrincipalOrgID',
  'FunctionUrlAuthType',
  'InvokedViaFunctionUrl',
  'RevisionId',
]);

/** Each string field's form, as Lambda's model has it, and what a refusal says it must be. */
const FORMS: Record<string, [RegExp, string]> = {
  StatementId: [/^[a-zA-Z0-9_-]{1,100}$/, '1 to 100 letters, digits, hyphens or underscores'],
  Action: [/^(lambda:\*|lambda:[a-zA-Z]+|\*)$/, "one of Lambda's actions, as lambda:InvokeFunction, or lambda:* or *"],
  Principal: [/^\S{1,2048}$/, "a service, as s3.amazonaws.com, an account's 12 digits, an ARN, or *, without spaces"],
  SourceArn: [/^arn:aws[a-zA-Z0-9-]*:[a-zA-Z0-9-]+:((eusc-)?[a-z]{2}(-gov|-iso[a-z]?)?-[a-z]+-\d)?:(\d{12})?:.*$/, "a resource's ARN"],
  SourceAccount: [/^\d{12}$/, "an account's 12 digits"],
  EventSourceToken: [/^[a-zA-Z0-9._-]{1,256}$/, 'up to 256 letters, digits, dots, hyphens or underscores'],
  PrincipalOrgID: [/^o-[a-z0-9]{10,32}$/, "an organization's ID, o- and 10 to 32 lowercase letters or digits"],
};

/** A statement's ID in RemovePermission's path, as Lambda's model has it: a dot too. */
const STATEMENT_ID_IN_PATH = /^[a-zA-Z0-9._-]{1,100}$/;

/** What Lambda answers for a policy that has no statement. */
const NO_POLICY = 'The resource you requested does not exist.';

/** What Lambda answers for a RevisionId that isn't the function's, its version's or its alias's any more. */
const REVISION_MOVED =
  'The RevisionId provided does not match the latest RevisionId for the Lambda function or alias. Call the GetFunction or the GetAlias API to retrieve the latest RevisionId for your resource.';

/** A string field in its form; undefined when not sent, unless it is needed. */
function formed(input: Record<string, unknown>, field: string, needed = false): string | undefined {
  const sent = text(input, field);
  if (sent === undefined) {
    if (needed) throw invalidParameterValue(`AddPermission needs ${field}.`);
    return undefined;
  }
  const [form, must] = FORMS[field];
  if (!form.test(sent)) throw invalidParameterValue(`${field} must be ${must}, not ${said(sent)}.`);
  return sent;
}

/** Lambda's Principal of a statement: anyone, an account's root, an ARN as sent, or a service. */
function principalOf(sent: string): string | Record<string, string> {
  if (sent === '*') return '*';
  if (/^\d{12}$/.test(sent)) return { AWS: `arn:aws:iam::${sent}:root` };
  if (sent.startsWith('arn:')) return { AWS: sent };
  return { Service: sent };
}

/** Lambda's statement of what AddPermission sends, its Resource the function's ARN as the request qualifies it. */
export function statementOf(input: Record<string, unknown>, resource: string): { statementId: string; statement: Record<string, unknown> } {
  const statementId = formed(input, 'StatementId', true) as string;
  const action = formed(input, 'Action', true) as string;
  const principal = formed(input, 'Principal', true) as string;
  const invokedViaUrl = input.InvokedViaFunctionUrl;
  if (invokedViaUrl !== undefined && typeof invokedViaUrl !== 'boolean') throw invalidParameterValue(`InvokedViaFunctionUrl must be true or false, not ${said(invokedViaUrl)}.`);
  // Each limit under the operator Lambda gives it, as Terraform's provider reads them back.
  const limits: Array<[operator: string, key: string, value: string | undefined]> = [
    ['StringEquals', 'AWS:SourceAccount', formed(input, 'SourceAccount')],
    ['StringEquals', 'lambda:EventSourceToken', formed(input, 'EventSourceToken')],
    ['StringEquals', 'aws:PrincipalOrgID', formed(input, 'PrincipalOrgID')],
    ['StringEquals', 'lambda:FunctionUrlAuthType', oneOf(input, 'FunctionUrlAuthType', Object.values(UrlAuthType))],
    ['Bool', 'lambda:InvokedViaFunctionUrl', invokedViaUrl === true ? 'true' : undefined],
    ['ArnLike', 'AWS:SourceArn', formed(input, 'SourceArn')],
  ];
  const condition: Record<string, Record<string, string>> = {};
  for (const [operator, key, value] of limits) if (value !== undefined) condition[operator] = { ...condition[operator], [key]: value };
  return {
    statementId,
    statement: {
      Sid: statementId,
      Effect: 'Allow',
      Principal: principalOf(principal),
      Action: action,
      Resource: resource,
      ...(Object.keys(condition).length > 0 ? { Condition: condition } : {}),
    },
  };
}

/** The policy a request means: the function's own, or its version's or alias's, with its ARN and its RevisionId. */
interface PolicyTarget {
  function_: Function;
  qualifier?: string;
  arn: string;
  revisionId: string;
}

/**
 * Lambda's permissions (ADR 0014): AddPermission, GetPolicy and RemovePermission, the function's own policy or its
 * version's or alias's, as Qualifier names it. Each statement is kept as sent and given back, without effect: FF's
 * keys, and its URLs' AuthType, decide who calls a function, so that templates and modules that grant them apply.
 */
@Injectable()
export class LambdaPermissions implements LambdaHandlers {
  constructor(
    private readonly policies: FunctionPoliciesService,
    private readonly versions: FunctionVersionsService,
    private readonly aliases: FunctionAliasesService,
  ) {}

  readonly handlers: Record<string, LambdaHandler> = {
    AddPermission: (call, caller) => this.add(call, caller),
    GetPolicy: async (call, caller) => {
      const target = await this.target(caller);
      const statements = await this.policies.policy(caller.accountId, target.function_.id, target.qualifier);
      if (statements.length === 0) throw resourceNotFound(NO_POLICY);
      return ok({ Policy: policyDocument(statements), RevisionId: target.revisionId });
    },
    RemovePermission: async ({ groups, query }, caller) => {
      const target = await this.target(caller);
      const statementId = groups[1];
      if (!STATEMENT_ID_IN_PATH.test(statementId)) throw invalidParameterValue(`StatementId must be 1 to 100 letters, digits, dots, hyphens or underscores, not ${statementId}.`);
      refuseMovedRevision(query.get('RevisionId') ?? undefined, target);
      await this.policies.remove(caller.accountId, target.function_.id, target.qualifier, statementId);
      return { status: 204 };
    },
  };

  /** A statement added to the policy; Lambda answers it as kept, its JSON in a string. */
  private async add({ input, operation }: LambdaCall, caller: LambdaCaller): Promise<LambdaAnswer> {
    const target = await this.target(caller);
    refuseUnknownFields(input, operation.name, TAKEN);
    const { statementId, statement } = statementOf(input, target.arn);
    refuseMovedRevision(text(input, 'RevisionId'), target);
    await this.policies.add(caller.accountId, target.function_.id, target.qualifier, statementId, statement);
    return { status: 201, document: { Statement: JSON.stringify(statement) } };
  }

  /** The policy the request names; a version or an alias the function hasn't, refused as Lambda refuses it. */
  private async target(caller: LambdaCaller): Promise<PolicyTarget> {
    const function_ = namedFunction(caller);
    const qualifier = caller.named?.qualifier;
    const arn = qualifiedFunctionArn(caller.region, caller.accountId, function_.name, qualifier);
    const named = parseQualifier(qualifier);
    if (!named) return { function_, arn, revisionId: function_.revisionId };
    const lookup: Promise<{ revisionId: string }> =
      'version' in named ? this.versions.get(caller.accountId, function_.id, named.version) : this.aliases.get(caller.accountId, function_.id, named.alias);
    const { revisionId } = await qualifiedLookup(lookup, caller, function_, qualifier);
    return { function_, qualifier, arn, revisionId };
  }
}

/** A RevisionId sent that isn't the function's, its version's or its alias's: a change came since it was read. */
function refuseMovedRevision(sent: string | undefined, target: PolicyTarget): void {
  if (sent !== undefined && sent !== target.revisionId) throw preconditionFailed(REVISION_MOVED);
}

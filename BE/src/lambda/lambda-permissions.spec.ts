/**
 * L1: Lambda's permissions, kept as sent and given back without effect:
 * AddPermission's statement in Lambda's JSON, its principal and its limits
 * under the operators Lambda gives them, the function's own policy or a
 * version's or an alias's; GetPolicy, Lambda's document with the RevisionId of
 * what it is the policy of; RemovePermission; each refusal in Lambda's words.
 * The statements' store is the database spec's.
 */
import { NotFoundException } from '@nestjs/common';
import { FunctionAliasesService } from '../functions/aliases.service';
import { Function } from '../functions/entities/function.entity';
import { FunctionPoliciesService } from '../functions/policies.service';
import { FunctionVersionsService } from '../functions/versions.service';
import { LambdaPermissions, statementOf } from './lambda-permissions';
import { ACCOUNT, REGION, lambdaCall, lambdaCaller, refused } from './test-fixtures';

const POLICY = '/2015-03-31/functions/orders/policy';
const ARN = `arn:aws:lambda:${REGION}:${ACCOUNT}:function:orders`;

describe("Lambda's permissions (L1)", () => {
  let function_: Function;
  /** Each policy's statements, by what it is the policy of: '' for the function's own. */
  let kept: Map<string, Array<Record<string, unknown>>>;
  let policies: { policy: jest.Mock; add: jest.Mock; remove: jest.Mock };
  let handlers: LambdaPermissions;

  beforeEach(() => {
    function_ = Object.assign(new Function(), { id: 'f-orders', accountId: ACCOUNT, name: 'orders', revisionId: 'rev-latest' });
    kept = new Map();
    const held = (qualifier?: string) => kept.get(qualifier ?? '') ?? [];
    policies = {
      policy: jest.fn(async (_account: string, _id: string, qualifier?: string) => held(qualifier)),
      add: jest.fn(async (_account: string, _id: string, qualifier: string | undefined, _sid: string, statement: Record<string, unknown>) => {
        kept.set(qualifier ?? '', [...held(qualifier), statement]);
      }),
      remove: jest.fn(async (_account: string, _id: string, qualifier: string | undefined, sid: string) => {
        const after = held(qualifier).filter((statement) => statement.Sid !== sid);
        if (after.length === held(qualifier).length) throw new NotFoundException(`Statement ${sid} is not found in resource policy.`);
        kept.set(qualifier ?? '', after);
      }),
    };
    const versions = {
      get: jest.fn(async (_account: string, _id: string, number: number) => {
        if (number !== 1) throw new NotFoundException('no such version');
        return { version: '1', revisionId: 'rev-v1' };
      }),
    };
    const aliases = {
      get: jest.fn(async (_account: string, _id: string, name: string) => {
        if (name !== 'live') throw new NotFoundException('no such alias');
        return { name, revisionId: 'rev-live' };
      }),
    };
    handlers = new LambdaPermissions(
      policies as unknown as FunctionPoliciesService,
      versions as unknown as FunctionVersionsService,
      aliases as unknown as FunctionAliasesService,
    );
  });

  /** A request as the front door hands it on: the function its path names found, a qualifier from its name or its query. */
  function ask(method: string, target: string, input: Record<string, unknown> = {}, qualifier?: string) {
    const call = lambdaCall(method, target, input);
    return handlers.handlers[call.operation.name](call, lambdaCaller({ function_, named: { name: 'orders', ...(qualifier ? { qualifier } : {}) } }));
  }
  const add = (input: Record<string, unknown>, qualifier?: string) => ask('POST', POLICY, input, qualifier);
  const policyOf = async (qualifier?: string) => {
    const answer = await ask('GET', POLICY, {}, qualifier);
    const document = answer.document as { Policy: string; RevisionId: string };
    return { status: answer.status, policy: JSON.parse(document.Policy) as Record<string, unknown>, revisionId: document.RevisionId };
  };

  it("keeps a statement as Lambda writes it, answering it in a string, and GetPolicy gives the policy back with the function's RevisionId", async () => {
    const sent = { StatementId: 's3', Action: 'lambda:InvokeFunction', Principal: 's3.amazonaws.com', SourceArn: 'arn:aws:s3:::photos', SourceAccount: ACCOUNT };
    const answer = await add(sent);

    const statement = {
      Sid: 's3',
      Effect: 'Allow',
      Principal: { Service: 's3.amazonaws.com' },
      Action: 'lambda:InvokeFunction',
      Resource: ARN,
      Condition: { StringEquals: { 'AWS:SourceAccount': ACCOUNT }, ArnLike: { 'AWS:SourceArn': 'arn:aws:s3:::photos' } },
    };
    expect(answer.status).toBe(201);
    expect(JSON.parse((answer.document as { Statement: string }).Statement)).toEqual(statement);
    expect(policies.add).toHaveBeenCalledWith(ACCOUNT, 'f-orders', undefined, 's3', statement);
    expect(await policyOf()).toEqual({ status: 200, policy: { Version: '2012-10-17', Id: 'default', Statement: [statement] }, revisionId: 'rev-latest' });
  });

  it("writes the principals and the limits as Lambda does: anyone, an account's root, an ARN, a public URL's two statements", () => {
    const principal = (Principal: string) => statementOf({ StatementId: 'p', Action: 'lambda:InvokeFunction', Principal }, ARN).statement.Principal;
    expect([principal('*'), principal('111122223333'), principal('arn:aws:iam::111122223333:role/caller'), principal('events.amazonaws.com')]).toEqual([
      '*',
      { AWS: 'arn:aws:iam::111122223333:root' },
      { AWS: 'arn:aws:iam::111122223333:role/caller' },
      { Service: 'events.amazonaws.com' },
    ]);

    // What Terraform's provider adds beside a URL open to all, as AWS asks since 2025.
    const open = statementOf({ StatementId: 'FunctionURLAllowPublicAccess', Action: 'lambda:InvokeFunctionUrl', Principal: '*', FunctionUrlAuthType: 'NONE' }, ARN);
    const invoke = statementOf({ StatementId: 'FunctionURLAllowInvokeAction', Action: 'lambda:InvokeFunction', Principal: '*', InvokedViaFunctionUrl: true }, ARN);
    expect([open.statement.Condition, invoke.statement.Condition]).toEqual([
      { StringEquals: { 'lambda:FunctionUrlAuthType': 'NONE' } },
      { Bool: { 'lambda:InvokedViaFunctionUrl': 'true' } },
    ]);
    const limited = statementOf(
      { StatementId: 'org', Action: 'lambda:*', Principal: '*', PrincipalOrgID: 'o-a1b2c3d4e5', EventSourceToken: 'alexa.skill-1', InvokedViaFunctionUrl: false },
      ARN,
    );
    expect(limited.statement.Condition).toEqual({ StringEquals: { 'lambda:EventSourceToken': 'alexa.skill-1', 'aws:PrincipalOrgID': 'o-a1b2c3d4e5' } });
  });

  it("keeps a version's and an alias's policy apart from the function's, each with its own ARN and RevisionId", async () => {
    await add({ StatementId: 'v1', Action: 'lambda:InvokeFunction', Principal: '*' }, '1');
    await add({ StatementId: 'live', Action: 'lambda:InvokeFunction', Principal: '*' }, 'live');

    expect(policies.add.mock.calls.map((call: unknown[]) => [call[2], (call[4] as { Resource: string }).Resource])).toEqual([
      ['1', `${ARN}:1`],
      ['live', `${ARN}:live`],
    ]);
    expect((await policyOf('1')).revisionId).toBe('rev-v1');
    expect((await policyOf('live')).revisionId).toBe('rev-live');
    expect(await refused(ask('GET', POLICY))).toEqual([404, 'ResourceNotFoundException', 'The resource you requested does not exist.']);
  });

  it('removes a statement by its ID, and the policy without one is none, as Lambda says it', async () => {
    await add({ StatementId: 'once', Action: 'lambda:InvokeFunction', Principal: '*' });

    expect((await ask('DELETE', `${POLICY}/once`)).status).toBe(204);
    expect(policies.remove).toHaveBeenCalledWith(ACCOUNT, 'f-orders', undefined, 'once');
    expect(await refused(ask('GET', POLICY))).toEqual([404, 'ResourceNotFoundException', 'The resource you requested does not exist.']);
    expect(await refused(ask('DELETE', `${POLICY}/once`))).toEqual([404, 'ResourceNotFoundException', 'Statement once is not found in resource policy.']);
  });

  it("checks a RevisionId sent against the function's, its version's or its alias's, as Lambda does", async () => {
    const moved =
      'The RevisionId provided does not match the latest RevisionId for the Lambda function or alias. Call the GetFunction or the GetAlias API to retrieve the latest RevisionId for your resource.';
    const statement = { StatementId: 'r', Action: 'lambda:InvokeFunction', Principal: '*' };

    expect(await refused(add({ ...statement, RevisionId: 'rev-v1' }))).toEqual([412, 'PreconditionFailedException', moved]);
    expect((await add({ ...statement, RevisionId: 'rev-v1' }, '1')).status).toBe(201);
    expect(await refused(ask('DELETE', `${POLICY}/r?RevisionId=rev-latest`, {}, '1'))).toEqual([412, 'PreconditionFailedException', moved]);
    expect((await ask('DELETE', `${POLICY}/r?RevisionId=rev-v1`, {}, '1')).status).toBe(204);
    expect(policies.add).toHaveBeenCalledTimes(1);
  });

  it('refuses in Lambda\'s words a field missing, one out of its form, one it doesn\'t take, and a version or an alias the function hasn\'t', async () => {
    const statement = { StatementId: 's', Action: 'lambda:InvokeFunction', Principal: '*' };
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ Action: 'lambda:InvokeFunction', Principal: '*' }, 'AddPermission needs StatementId.'],
      [{ ...statement, StatementId: 'a b' }, 'StatementId must be 1 to 100 letters, digits, hyphens or underscores, not a b.'],
      [{ ...statement, Action: 'invoke' }, "Action must be one of Lambda's actions, as lambda:InvokeFunction, or lambda:* or *, not invoke."],
      [{ ...statement, Principal: 'two words' }, "Principal must be a service, as s3.amazonaws.com, an account's 12 digits, an ARN, or *, without spaces, not two words."],
      [{ ...statement, SourceAccount: '123' }, "SourceAccount must be an account's 12 digits, not 123."],
      [{ ...statement, SourceArn: 'photos' }, "SourceArn must be a resource's ARN, not photos."],
      [{ ...statement, FunctionUrlAuthType: 'KEY' }, 'FunctionUrlAuthType must be NONE or AWS_IAM, not KEY.'],
      [{ ...statement, InvokedViaFunctionUrl: 'yes' }, 'InvokedViaFunctionUrl must be true or false, not yes.'],
      [{ ...statement, Condition: {} }, "FF doesn't take Condition in AddPermission."],
    ];
    for (const [input, message] of cases) expect(await refused(add(input))).toEqual([400, 'InvalidParameterValueException', message]);

    expect(await refused(add(statement, '7'))).toEqual([404, 'ResourceNotFoundException', `Function not found: ${ARN}:7`]);
    expect(await refused(ask('GET', POLICY, {}, 'beta'))).toEqual([404, 'ResourceNotFoundException', `Function not found: ${ARN}:beta`]);
    expect(await refused(ask('DELETE', `${POLICY}/a%20b`))).toEqual([
      400,
      'InvalidParameterValueException',
      'StatementId must be 1 to 100 letters, digits, dots, hyphens or underscores, not a b.',
    ]);
    expect(policies.add).not.toHaveBeenCalled();
  });
});

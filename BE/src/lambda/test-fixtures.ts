// Lambda's requests for tests (not part of the build: tsconfig.build.json excludes test-fixtures.ts).
import { HttpException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { plan } from '../plans/test-fixtures';
import { LambdaError, lambdaErrorOf } from './lambda-error';
import { LambdaCall, LambdaCaller, operationOf } from './lambda-operations';

export const ACCOUNT = '000000000001';
export const REGION = 'tn-tunis-1';
export const ROLE = `arn:aws:iam::${ACCOUNT}:role/orders`;
export const ZIP = Buffer.from('the zip, as sent');
export const SHA = createHash('sha256').update(ZIP).digest('base64');

/** What Terraform's provider sent the spike for a function with variables, tags and a version. */
export const TERRAFORM = {
  Code: { ZipFile: ZIP.toString('base64') },
  Description: '',
  Environment: { Variables: { STAGE: 'spike' } },
  FunctionName: 'orders',
  Handler: 'index.handler',
  MemorySize: 128,
  PackageType: 'Zip',
  Publish: true,
  Role: ROLE,
  Runtime: 'nodejs24.x',
  Tags: { team: 'spike' },
  Timeout: 10,
};

/** What the AWS CLI sends with only what create-function requires. */
export const CLI = { FunctionName: 'orders', Runtime: 'python3.13', Role: ROLE, Handler: 'app.handler', Code: { ZipFile: ZIP.toString('base64') } };

/** A request as the front door hands it to its operation: the operation its method and its path name, its query, its JSON body. */
export function lambdaCall(method: string, target: string, input: Record<string, unknown> = {}): LambdaCall {
  const [path, rawQuery = ''] = target.split('?');
  const route = operationOf(method, path);
  if (!route) throw new Error(`no operation at ${method} ${path}`);
  return { operation: route.operation, groups: route.groups, query: new URLSearchParams(rawQuery), input, body: Buffer.alloc(0), headers: {} };
}

/** Who makes a request, as the front door found them: an access key that may do anything, in the account's region, and `more`. */
export function lambdaCaller(more: Partial<LambdaCaller> = {}): LambdaCaller {
  return {
    accountId: ACCOUNT,
    region: REGION,
    key: {} as LambdaCaller['key'],
    plan: plan(),
    mayUse: () => true,
    actor: { id: 'access_key:AKFF', label: 'access key AKFF' },
    ...more,
  };
}

/** The error an operation throws, as the front door answers it: FF's services' refusals in Lambda's words. */
export async function lambdaRefusal(answer: Promise<unknown>): Promise<LambdaError> {
  const thrown = await answer.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  const error = thrown instanceof HttpException ? lambdaErrorOf(thrown, REGION) : thrown;
  if (!(error instanceof LambdaError)) throw new Error(`not refused in Lambda's words: ${String(error)}`);
  return error;
}

/** The refusal's status, its type and its message. */
export async function refused(answer: Promise<unknown>): Promise<[number, string, string]> {
  const error = await lambdaRefusal(answer);
  return [error.status, error.type, error.message];
}

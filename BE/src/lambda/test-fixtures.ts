// Lambda's requests for tests (not part of the build: tsconfig.build.json excludes test-fixtures.ts).
import { createHash } from 'node:crypto';

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

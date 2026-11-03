/**
 * L1: Lambda's requests that change functions, checked as Lambda checks them:
 * CreateFunction's, UpdateFunctionConfiguration's and UpdateFunctionCode's,
 * each field kept, mapped onto FF's, or refused saying why.
 */
import { Runtime } from '../functions/entities/function.entity';
import { plan } from '../plans/test-fixtures';
import { LambdaError } from './lambda-error';
import { createFunctionRequest, updateCodeRequest, updateConfigurationRequest } from './lambda-function-requests';
import { ACCOUNT, CLI, REGION, ROLE, TERRAFORM, ZIP } from './test-fixtures';

const CALLER = { accountId: ACCOUNT, region: REGION, plan: plan() };

/** The refusal's message, in Lambda's words. */
function refusal(attempt: () => unknown): string {
  try {
    attempt();
  } catch (error) {
    if (error instanceof LambdaError && error.type === 'InvalidParameterValueException') return error.message;
    throw error;
  }
  throw new Error('not refused');
}

describe("CreateFunction's request, checked (L1)", () => {
  it("maps Terraform's request onto FF's create: its fields, its code, its description and role kept, its tags, its version", () => {
    expect(createFunctionRequest(TERRAFORM, CALLER)).toEqual({
      fields: { name: 'orders', runtime: Runtime.NODEJS, handler: 'index.handler', memory: 128, timeout: 10, environment: { STAGE: 'spike' } },
      code: { zip: ZIP },
      description: '',
      role: ROLE,
      tags: { team: 'spike' },
      publish: true,
    });
  });

  it("takes Lambda's defaults for what the CLI leaves out: 128 MB, 3 seconds, no variables, no tags, no version", () => {
    expect(createFunctionRequest(CLI, CALLER)).toEqual({
      fields: { name: 'orders', runtime: Runtime.PYTHON, handler: 'app.handler', memory: 128, timeout: 3 },
      code: { zip: ZIP },
      description: '',
      role: ROLE,
      publish: false,
    });
  });

  it('takes the name as an ARN of the account, settings at the one value FF has, those it lacks sent empty, and code in a bucket', () => {
    const request = createFunctionRequest(
      {
        ...CLI,
        FunctionName: `arn:aws:lambda:${REGION}:${ACCOUNT}:function:orders`,
        Code: { S3Bucket: 'builds', S3Key: 'orders/v1.zip' },
        Architectures: ['x86_64'],
        EphemeralStorage: { Size: 512 },
        TracingConfig: { Mode: 'PassThrough' },
        SnapStart: { ApplyOn: 'None' },
        LoggingConfig: { LogFormat: 'Text', LogGroup: '/aws/lambda/orders' },
        VpcConfig: { SubnetIds: [], SecurityGroupIds: [], Ipv6AllowedForDualStack: false },
        Layers: [],
        KMSKeyArn: '',
        DeadLetterConfig: {},
        Tags: {},
      },
      CALLER,
    );

    expect(request).toMatchObject({ fields: { name: 'orders' }, code: { bucket: 'builds', key: 'orders/v1.zip' } });
    expect(request).not.toHaveProperty('tags');
  });

  it('refuses a runtime FF lacks, naming its two, and a request without what Lambda requires', () => {
    expect(refusal(() => createFunctionRequest({ ...CLI, Runtime: 'nodejs22.x' }, CALLER))).toBe("The runtime nodejs22.x isn't FF's: FF runs nodejs24.x or python3.13.");
    expect(refusal(() => createFunctionRequest({ ...CLI, Runtime: undefined }, CALLER))).toBe('Runtime is required for a .zip package: nodejs24.x or python3.13.');
    for (const Role of [undefined, 'orders', 'arn:aws:iam::000000000001:user/orders']) {
      expect(refusal(() => createFunctionRequest({ ...CLI, Role }, CALLER))).toBe(
        "Role must be an IAM role's ARN, arn:aws:iam::<account>:role/<name>: FF keeps it, with no effect, as FF has no IAM.",
      );
    }
    expect(refusal(() => createFunctionRequest({ ...CLI, Handler: undefined }, CALLER))).toBe('Handler is required for a .zip package: <file>.<function>, as index.handler.');
    expect(refusal(() => createFunctionRequest({ ...CLI, Handler: 'index' }, CALLER))).toMatch(/^handler must be <file>\.<function>/);
    expect(refusal(() => createFunctionRequest({ ...CLI, Code: undefined }, CALLER))).toBe('Code is required: ZipFile, the zip in base64, or S3Bucket and S3Key, where it is.');
  });

  it("refuses code that isn't a zip in base64 or a bucket's object, both at once, an object's version, and an image", () => {
    const code = (Code: unknown) => refusal(() => createFunctionRequest({ ...CLI, Code }, CALLER));
    expect(code({ ZipFile: 'not base64!' })).toBe('Code.ZipFile must be the zip in base64.');
    expect(code({ ZipFile: 'QUJD', S3Bucket: 'builds', S3Key: 'a.zip' })).toBe('Code holds ZipFile, or S3Bucket and S3Key: not both.');
    expect(code({ S3Bucket: 'builds' })).toBe("Code needs S3Bucket and S3Key: the account's bucket where the zip is, and its key.");
    expect(code({ S3Bucket: 'builds', S3Key: 'a.zip', S3ObjectVersion: '3' })).toBe("FF's buckets keep no object versions: send Code without S3ObjectVersion.");
    expect(code({ ImageUri: 'repo/orders:1' })).toBe('FF runs .zip packages, not container images. Send Code.ZipFile, or Code.S3Bucket and S3Key.');
  });

  it("refuses sizes past Lambda's bounds or the plan's, a description past 256 characters, and Publish that isn't a boolean", () => {
    expect(refusal(() => createFunctionRequest({ ...CLI, MemorySize: 64 }, CALLER))).toBe('MemorySize must be a whole number of MB from 128 to 10240, not 64.');
    expect(refusal(() => createFunctionRequest({ ...CLI, MemorySize: 2048 }, CALLER))).toBe('MemorySize must be at most 1024 MB on the Beta plan.');
    expect(refusal(() => createFunctionRequest({ ...CLI, Timeout: 1.5 }, CALLER))).toBe('Timeout must be a whole number of seconds from 1 to 900, not 1.5.');
    expect(refusal(() => createFunctionRequest({ ...CLI, Timeout: 600 }, CALLER))).toBe('Timeout must be at most 300 seconds on the Beta plan.');
    expect(refusal(() => createFunctionRequest({ ...CLI, Description: 'd'.repeat(257) }, CALLER))).toBe('Description must be a string of 256 characters at most.');
    expect(refusal(() => createFunctionRequest({ ...CLI, Publish: 'yes' }, CALLER))).toBe('Publish must be true or false.');
  });

  it('refuses what would change what runs and FF can\'t do, saying why, and a field it doesn\'t know', () => {
    const refused = (more: Record<string, unknown>) => refusal(() => createFunctionRequest({ ...CLI, ...more }, CALLER));
    expect(refused({ PackageType: 'Image' })).toBe('FF runs .zip packages, not container images. PackageType must be Zip.');
    expect(refused({ Architectures: ['arm64'] })).toBe('FF runs x86_64 alone: Architectures must be [x86_64].');
    expect(refused({ EphemeralStorage: { Size: 1024 } })).toBe("A function's /tmp holds 512 MB on FF: EphemeralStorage.Size must be 512.");
    expect(refused({ TracingConfig: { Mode: 'Active' } })).toBe('FF has no X-Ray: TracingConfig.Mode must be PassThrough, which passes a trace header on.');
    expect(refused({ SnapStart: { ApplyOn: 'PublishedVersions' } })).toBe('FF has no SnapStart: SnapStart.ApplyOn must be None.');
    expect(refused({ LoggingConfig: { LogFormat: 'JSON' } })).toBe("FF's logs are text, in the log group /aws/lambda/orders: LoggingConfig takes LogFormat Text and that LogGroup alone.");
    expect(refused({ LoggingConfig: { LogGroup: '/shared' } })).toMatch(/^FF's logs are text/);
    expect(refused({ VpcConfig: { SubnetIds: ['subnet-1'] } })).toBe(
      "FF's functions need no VPC: each one reaches its account's buckets, queues and databases without one. Send CreateFunction without VpcConfig.",
    );
    expect(refused({ Layers: ['arn:aws:lambda:tn-tunis-1:000000000001:layer:libs:1'] })).toBe("FF has no layers: put the libraries in the function's zip. Send CreateFunction without Layers.");
    expect(refused({ KMSKeyArn: 'arn:aws:kms:tn-tunis-1:000000000001:key/1' })).toMatch(/^FF seals what it keeps with its own keys/);
    expect(refused({ CapacityProviderConfig: {} })).toBe("FF doesn't take CapacityProviderConfig in CreateFunction.");
  });

  it("takes DeadLetterConfig's queue of the account, in its region, which the operation finds there; an empty one is none", () => {
    const queue = `arn:aws:sqs:${REGION}:${ACCOUNT}:failed-orders`;
    expect(createFunctionRequest({ ...CLI, DeadLetterConfig: { TargetArn: queue } }, CALLER)).toMatchObject({ deadLetterTargetArn: queue });
    for (const DeadLetterConfig of [{}, { TargetArn: '' }, { TargetArn: null }, null]) {
      expect(createFunctionRequest({ ...CLI, DeadLetterConfig }, CALLER)).not.toHaveProperty('deadLetterTargetArn');
    }
  });

  it("refuses a dead-letter queue that isn't a queue of the account's: an SNS topic, another account's or region's, no ARN, other fields", () => {
    const refused = (DeadLetterConfig: unknown) => refusal(() => createFunctionRequest({ ...CLI, DeadLetterConfig }, CALLER));
    const example = `arn:aws:sqs:${REGION}:${ACCOUNT}:<name>`;
    expect(refused({ TargetArn: `arn:aws:sns:${REGION}:${ACCOUNT}:failed` })).toBe(`FF has no SNS topics: a dead-letter queue is a queue of the account, ${example}.`);
    expect(refused({ TargetArn: `arn:aws:sqs:${REGION}:000000000002:failed` })).toBe(
      `DeadLetterConfig's TargetArn must be a queue of this account, in ${REGION}: arn:aws:sqs:${REGION}:${ACCOUNT}:failed.`,
    );
    expect(refused({ TargetArn: `arn:aws:sqs:eu-west-1:${ACCOUNT}:failed` })).toMatch(/^DeadLetterConfig's TargetArn must be a queue of this account/);
    expect(refused({ TargetArn: 'failed' })).toBe(`DeadLetterConfig's TargetArn must be a queue's ARN, ${example}, not failed.`);
    expect(refused({ TargetArn: 7 })).toBe(`DeadLetterConfig's TargetArn must be a queue's ARN, ${example}, not 7.`);
    expect(refused({ TargetArn: 'x', Queue: 'failed' })).toBe(`DeadLetterConfig takes TargetArn alone, a queue's ARN: ${example}.`);
    expect(refused('failed')).toBe(`DeadLetterConfig takes TargetArn alone, a queue's ARN: ${example}.`);
  });

  it("refuses a name qualified or of another account, variables and tags that FF's rules refuse", () => {
    expect(refusal(() => createFunctionRequest({ ...CLI, FunctionName: 'orders:3' }, CALLER))).toBe(
      'FunctionName names the function to create, without a version or an alias: not orders:3.',
    );
    expect(refusal(() => createFunctionRequest({ ...CLI, FunctionName: '000000000002:function:orders' }, CALLER))).toBe(
      'A key creates functions in its own account, 000000000001, in tn-tunis-1: not 000000000002:function:orders.',
    );
    expect(refusal(() => createFunctionRequest({ ...CLI, Environment: { Variables: { AWS_REGION: 'x' } } }, CALLER))).toMatch(/AWS_REGION/);
    expect(refusal(() => createFunctionRequest({ ...CLI, Environment: { Variables: {}, Error: {} } }, CALLER))).toBe(
      'Environment must be an object with Variables, the variables by name.',
    );
    expect(refusal(() => createFunctionRequest({ ...CLI, Tags: { 'aws:team': 'x' } }, CALLER))).toBe('The key aws:team starts with aws:, which AWS keeps for its own tags.');
  });
});

describe("UpdateFunctionConfiguration's request, checked (L1)", () => {
  const ORDERS = { name: 'orders', memory: 2048, timeout: 30 };
  const change = (input: Record<string, unknown>) => updateConfigurationRequest(input, CALLER, ORDERS);

  it("changes what the spike's tools sent, the variables replacing them all; Lambda's fields beside FF's", () => {
    expect(change({ Timeout: 10, Environment: { Variables: { STAGE: 'spike' } } })).toEqual({ fields: { timeout: 10, environment: { STAGE: 'spike' } }, lambda: {} });
    expect(change({ Runtime: 'python3.13', Handler: 'app.handler', MemorySize: 512, Description: 'Orders', Role: ROLE, RevisionId: 'rev-1' })).toEqual({
      fields: { runtime: Runtime.PYTHON, handler: 'app.handler', memory: 512 },
      lambda: { description: 'Orders', role: ROLE, revisionId: 'rev-1' },
    });
    expect(change({ Environment: {} })).toEqual({ fields: { environment: {} }, lambda: {} });
    // An empty TargetArn removes the dead-letter queue, as on Lambda.
    const queue = `arn:aws:sqs:${REGION}:${ACCOUNT}:failed-orders`;
    expect(change({ DeadLetterConfig: { TargetArn: queue } })).toEqual({ fields: {}, lambda: { deadLetterTargetArn: queue } });
    expect(change({ DeadLetterConfig: { TargetArn: '' } })).toEqual({ fields: {}, lambda: { deadLetterTargetArn: null } });
    expect(change({})).toEqual({ fields: {}, lambda: {} });
  });

  it("keeps the function's own size past the plan's, which an older plan gave it, and refuses another", () => {
    expect(change({ MemorySize: 2048 }).fields).toEqual({ memory: 2048 });
    expect(refusal(() => change({ MemorySize: 1536 }))).toBe('MemorySize must be at most 1024 MB on the Beta plan.');
  });

  it("refuses what CreateFunction refuses, saying so for this operation, and what it doesn't take", () => {
    expect(refusal(() => change({ Runtime: 'nodejs22.x' }))).toBe("The runtime nodejs22.x isn't FF's: FF runs nodejs24.x or python3.13.");
    expect(refusal(() => change({ Layers: ['arn:aws:lambda:tn-tunis-1:000000000001:layer:libs:1'] }))).toBe(
      "FF has no layers: put the libraries in the function's zip. Send UpdateFunctionConfiguration without Layers.",
    );
    expect(refusal(() => change({ LoggingConfig: { LogGroup: '/aws/lambda/other' } }))).toMatch(/log group \/aws\/lambda\/orders/);
    expect(refusal(() => change({ Publish: true }))).toBe("FF doesn't take Publish in UpdateFunctionConfiguration.");
    expect(refusal(() => change({ RevisionId: 7 }))).toBe('RevisionId must be the one that GetFunction answered.');
  });
});

describe("UpdateFunctionCode's request, checked (L1)", () => {
  it('takes the zip, or where it is, with Publish, DryRun and RevisionId', () => {
    expect(updateCodeRequest({ ZipFile: ZIP.toString('base64') })).toEqual({ code: { zip: ZIP }, publish: false, dryRun: false });
    expect(updateCodeRequest({ S3Bucket: 'builds', S3Key: 'orders/v2.zip', Publish: true, DryRun: false, RevisionId: 'rev-1', Architectures: ['x86_64'] })).toEqual({
      code: { bucket: 'builds', key: 'orders/v2.zip' },
      publish: true,
      dryRun: false,
      revisionId: 'rev-1',
    });
  });

  it("refuses no code, both kinds, an image, an object's version, another architecture, and a field it doesn't take", () => {
    const code = (input: Record<string, unknown>) => refusal(() => updateCodeRequest(input));
    expect(code({})).toBe('UpdateFunctionCode needs ZipFile, the zip in base64, or S3Bucket and S3Key, where it is.');
    expect(code({ ZipFile: 'QUJD', S3Bucket: 'builds', S3Key: 'a.zip' })).toBe('UpdateFunctionCode holds ZipFile, or S3Bucket and S3Key: not both.');
    expect(code({ ImageUri: 'repo/orders:2' })).toBe('FF runs .zip packages, not container images. Send ZipFile, or S3Bucket and S3Key.');
    expect(code({ S3Bucket: 'builds', S3Key: 'a.zip', S3ObjectVersion: '3' })).toBe("FF's buckets keep no object versions: send UpdateFunctionCode without S3ObjectVersion.");
    expect(code({ ZipFile: 'QUJD', Architectures: ['arm64'] })).toBe('FF runs x86_64 alone: Architectures must be [x86_64].');
    expect(code({ Code: { ZipFile: 'QUJD' } })).toBe("FF doesn't take Code in UpdateFunctionCode.");
    expect(code({ ZipFile: 'QUJD', DryRun: 'yes' })).toBe('DryRun must be true or false.');
  });
});

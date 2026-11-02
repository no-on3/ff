/**
 * L1: Lambda's CreateFunction and DeleteFunction over FF's functions: the
 * request checked field by field, kept, mapped onto FF's or refused; the
 * code sent or read from the account's bucket; the answer at once, Pending,
 * the rollout after; a function or one of its versions deleted.
 */
import { BadRequestException, HttpException, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { Function, FunctionStatus, PackageType, Runtime } from '../functions/entities/function.entity';
import { FunctionsService, WhenActive } from '../functions/functions.service';
import { FunctionVersionsService } from '../functions/versions.service';
import { PackagesService } from '../packages/packages.service';
import { plan } from '../plans/test-fixtures';
import { StorageDirectory } from '../storage/storage-directory.service';
import { StoreBuckets } from '../storage/store-buckets';
import { ResourceTagsService } from '../tags/resource-tags.service';
import { LambdaError, lambdaErrorOf } from './lambda-error';
import { LambdaFunctionChanges, createFunctionRequest } from './lambda-function-changes';
import { LambdaCall, LambdaCaller, operationOf } from './lambda-operations';

const ACCOUNT = '000000000001';
const REGION = 'tn-tunis-1';
const ROLE = `arn:aws:iam::${ACCOUNT}:role/orders`;
const ZIP = Buffer.from('the zip, as sent');
const SHA = createHash('sha256').update(ZIP).digest('base64');

/** What Terraform's provider sent the spike for a function with variables, tags and a version. */
const TERRAFORM = {
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
const CLI = { FunctionName: 'orders', Runtime: 'python3.13', Role: ROLE, Handler: 'app.handler', Code: { ZipFile: ZIP.toString('base64') } };

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
    expect(refused({ DeadLetterConfig: { TargetArn: 'arn:aws:sqs:tn-tunis-1:000000000001:dlq' } })).toBe(
      "FF doesn't send failed events to a dead-letter queue yet. Send CreateFunction without DeadLetterConfig.",
    );
    expect(refused({ CapacityProviderConfig: {} })).toBe("FF doesn't take CapacityProviderConfig in CreateFunction.");
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

describe("Lambda's CreateFunction and DeleteFunction (L1)", () => {
  let changes: LambdaFunctionChanges;
  let uploaded: Buffer[];
  let existing: Function[];
  let rollOut: jest.Mock<Promise<unknown>, [WhenActive?]>;
  const saved = Object.assign(new Function(), {
    id: 'f-orders',
    accountId: ACCOUNT,
    name: 'orders',
    runtime: Runtime.NODEJS,
    handler: 'index.handler',
    packageType: PackageType.ZIP,
    codeSha256: SHA,
    codeSize: ZIP.length,
    memory: 128,
    timeout: 10,
    status: FunctionStatus.CREATING,
    error: null,
    description: 'Orders',
    role: ROLE,
    revisionId: 'rev-1',
    updatedAt: new Date('2026-11-02T12:00:00.000Z'),
  });
  const functions = { findAll: jest.fn(async () => existing), startCreate: jest.fn(), remove: jest.fn() };
  const versions = { publishIn: jest.fn(), labelLatest: jest.fn(), remove: jest.fn() };
  const packages = {
    upload: jest.fn(async (_account: string, body: Readable) => {
      for await (const chunk of body) uploaded.push(Buffer.from(chunk as Buffer));
      return { created: true, package: { codeSha256: SHA } };
    }),
  };
  const tags = { tagFunction: jest.fn() };
  const directory = { bucket: jest.fn(), account: jest.fn() };
  const store = { object: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    uploaded = [];
    existing = [];
    rollOut = jest.fn(async () => undefined);
    functions.startCreate.mockImplementation(async () => ({ function_: saved, environment: { variables: { STAGE: 'spike' }, secrets: {} }, rollOut }));
    directory.bucket.mockResolvedValue({ name: 'builds', accountId: ACCOUNT, storeName: 'b-1234' });
    directory.account.mockResolvedValue({ id: ACCOUNT, storageDisabledAt: null });
    store.object.mockImplementation(async () => ({ body: Readable.from([ZIP]), length: ZIP.length }));
    changes = new LambdaFunctionChanges(
      functions as unknown as FunctionsService,
      versions as unknown as FunctionVersionsService,
      packages as unknown as PackagesService,
      tags as unknown as ResourceTagsService,
      directory as unknown as StorageDirectory,
      store as unknown as StoreBuckets,
    );
  });

  /** A request as the front door hands it on: the function it names found, where a path names one. */
  function ask(method: string, target: string, input: Record<string, unknown> = {}, named?: LambdaCaller['named'], key: Partial<LambdaCaller['key']> = {}) {
    const [path, rawQuery = ''] = target.split('?');
    const route = operationOf(method, path);
    if (!route) throw new Error(`no operation at ${method} ${path}`);
    const call: LambdaCall = { operation: route.operation, groups: route.groups, query: new URLSearchParams(rawQuery), input, body: Buffer.alloc(0), headers: {} };
    const caller: LambdaCaller = {
      accountId: ACCOUNT,
      region: REGION,
      key: { buckets: null, queues: null, functions: null, ...key } as LambdaCaller['key'],
      plan: plan(),
      ...(route.operation.namedIn === 'path' ? { function_: saved } : {}),
      named: named ?? { name: 'orders' },
      mayUse: () => true,
      actor: { id: 'access_key:AKFF', label: 'access key AKFF' },
    };
    return changes.handlers[route.operation.name](call, caller);
  }

  /** A refusal as the front door answers it: FF's services' in Lambda's words. */
  async function refused(answer: Promise<unknown>): Promise<[number, string, string]> {
    const thrown = await answer.then(
      () => undefined,
      (failure: unknown) => failure,
    );
    const error = thrown instanceof HttpException ? lambdaErrorOf(thrown) : thrown;
    if (!(error instanceof LambdaError)) throw new Error(`not refused in Lambda's words: ${String(error)}`);
    return [error.status, error.type, error.message];
  }

  const create = (input: Record<string, unknown>) => ask('POST', '/2015-03-31/functions', input);

  it('stores the zip as a package, saves the function with its description, role and tags, and answers 201 Pending, the rollout after', async () => {
    const answer = await create({ ...TERRAFORM, Description: 'Orders' });

    expect(Buffer.concat(uploaded)).toEqual(ZIP);
    expect(packages.upload).toHaveBeenCalledWith(ACCOUNT, expect.any(Readable), 'application/zip', ZIP.length);
    expect(functions.startCreate).toHaveBeenCalledWith(
      ACCOUNT,
      expect.objectContaining({ name: 'orders', runtime: Runtime.NODEJS, handler: 'index.handler', memory: 128, timeout: 10, environment: { STAGE: 'spike' }, codeSha256: SHA }),
      { description: 'Orders', role: ROLE },
    );
    expect(tags.tagFunction).toHaveBeenCalledWith(ACCOUNT, 'f-orders', { team: 'spike' });
    expect(answer.status).toBe(201);
    expect(answer.document).toMatchObject({
      FunctionName: 'orders',
      FunctionArn: `arn:aws:lambda:${REGION}:${ACCOUNT}:function:orders`,
      Runtime: 'nodejs24.x',
      Role: ROLE,
      Description: 'Orders',
      CodeSha256: SHA,
      Environment: { Variables: { STAGE: 'spike' } },
      Version: '$LATEST',
      State: 'Pending',
      StateReasonCode: 'Creating',
    });
    expect(rollOut).toHaveBeenCalledTimes(1);
  });

  it('publishes the first version in the transaction that makes the function Active, when Publish says so, then labels $LATEST\'s pods', async () => {
    await create(TERRAFORM);
    const [whenActive] = rollOut.mock.calls[0];
    const manager = { transaction: 'the one that says ACTIVE' };

    await whenActive?.(manager as never, saved);
    await new Promise(setImmediate);

    expect(versions.publishIn).toHaveBeenCalledWith(manager, ACCOUNT, 'f-orders', {});
    expect(versions.labelLatest).toHaveBeenCalledWith(ACCOUNT, 'f-orders');

    rollOut.mockClear();
    await create(CLI);
    expect(rollOut).toHaveBeenCalledWith(undefined);
  });

  it("logs a rollout's failure only when nothing did: a failed deploy is in the function's record", async () => {
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    rollOut.mockRejectedValueOnce(new BadRequestException('The function failed to load: Error: boom'));
    await create(CLI);
    await new Promise(setImmediate);
    expect(logged).not.toHaveBeenCalled();

    rollOut.mockRejectedValueOnce(new Error('connection terminated'));
    await create(CLI);
    await new Promise(setImmediate);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('The rollout of function f-orders failed: connection terminated'), expect.any(String));
    logged.mockRestore();
  });

  it('refuses a name taken before storing anything, as Lambda does', async () => {
    existing = [saved];

    expect(await refused(create(CLI))).toEqual([409, 'ResourceConflictException', 'Function already exist: orders']);
    expect(packages.upload).not.toHaveBeenCalled();
  });

  it("refuses text with a NUL character, which FF's database can't keep", async () => {
    expect(await refused(create({ ...CLI, Description: 'a\u0000b' }))).toEqual([400, 'InvalidParameterValueException', 'Description must not contain the NUL character (U+0000)']);
  });

  it("reads the code from the account's bucket that the key reaches, by the store's name for it", async () => {
    await create({ ...CLI, Code: { S3Bucket: 'builds', S3Key: 'orders/v1.zip' } });

    expect(store.object).toHaveBeenCalledWith('b-1234', 'orders/v1.zip');
    expect(Buffer.concat(uploaded)).toEqual(ZIP);
  });

  it("refuses, in S3's words as Lambda passes them on, another account's bucket, one the key doesn't reach, storage turned off, a key not there", async () => {
    const fromBucket = { ...CLI, Code: { S3Bucket: 'builds', S3Key: 'orders/v1.zip' } };
    const s3 = (code: string, message: string) => [400, 'InvalidParameterValueException', `Error occurred while GetObject. S3 Error Code: ${code}. S3 Error Message: ${message}`];

    directory.bucket.mockResolvedValueOnce({ name: 'builds', accountId: '000000000002', storeName: 'b-5678' });
    expect(await refused(create(fromBucket))).toEqual(s3('NoSuchBucket', 'The specified bucket does not exist'));
    directory.bucket.mockResolvedValueOnce(null);
    expect(await refused(create(fromBucket))).toEqual(s3('NoSuchBucket', 'The specified bucket does not exist'));
    expect(await refused(ask('POST', '/2015-03-31/functions', fromBucket, undefined, { buckets: ['logs'] }))).toEqual(
      s3('AccessDenied', "The access key doesn't reach the bucket builds."),
    );
    directory.account.mockResolvedValueOnce({ id: ACCOUNT, storageDisabledAt: new Date(), storageDisabledReason: 'unpaid invoices' });
    expect(await refused(create(fromBucket))).toEqual(s3('AccessDenied', "FF turned the account's buckets off: unpaid invoices"));
    store.object.mockResolvedValueOnce(null);
    expect(await refused(create(fromBucket))).toEqual(s3('NoSuchKey', 'The specified key does not exist.'));
    expect(packages.upload).not.toHaveBeenCalled();
  });

  const path = '/2015-03-31/functions/orders';

  it('DeleteFunction deletes the function, or the version its qualifier names, answering 204', async () => {
    expect(await ask('DELETE', path)).toEqual({ status: 204 });
    expect(functions.remove).toHaveBeenCalledWith(ACCOUNT, 'f-orders');

    expect(await ask('DELETE', `${path}?Qualifier=3`, {}, { name: 'orders', qualifier: '3' })).toEqual({ status: 204 });
    expect(versions.remove).toHaveBeenCalledWith(ACCOUNT, 'f-orders', 3);
    expect(functions.remove).toHaveBeenCalledTimes(1);
  });

  it("refuses to delete $LATEST alone, which would delete the function, and an alias, which DeleteAlias deletes", async () => {
    expect(await refused(ask('DELETE', `${path}?Qualifier=%24LATEST`))).toEqual([
      400,
      'InvalidParameterValueException',
      '$LATEST goes with its function: send DeleteFunction without a qualifier to delete the function.',
    ]);
    expect(await refused(ask('DELETE', '/2015-03-31/functions/orders%3A%24LATEST'))).toEqual([
      400,
      'InvalidParameterValueException',
      '$LATEST goes with its function: send DeleteFunction without a qualifier to delete the function.',
    ]);
    expect(await refused(ask('DELETE', `${path}?Qualifier=live`, {}, { name: 'orders', qualifier: 'live' }))).toEqual([
      400,
      'InvalidParameterValueException',
      'DeleteFunction deletes a function or one of its versions, not the alias live: DeleteAlias deletes it.',
    ]);
    expect(functions.remove).not.toHaveBeenCalled();
    expect(versions.remove).not.toHaveBeenCalled();
  });
});

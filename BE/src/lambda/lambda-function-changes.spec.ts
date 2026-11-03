/**
 * L1: Lambda's changes of functions over FF's: the code sent or read from the
 * account's bucket; CreateFunction answered at once, Pending, and the updates
 * InProgress, the rollout after; a change while another runs refused in
 * Lambda's words; a dead-letter queue found in the account first; a function
 * or one of its versions deleted.
 */
import { BadRequestException, Logger } from '@nestjs/common';
import { Readable } from 'node:stream';
import { Function, FunctionStatus, PackageType, Runtime, UpdateStatus } from '../functions/entities/function.entity';
import { ChangeUnderWayException } from '../functions/change-under-way';
import { EventInvokeConfigService } from '../functions/event-invoke-config.service';
import { FunctionsService, WhenLive } from '../functions/functions.service';
import { FunctionVersionsService } from '../functions/versions.service';
import { PackagesService } from '../packages/packages.service';
import { StorageDirectory } from '../storage/storage-directory.service';
import { StoreBuckets } from '../storage/store-buckets';
import { ResourceTagsService } from '../tags/resource-tags.service';
import { LambdaFunctionChanges } from './lambda-function-changes';
import { LambdaCaller } from './lambda-operations';
import { ACCOUNT, CLI, REGION, ROLE, SHA, TERRAFORM, ZIP, lambdaCall, lambdaCaller, refused } from './test-fixtures';

describe("Lambda's changes of functions (L1)", () => {
  let changes: LambdaFunctionChanges;
  let uploaded: Buffer[];
  let existing: Function[];
  let rollOut: jest.Mock<Promise<unknown>, [WhenLive?]>;
  /** The function the path names, as the front door found it. */
  let pathFunction: Function;
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
    updateStatus: UpdateStatus.IN_PROGRESS,
    updateReason: null,
    updateStartedAt: new Date('2026-11-02T12:00:00.000Z'),
    description: 'Orders',
    role: ROLE,
    revisionId: 'rev-1',
    updatedAt: new Date('2026-11-02T12:00:00.000Z'),
  });
  /** The same function once it is Active, its create done. */
  const active = Object.assign(new Function(), { ...saved, status: FunctionStatus.ACTIVE, updateStatus: UpdateStatus.SUCCESSFUL, updateStartedAt: null });
  const functions = {
    findAll: jest.fn(async () => existing),
    startCreate: jest.fn(),
    startUpdate: jest.fn(),
    isChanging: jest.fn(() => false),
    describe: jest.fn(async () => ({ ...active, environment: { STAGE: 'spike' } })),
    remove: jest.fn(),
  };
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
  const configs = { destinationQueue: jest.fn() };
  const QUEUE = `arn:aws:sqs:${REGION}:${ACCOUNT}:failed-orders`;
  const NO_QUEUE = [400, 'InvalidParameterValueException', "The account has no queue named failed-orders-gone: DeadLetterConfig's TargetArn names one of its queues."];

  beforeEach(() => {
    jest.clearAllMocks();
    uploaded = [];
    existing = [];
    rollOut = jest.fn(async () => undefined);
    pathFunction = active;
    functions.startCreate.mockImplementation(async () => ({ function_: saved, environment: { variables: { STAGE: 'spike' }, secrets: {} }, rollsOut: true, rollOut }));
    functions.isChanging.mockReturnValue(false);
    directory.bucket.mockResolvedValue({ name: 'builds', accountId: ACCOUNT, storeName: 'b-1234' });
    directory.account.mockResolvedValue({ id: ACCOUNT, storageDisabledAt: null });
    store.object.mockImplementation(async () => ({ body: Readable.from([ZIP]), length: ZIP.length }));
    configs.destinationQueue.mockImplementation(async (_account: string, arn: string) => (arn === QUEUE ? { name: 'failed-orders' } : undefined));
    changes = new LambdaFunctionChanges(
      functions as unknown as FunctionsService,
      versions as unknown as FunctionVersionsService,
      packages as unknown as PackagesService,
      tags as unknown as ResourceTagsService,
      directory as unknown as StorageDirectory,
      store as unknown as StoreBuckets,
      configs as unknown as EventInvokeConfigService,
    );
  });

  /** A request as the front door hands it on: the function it names found, where a path names one. */
  function ask(method: string, target: string, input: Record<string, unknown> = {}, named?: LambdaCaller['named'], key: Partial<LambdaCaller['key']> = {}) {
    const call = lambdaCall(method, target, input);
    const caller = lambdaCaller({
      key: { buckets: null, queues: null, functions: null, ...key } as LambdaCaller['key'],
      ...(call.operation.namedIn === 'path' ? { function_: pathFunction } : {}),
      named: named ?? { name: 'orders' },
    });
    return changes.handlers[call.operation.name](call, caller);
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
    const [whenLive] = rollOut.mock.calls[0];
    const manager = { transaction: 'the one that says ACTIVE' };

    await whenLive?.(manager as never, saved);
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

  it('keeps a dead-letter queue of the account, found there before the code is stored', async () => {
    expect(await refused(create({ ...CLI, DeadLetterConfig: { TargetArn: `${QUEUE}-gone` } }))).toEqual(NO_QUEUE);
    expect(packages.upload).not.toHaveBeenCalled();

    await create({ ...CLI, DeadLetterConfig: { TargetArn: QUEUE } });
    expect(configs.destinationQueue).toHaveBeenLastCalledWith(ACCOUNT, QUEUE);
    expect(functions.startCreate).toHaveBeenCalledWith(ACCOUNT, expect.anything(), { description: '', role: ROLE, deadLetterTargetArn: QUEUE });
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

  /** An update started: the function as it will be, under way, and whether a new version rolls out. */
  function started(changes: Partial<Function>, rollsOut = true) {
    const function_ = Object.assign(new Function(), { ...active, ...changes, updateStatus: UpdateStatus.IN_PROGRESS, revisionId: 'rev-2' });
    functions.startUpdate.mockResolvedValueOnce({ function_, environment: { variables: { STAGE: 'spike' }, secrets: {} }, rollsOut, rollOut });
  }

  const configure = (input: Record<string, unknown>) => ask('PUT', `${path}/configuration`, input);
  const updateCode = (input: Record<string, unknown>) => ask('PUT', `${path}/code`, input);

  it("UpdateFunctionConfiguration changes what it sends, as the spike's tools sent it, answering InProgress at once, the rollout after", async () => {
    started({ timeout: 10 });
    const answer = await configure({ Timeout: 10, Environment: { Variables: { STAGE: 'spike' } } });

    expect(functions.startUpdate).toHaveBeenCalledWith(ACCOUNT, 'f-orders', { timeout: 10, environment: { STAGE: 'spike' } }, {});
    expect(answer.status).toBe(200);
    expect(answer.document).toMatchObject({
      Timeout: 10,
      Environment: { Variables: { STAGE: 'spike' } },
      RevisionId: 'rev-2',
      State: 'Active',
      LastUpdateStatus: 'InProgress',
      LastUpdateStatusReasonCode: 'Creating',
    });
    expect(rollOut).toHaveBeenCalledWith(undefined);
  });

  it('keeps a description and a role at once, which roll nothing out: the answer is the saved function, Successful', async () => {
    started({ description: 'Takes orders' }, false);
    rollOut.mockResolvedValueOnce({ ...active, description: 'Takes orders', environment: { STAGE: 'spike' } });
    const role = `arn:aws:iam::${ACCOUNT}:role/orders-v2`;
    const answer = await configure({ Description: 'Takes orders', Role: role, RevisionId: 'rev-1' });

    expect(functions.startUpdate).toHaveBeenCalledWith(ACCOUNT, 'f-orders', {}, { description: 'Takes orders', role, revisionId: 'rev-1' });
    expect(answer.document).toMatchObject({ Description: 'Takes orders', LastUpdateStatus: 'Successful' });
  });

  it('changes the dead-letter queue at once, an empty TargetArn removing it; a queue not in the account refused before anything changes', async () => {
    for (const sent of [QUEUE, '']) {
      started({}, false);
      rollOut.mockResolvedValueOnce({ ...active, environment: { STAGE: 'spike' } });
      await configure({ DeadLetterConfig: { TargetArn: sent } });
    }

    expect(functions.startUpdate.mock.calls.map(([, , fields, lambda]) => [fields, lambda])).toEqual([
      [{}, { deadLetterTargetArn: QUEUE }],
      [{}, { deadLetterTargetArn: null }],
    ]);
    expect(configs.destinationQueue).toHaveBeenCalledTimes(1);
    expect(await refused(configure({ DeadLetterConfig: { TargetArn: `${QUEUE}-gone` } }))).toEqual(NO_QUEUE);
    expect(functions.startUpdate).toHaveBeenCalledTimes(2);
  });

  it("refuses a change while another runs in Lambda's words, which the tools wait on: an update in progress, or a function Pending", async () => {
    functions.startUpdate.mockRejectedValueOnce(new ChangeUnderWayException(active));
    expect(await refused(configure({ Timeout: 10 }))).toEqual([
      409,
      'ResourceConflictException',
      `The operation cannot be performed at this time. An update is in progress for resource: arn:aws:lambda:${REGION}:${ACCOUNT}:function:orders`,
    ]);
    functions.startUpdate.mockRejectedValueOnce(new ChangeUnderWayException(saved));
    expect(await refused(configure({ Timeout: 10 }))).toEqual([
      409,
      'ResourceConflictException',
      'The operation cannot be performed at this time. The function is currently in the following state: Pending',
    ]);
  });

  it('UpdateFunctionCode stores the zip as a package and rolls it out, answering InProgress with its CodeSha256', async () => {
    started({ codeSha256: SHA });
    const answer = await updateCode({ ZipFile: ZIP.toString('base64') });

    expect(Buffer.concat(uploaded)).toEqual(ZIP);
    expect(functions.startUpdate).toHaveBeenCalledWith(ACCOUNT, 'f-orders', { codeSha256: SHA }, {});
    expect(answer.document).toMatchObject({ CodeSha256: SHA, LastUpdateStatus: 'InProgress' });
    expect(rollOut).toHaveBeenCalledWith(undefined);
  });

  it("publishes a version once the new code is live, in the transaction that says so, when Publish says so; its code from the account's bucket", async () => {
    started({ codeSha256: SHA });
    await updateCode({ S3Bucket: 'builds', S3Key: 'orders/v2.zip', Publish: true, RevisionId: 'rev-1' });
    const [whenLive] = rollOut.mock.calls[0];
    await whenLive?.('the transaction' as never, active);
    await new Promise(setImmediate);

    expect(store.object).toHaveBeenCalledWith('b-1234', 'orders/v2.zip');
    expect(functions.startUpdate).toHaveBeenCalledWith(ACCOUNT, 'f-orders', { codeSha256: SHA }, { revisionId: 'rev-1' });
    expect(versions.publishIn).toHaveBeenCalledWith('the transaction', ACCOUNT, 'f-orders', {});
    expect(versions.labelLatest).toHaveBeenCalledWith(ACCOUNT, 'f-orders');
  });

  it('refuses new code before reading it while a change runs, or when RevisionId is not the one the function has', async () => {
    functions.isChanging.mockReturnValueOnce(true);
    expect((await refused(updateCode({ ZipFile: ZIP.toString('base64') })))[1]).toBe('ResourceConflictException');
    expect(await refused(updateCode({ ZipFile: ZIP.toString('base64'), RevisionId: 'rev-0' }))).toEqual([
      412,
      'PreconditionFailedException',
      "RevisionId rev-0 isn't the function orders's, rev-1: another change came since it was read. Read the function again, then change it",
    ]);
    expect(packages.upload).not.toHaveBeenCalled();
    expect(functions.startUpdate).not.toHaveBeenCalled();
  });

  it('with DryRun, reads the code where it is, stores nothing, changes nothing, and answers the function as it is', async () => {
    const answer = await updateCode({ S3Bucket: 'builds', S3Key: 'orders/v2.zip', DryRun: true });

    expect(store.object).toHaveBeenCalledWith('b-1234', 'orders/v2.zip');
    expect(packages.upload).not.toHaveBeenCalled();
    expect(functions.startUpdate).not.toHaveBeenCalled();
    expect(answer.document).toMatchObject({ CodeSha256: SHA, RevisionId: 'rev-1', LastUpdateStatus: 'Successful' });
    store.object.mockResolvedValueOnce(null);
    expect((await refused(updateCode({ S3Bucket: 'builds', S3Key: 'none.zip', DryRun: true })))[2]).toMatch(/NoSuchKey/);
  });

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

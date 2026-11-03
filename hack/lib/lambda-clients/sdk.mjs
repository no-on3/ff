#!/usr/bin/env node
// AWS's SDK for JavaScript v3 against FF's Lambda endpoint, with its defaults, as a customer's code has them: only the
// endpoint, the region and the key are given. A function through its life: made, waited for, listed, its code and its
// settings changed, each change waited for, tagged, invoked, a version and an alias, a URL, a queue's mapping, its
// asynchronous calls' settings, its dead-letter queue, its reserved concurrency, its permissions, refused as Lambda
// refuses, deleted; an operation FF doesn't offer yet refused once, by its name, though the client retries by default.
// One JSON line per check, {client, want, got, what}, for hack/e2e.sh.
//   MODULES=<folder with node_modules> ENDPOINT=http://localhost:<port> KEY=… SECRET=… ROLE=<an IAM role's ARN> \
//   CODE=<zip> CODE_SHA=<its CodeSha256> NEW_CODE=<zip> NEW_CODE_SHA=… OTHER_FUNCTION=<another function's name> \
//   QUEUE_ARN=<a queue of the account, none reading it> node sdk.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(`${process.env.MODULES}/`);
const lambda = require('@aws-sdk/client-lambda');
const { ENDPOINT, KEY, SECRET, ROLE, CODE, CODE_SHA, NEW_CODE, NEW_CODE_SHA, OTHER_FUNCTION, QUEUE_ARN } = process.env;
const client = new lambda.LambdaClient({ endpoint: ENDPOINT, region: 'tn-tunis-1', credentials: { accessKeyId: KEY, secretAccessKey: SECRET }, maxAttempts: 1 });
const FunctionName = 'e2e-sdk';
/** The waiters as Lambda's tools use them, every second or two, for up to two minutes. */
const waiting = { client, maxWaitTime: 120, minDelay: 1, maxDelay: 2 };

async function check(want, what, run) {
  let got = 'ok';
  let detail = '';
  try {
    detail = String((await run()) ?? '');
  } catch (error) {
    got = 'refused';
    detail = `${error.name}: ${error.message}`;
  }
  console.log(JSON.stringify({ client: 'sdk', want, got, what, detail: detail.slice(0, 200) }));
}
/** Fails unless the answer is what it should be. */
const expect = (actual, wanted) => {
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`got ${JSON.stringify(actual)}, not ${JSON.stringify(wanted)}`);
  return JSON.stringify(actual);
};
/** Refused, as the error Lambda names, which the SDK makes the error's name. */
const refusedAs = async (run, name) => {
  try {
    await run();
  } catch (error) {
    return expect(error.name, name);
  }
  throw new Error('accepted');
};
const send = (Command, input) => client.send(new Command(input));

let revision;
await check('ok', 'CreateFunction answers at once, Pending, with the zip\'s CodeSha256', async () => {
  const made = await send(lambda.CreateFunctionCommand, {
    FunctionName,
    Runtime: 'nodejs24.x',
    Role: ROLE,
    Handler: 'index.handler',
    Code: { ZipFile: readFileSync(CODE) },
    Environment: { Variables: { STAGE: 'sdk' } },
    Tags: { client: 'sdk' },
  });
  return expect([made.State, made.CodeSha256], ['Pending', CODE_SHA]);
});
await check('ok', 'waitUntilFunctionActiveV2 waits for it to be Active; GetFunction reads it so, with its tags', async () => {
  expect((await lambda.waitUntilFunctionActiveV2(waiting, { FunctionName })).state, 'SUCCESS');
  const read = await send(lambda.GetFunctionCommand, { FunctionName });
  revision = read.Configuration.RevisionId;
  return expect([read.Configuration.State, read.Configuration.LastUpdateStatus, read.Configuration.Environment.Variables, read.Tags], [
    'Active',
    'Successful',
    { STAGE: 'sdk' },
    { client: 'sdk' },
  ]);
});
await check('ok', 'paginateListFunctions follows NextMarker a function a page: the account\'s two functions, each once', async () => {
  const names = [];
  let pages = 0;
  for await (const page of lambda.paginateListFunctions({ client, pageSize: 1 }, {})) {
    pages++;
    names.push(...page.Functions.map((function_) => function_.FunctionName));
  }
  return expect([pages, names.sort()], [2, [FunctionName, OTHER_FUNCTION].sort()]);
});
await check('ok', 'UpdateFunctionCode answers InProgress; waitUntilFunctionUpdatedV2 waits for it to be Successful, with the new CodeSha256', async () => {
  const answer = await send(lambda.UpdateFunctionCodeCommand, { FunctionName, ZipFile: readFileSync(NEW_CODE) });
  expect([answer.LastUpdateStatus, answer.CodeSha256], ['InProgress', NEW_CODE_SHA]);
  expect((await lambda.waitUntilFunctionUpdatedV2(waiting, { FunctionName })).state, 'SUCCESS');
  const read = await send(lambda.GetFunctionConfigurationCommand, { FunctionName });
  return expect([read.LastUpdateStatus, read.CodeSha256], ['Successful', NEW_CODE_SHA]);
});
await check('ok', 'UpdateFunctionConfiguration answers InProgress; another change meanwhile is ResourceConflictException; the first is live once Successful', async () => {
  const answer = await send(lambda.UpdateFunctionConfigurationCommand, { FunctionName, Timeout: 10, Environment: { Variables: { STAGE: 'sdk-2' } } });
  expect([answer.LastUpdateStatus, answer.Timeout], ['InProgress', 10]);
  await refusedAs(() => send(lambda.UpdateFunctionConfigurationCommand, { FunctionName, Timeout: 11 }), 'ResourceConflictException');
  expect((await lambda.waitUntilFunctionUpdatedV2(waiting, { FunctionName })).state, 'SUCCESS');
  const read = await send(lambda.GetFunctionConfigurationCommand, { FunctionName });
  return expect([read.LastUpdateStatus, read.Timeout, read.Environment.Variables], ['Successful', 10, { STAGE: 'sdk-2' }]);
});
await check('ok', 'a RevisionId read before those changes is PreconditionFailedException', () =>
  refusedAs(() => send(lambda.UpdateFunctionConfigurationCommand, { FunctionName, Timeout: 12, RevisionId: revision }), 'PreconditionFailedException'),
);
/** What a call answered, read as JSON. */
const answerOf = (called) => JSON.parse(Buffer.from(called.Payload).toString('utf8'));
await check('ok', "Invoke waits for the call: $LATEST ran it, the function's answer as it returned it, the ClientContext in its context, its log with LogType Tail", async () => {
  const called = await send(lambda.InvokeCommand, {
    FunctionName,
    Payload: Buffer.from(JSON.stringify({ n: 1 })),
    LogType: 'Tail',
    ClientContext: Buffer.from(JSON.stringify({ custom: { cart: '7' } })).toString('base64'),
  });
  const log = Buffer.from(called.LogResult, 'base64').toString('utf8');
  return expect(
    [called.StatusCode, called.ExecutedVersion, called.FunctionError ?? 'none', answerOf(called), /^START RequestId: /m.test(log), log.includes('invoked with {"n":1}\n'), /^REPORT RequestId: /m.test(log)],
    [200, '$LATEST', 'none', { code: 'v2', event: { n: 1 }, clientContext: { custom: { cart: '7' } } }, true, true, true],
  );
});
await check('ok', "a function that throws: 200, FunctionError Unhandled and Lambda's error document; Event 202; DryRun 204", async () => {
  const failed = await send(lambda.InvokeCommand, { FunctionName, Payload: Buffer.from(JSON.stringify({ fail: true })) });
  const queued = await send(lambda.InvokeCommand, { FunctionName, InvocationType: 'Event', Payload: Buffer.from('{}') });
  const dry = await send(lambda.InvokeCommand, { FunctionName, InvocationType: 'DryRun' });
  return expect(
    [failed.StatusCode, failed.FunctionError, answerOf(failed), queued.StatusCode, dry.StatusCode],
    [200, 'Unhandled', { errorType: 'TypeError', errorMessage: 'bad input' }, 202, 204],
  );
});
await check('ok', 'PublishVersion, then CreateAlias, GetAlias, UpdateAlias, ListAliases and DeleteAlias on it; ListVersionsByFunction', async () => {
  const { Version } = await send(lambda.PublishVersionCommand, { FunctionName, Description: 'sdk' });
  const made = await send(lambda.CreateAliasCommand, { FunctionName, Name: 'live', FunctionVersion: Version });
  expect([(await send(lambda.GetAliasCommand, { FunctionName, Name: 'live' })).RevisionId, made.FunctionVersion], [made.RevisionId, Version]);
  const changed = await send(lambda.UpdateAliasCommand, { FunctionName, Name: 'live', FunctionVersion: '$LATEST', RevisionId: made.RevisionId });
  const listed = (await send(lambda.ListAliasesCommand, { FunctionName })).Aliases.map((alias) => `${alias.Name}:${alias.FunctionVersion}`);
  await send(lambda.DeleteAliasCommand, { FunctionName, Name: 'live' });
  await refusedAs(() => send(lambda.GetAliasCommand, { FunctionName, Name: 'live' }), 'ResourceNotFoundException');
  const versions = (await send(lambda.ListVersionsByFunctionCommand, { FunctionName })).Versions.map((version) => version.Version);
  return expect([Version, changed.FunctionVersion, listed, versions], ['1', '$LATEST', ['live:$LATEST'], ['$LATEST', '1']]);
});
await check('ok', 'CreateFunctionUrlConfig, then GetFunctionUrlConfig, UpdateFunctionUrlConfig with Cors, ListFunctionUrlConfigs and DeleteFunctionUrlConfig', async () => {
  const made = await send(lambda.CreateFunctionUrlConfigCommand, { FunctionName, AuthType: 'NONE' });
  const read = await send(lambda.GetFunctionUrlConfigCommand, { FunctionName });
  const changed = await send(lambda.UpdateFunctionUrlConfigCommand, { FunctionName, Cors: { AllowOrigins: ['https://shop.example.tn'] } });
  const listed = (await send(lambda.ListFunctionUrlConfigsCommand, { FunctionName })).FunctionUrlConfigs.map((url) => url.FunctionUrl);
  await send(lambda.DeleteFunctionUrlConfigCommand, { FunctionName });
  await refusedAs(() => send(lambda.GetFunctionUrlConfigCommand, { FunctionName }), 'ResourceNotFoundException');
  return expect(
    [read.FunctionUrl === made.FunctionUrl, made.AuthType, changed.AuthType, changed.Cors.AllowOrigins, listed.length, listed[0] === made.FunctionUrl],
    [true, 'NONE', 'NONE', ['https://shop.example.tn'], 1, true],
  );
});
await check('ok', 'CreateEventSourceMapping on a queue of the account, then GetEventSourceMapping, UpdateEventSourceMapping, ListEventSourceMappings and DeleteEventSourceMapping', async () => {
  const made = await send(lambda.CreateEventSourceMappingCommand, { FunctionName, EventSourceArn: QUEUE_ARN, BatchSize: 5 });
  const read = await send(lambda.GetEventSourceMappingCommand, { UUID: made.UUID });
  const changed = await send(lambda.UpdateEventSourceMappingCommand, { UUID: made.UUID, Enabled: false });
  const listed = (await send(lambda.ListEventSourceMappingsCommand, { FunctionName })).EventSourceMappings.map((mapping) => mapping.UUID);
  const deleted = await send(lambda.DeleteEventSourceMappingCommand, { UUID: made.UUID });
  await refusedAs(() => send(lambda.GetEventSourceMappingCommand, { UUID: made.UUID }), 'ResourceNotFoundException');
  // LastModified is a date in seconds, as Lambda's: read as milliseconds, it would be in 1970.
  const recent = Math.abs(made.LastModified.getTime() - Date.now()) < 600_000;
  return expect([made.State, made.BatchSize, read.EventSourceArn, changed.State, listed, deleted.State, recent], ['Enabled', 5, QUEUE_ARN, 'Disabled', [made.UUID], 'Deleting', true]);
});
await check('ok', 'PutFunctionEventInvokeConfig, then UpdateFunctionEventInvokeConfig, GetFunctionEventInvokeConfig, ListFunctionEventInvokeConfigs and DeleteFunctionEventInvokeConfig', async () => {
  const put = await send(lambda.PutFunctionEventInvokeConfigCommand, { FunctionName, MaximumRetryAttempts: 1, MaximumEventAgeInSeconds: 600 });
  const changed = await send(lambda.UpdateFunctionEventInvokeConfigCommand, { FunctionName, MaximumRetryAttempts: 0 });
  const read = await send(lambda.GetFunctionEventInvokeConfigCommand, { FunctionName });
  const listed = (await send(lambda.ListFunctionEventInvokeConfigsCommand, { FunctionName })).FunctionEventInvokeConfigs.map((config) => config.FunctionArn);
  await send(lambda.DeleteFunctionEventInvokeConfigCommand, { FunctionName });
  await refusedAs(() => send(lambda.GetFunctionEventInvokeConfigCommand, { FunctionName }), 'ResourceNotFoundException');
  const recent = Math.abs(put.LastModified.getTime() - Date.now()) < 600_000;
  return expect([changed.MaximumRetryAttempts, changed.MaximumEventAgeInSeconds, read.MaximumRetryAttempts, listed, recent], [0, 600, 0, [put.FunctionArn], true]);
});
await check('ok', 'UpdateFunctionConfiguration with a DeadLetterConfig of a queue of the account, at once, read back; an empty TargetArn removing it', async () => {
  const set = await send(lambda.UpdateFunctionConfigurationCommand, { FunctionName, DeadLetterConfig: { TargetArn: QUEUE_ARN } });
  const read = await send(lambda.GetFunctionConfigurationCommand, { FunctionName });
  await send(lambda.UpdateFunctionConfigurationCommand, { FunctionName, DeadLetterConfig: { TargetArn: '' } });
  const removed = await send(lambda.GetFunctionConfigurationCommand, { FunctionName });
  return expect([set.DeadLetterConfig?.TargetArn, set.LastUpdateStatus, read.DeadLetterConfig?.TargetArn, removed.DeadLetterConfig ?? 'none'], [QUEUE_ARN, 'Successful', QUEUE_ARN, 'none']);
});
await check('ok', 'PutFunctionConcurrency, then GetFunctionConcurrency and GetFunction read it; DeleteFunctionConcurrency, none again', async () => {
  const put = await send(lambda.PutFunctionConcurrencyCommand, { FunctionName, ReservedConcurrentExecutions: 2 });
  const read = await send(lambda.GetFunctionConcurrencyCommand, { FunctionName });
  const { Concurrency } = await send(lambda.GetFunctionCommand, { FunctionName });
  await send(lambda.DeleteFunctionConcurrencyCommand, { FunctionName });
  const none = await send(lambda.GetFunctionConcurrencyCommand, { FunctionName });
  return expect([put.ReservedConcurrentExecutions, read.ReservedConcurrentExecutions, Concurrency?.ReservedConcurrentExecutions, none.ReservedConcurrentExecutions ?? 'none'], [2, 2, 2, 'none']);
});
await check('ok', 'AddPermission, then GetPolicy reads the statement as Lambda writes it, kept without effect; RemovePermission, then none', async () => {
  const added = await send(lambda.AddPermissionCommand, { FunctionName, StatementId: 's3', Action: 'lambda:InvokeFunction', Principal: 's3.amazonaws.com', SourceAccount: '000000000000' });
  const { Policy } = await send(lambda.GetPolicyCommand, { FunctionName });
  await send(lambda.RemovePermissionCommand, { FunctionName, StatementId: 's3' });
  await refusedAs(() => send(lambda.GetPolicyCommand, { FunctionName }), 'ResourceNotFoundException');
  const kept = JSON.parse(Policy).Statement;
  return expect([JSON.parse(added.Statement).Sid, kept.length, kept[0].Principal, kept[0].Condition], ['s3', 1, { Service: 's3.amazonaws.com' }, { StringEquals: { 'AWS:SourceAccount': '000000000000' } }]);
});
await check('ok', 'TagResource, ListTags and UntagResource on its ARN', async () => {
  const { FunctionArn } = await send(lambda.GetFunctionConfigurationCommand, { FunctionName });
  await send(lambda.TagResourceCommand, { Resource: FunctionArn, Tags: { team: 'shop' } });
  expect((await send(lambda.ListTagsCommand, { Resource: FunctionArn })).Tags, { client: 'sdk', team: 'shop' });
  await send(lambda.UntagResourceCommand, { Resource: FunctionArn, TagKeys: ['client'] });
  return expect((await send(lambda.ListTagsCommand, { Resource: FunctionArn })).Tags, { team: 'shop' });
});
await check('ok', 'refused as the SDK names Lambda\'s errors: a runtime FF lacks, a function the account hasn\'t', async () => {
  const lacking = { FunctionName: 'e2e-sdk-22', Runtime: 'nodejs22.x', Role: ROLE, Handler: 'index.handler', Code: { ZipFile: readFileSync(CODE) } };
  await refusedAs(() => send(lambda.CreateFunctionCommand, lacking), 'InvalidParameterValueException');
  return refusedAs(() => send(lambda.GetFunctionCommand, { FunctionName: 'e2e-sdk-missing' }), 'ResourceNotFoundException');
});
await check('ok', "operations FF doesn't offer yet are UnknownOperationException, named, sent once by a client that retries by default", async () => {
  // The SDK's own retries, three attempts, where the client above makes one.
  const retrying = new lambda.LambdaClient({ endpoint: ENDPOINT, region: 'tn-tunis-1', credentials: { accessKeyId: KEY, secretAccessKey: SECRET } });
  const refused = [];
  for (const [Command, input] of [
    [lambda.ListLayersCommand, {}],
    [lambda.GetLayerVersionByArnCommand, { Arn: 'arn:aws:lambda:tn-tunis-1:000000000000:layer:shared:1' }],
    [lambda.PutProvisionedConcurrencyConfigCommand, { FunctionName, Qualifier: '1', ProvisionedConcurrentExecutions: 1 }],
  ]) {
    try {
      await retrying.send(new Command(input));
      refused.push('accepted');
    } catch (error) {
      refused.push(`${error.name} ${error.$metadata?.attempts} ${error.message.split('.')[0]}`);
    }
  }
  return expect(refused, [
    "UnknownOperationException 1 FF doesn't offer ListLayers of Lambda's API yet",
    "UnknownOperationException 1 FF doesn't offer GetLayerVersionByArn of Lambda's API yet",
    "UnknownOperationException 1 FF doesn't offer PutProvisionedConcurrencyConfig of Lambda's API yet",
  ]);
});
await check('ok', 'DeleteFunction deletes it: GetFunction then ResourceNotFoundException', async () => {
  await send(lambda.DeleteFunctionCommand, { FunctionName });
  return refusedAs(() => send(lambda.GetFunctionCommand, { FunctionName }), 'ResourceNotFoundException');
});

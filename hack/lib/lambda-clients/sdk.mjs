#!/usr/bin/env node
// AWS's SDK for JavaScript v3 against FF's Lambda endpoint, with its defaults, as a customer's code has them: only the
// endpoint, the region and the key are given. A function through its life: made, waited for, listed, its code and its
// settings changed, each change waited for, tagged, refused as Lambda refuses, deleted; an operation FF doesn't offer
// yet refused once, by its name, though the client retries by default. One JSON line per check,
// {client, want, got, what}, for hack/e2e.sh.
//   MODULES=<folder with node_modules> ENDPOINT=http://localhost:<port> KEY=… SECRET=… ROLE=<an IAM role's ARN> \
//   CODE=<zip> CODE_SHA=<its CodeSha256> NEW_CODE=<zip> NEW_CODE_SHA=… OTHER_FUNCTION=<another function's name> node sdk.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(`${process.env.MODULES}/`);
const lambda = require('@aws-sdk/client-lambda');
const { ENDPOINT, KEY, SECRET, ROLE, CODE, CODE_SHA, NEW_CODE, NEW_CODE_SHA, OTHER_FUNCTION } = process.env;
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

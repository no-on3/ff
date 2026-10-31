// AWS's SDK for JavaScript v3 through a function's whole life against the spike's Lambda endpoint, with only the
// endpoint, the region and a key, as a customer's code would have them: one JSON line a step, with the error as the
// SDK shows it. The steps are run.sh's, the same for every client.
//   MODULES=<node_modules> ENDPOINT=http://… CODE=<zip> BIG=<zip> NAME=<function> node sdk-flow.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(`${process.env.MODULES}/`);
const lambda = require('@aws-sdk/client-lambda');
const client = new lambda.LambdaClient({ endpoint: process.env.ENDPOINT, region: process.env.AWS_REGION });
const name = process.env.NAME;
const send = (Command, input) => client.send(new Command(input));

async function step(label, run) {
  const started = Date.now();
  try {
    const result = await run();
    console.log(JSON.stringify({ step: label, ok: true, ms: Date.now() - started, ...(result === undefined ? {} : { result }) }));
  } catch (error) {
    console.log(JSON.stringify({ step: label, ok: false, ms: Date.now() - started, shown: `${error.name}: ${error.message}`, status: error.$metadata?.httpStatusCode, attempts: error.$metadata?.attempts }));
  }
}
const waitActive = () => lambda.waitUntilFunctionActiveV2({ client, maxWaitTime: 120 }, { FunctionName: name }).then((r) => r.state);
const waitUpdated = () => lambda.waitUntilFunctionUpdatedV2({ client, maxWaitTime: 120 }, { FunctionName: name }).then((r) => r.state);

await step('create-function', () => send(lambda.CreateFunctionCommand, {
  FunctionName: name, Runtime: 'nodejs22.x', Role: 'arn:aws:iam::123456789012:role/spike', Handler: 'index.handler', Code: { ZipFile: readFileSync(process.env.CODE) },
}).then((r) => r.State));
await step('invoke while pending', () => send(lambda.InvokeCommand, { FunctionName: name, Payload: JSON.stringify({ early: true }) }).then((r) => r.StatusCode));
await step('wait function-active-v2', waitActive);
await step('invoke, with the log tail', () => send(lambda.InvokeCommand, { FunctionName: name, Payload: JSON.stringify({ hello: 'spike' }), LogType: 'Tail' })
  .then((r) => ({ status: r.StatusCode, payload: Buffer.from(r.Payload).toString('utf8'), logLines: Buffer.from(r.LogResult ?? '', 'base64').toString('utf8').split('\n').length - 1 })));
await step('invoke, asynchronously', () => send(lambda.InvokeCommand, { FunctionName: name, InvocationType: 'Event', Payload: '{}' }).then((r) => r.StatusCode));
await step('update-function-code, 6 MB', () => send(lambda.UpdateFunctionCodeCommand, { FunctionName: name, ZipFile: readFileSync(process.env.BIG) }).then((r) => r.LastUpdateStatus));
await step('update-function-configuration during the update', () => send(lambda.UpdateFunctionConfigurationCommand, { FunctionName: name, Timeout: 10 }).then((r) => r.LastUpdateStatus));
await step('wait function-updated-v2', waitUpdated);
await step('update-function-configuration', () => send(lambda.UpdateFunctionConfigurationCommand, { FunctionName: name, Timeout: 10, Environment: { Variables: { STAGE: 'spike' } } }).then((r) => r.LastUpdateStatus));
await step('wait function-updated-v2, again', waitUpdated);
await step('publish-version', () => send(lambda.PublishVersionCommand, { FunctionName: name }).then((r) => r.Version));
await step('create-alias', () => send(lambda.CreateAliasCommand, { FunctionName: name, Name: 'live', FunctionVersion: '1' }).then((r) => r.AliasArn));
await step('invoke the alias', () => send(lambda.InvokeCommand, { FunctionName: name, Qualifier: 'live', Payload: '{}' }).then((r) => r.ExecutedVersion));
await step('invoke by the alias ARN', () => send(lambda.InvokeCommand, { FunctionName: `arn:aws:lambda:${process.env.AWS_REGION}:123456789012:function:${name}:live`, Payload: '{}' }).then((r) => r.ExecutedVersion));
await step('create-function-url-config', () => send(lambda.CreateFunctionUrlConfigCommand, { FunctionName: name, AuthType: 'NONE' }).then((r) => r.FunctionUrl));
await step('add-permission', () => send(lambda.AddPermissionCommand, { FunctionName: name, StatementId: 'url', Action: 'lambda:InvokeFunctionUrl', Principal: '*', FunctionUrlAuthType: 'NONE' }).then(() => 'added'));
await step('create-event-source-mapping', () => send(lambda.CreateEventSourceMappingCommand, { FunctionName: name, EventSourceArn: `arn:aws:sqs:${process.env.AWS_REGION}:123456789012:spike`, BatchSize: 5 }).then((r) => { globalThis.mapping = r.UUID; return r.State; }));
await step('put-function-event-invoke-config', () => send(lambda.PutFunctionEventInvokeConfigCommand, { FunctionName: name, MaximumRetryAttempts: 1 }).then((r) => r.MaximumRetryAttempts));
await step('put-function-concurrency', () => send(lambda.PutFunctionConcurrencyCommand, { FunctionName: name, ReservedConcurrentExecutions: 5 }).then((r) => r.ReservedConcurrentExecutions));
await step('tag-resource', () => send(lambda.TagResourceCommand, { Resource: `arn:aws:lambda:${process.env.AWS_REGION}:123456789012:function:${name}`, Tags: { team: 'spike', stage: 'x' } }).then(() => 'tagged'));
await step('untag-resource', () => send(lambda.UntagResourceCommand, { Resource: `arn:aws:lambda:${process.env.AWS_REGION}:123456789012:function:${name}`, TagKeys: ['stage'] }).then(() => 'untagged'));
await step('list-tags', () => send(lambda.ListTagsCommand, { Resource: `arn:aws:lambda:${process.env.AWS_REGION}:123456789012:function:${name}` }).then((r) => r.Tags));
await step('reads', async () => {
  const got = await send(lambda.GetFunctionCommand, { FunctionName: name });
  await send(lambda.GetFunctionConfigurationCommand, { FunctionName: name, Qualifier: '1' });
  await send(lambda.ListFunctionsCommand, {});
  await send(lambda.ListVersionsByFunctionCommand, { FunctionName: name });
  await send(lambda.ListAliasesCommand, { FunctionName: name });
  await send(lambda.GetAliasCommand, { FunctionName: name, Name: 'live' });
  await send(lambda.GetPolicyCommand, { FunctionName: name });
  await send(lambda.GetFunctionUrlConfigCommand, { FunctionName: name });
  await send(lambda.ListFunctionUrlConfigsCommand, { FunctionName: name });
  await send(lambda.ListEventSourceMappingsCommand, { FunctionName: name });
  await send(lambda.GetEventSourceMappingCommand, { UUID: globalThis.mapping });
  await send(lambda.GetFunctionEventInvokeConfigCommand, { FunctionName: name });
  await send(lambda.ListFunctionEventInvokeConfigsCommand, { FunctionName: name });
  await send(lambda.GetFunctionConcurrencyCommand, { FunctionName: name });
  await send(lambda.GetFunctionCodeSigningConfigCommand, { FunctionName: name });
  await send(lambda.GetAccountSettingsCommand, {});
  return got.Configuration.State;
});
await step('update-alias, weighted', () => send(lambda.UpdateAliasCommand, { FunctionName: name, Name: 'live', FunctionVersion: '1', RoutingConfig: { AdditionalVersionWeights: {} } }).then((r) => r.FunctionVersion));
await step('update-event-source-mapping while creating', () => send(lambda.UpdateEventSourceMappingCommand, { UUID: globalThis.mapping, BatchSize: 7 }).then((r) => r.State));
await step('update-function-url-config', () => send(lambda.UpdateFunctionUrlConfigCommand, { FunctionName: name, AuthType: 'AWS_IAM' }).then((r) => r.AuthType));
await step('update-function-event-invoke-config', () => send(lambda.UpdateFunctionEventInvokeConfigCommand, { FunctionName: name, MaximumEventAgeInSeconds: 600 }).then((r) => r.MaximumEventAgeInSeconds));
await step('a later operation: list-layers', () => send(lambda.ListLayersCommand, {}).then(() => 'answered'));
await step('a missing function: get-function', () => send(lambda.GetFunctionCommand, { FunctionName: 'no-such-function' }).then(() => 'found'));
await step('deletes', async () => {
  await send(lambda.DeleteFunctionConcurrencyCommand, { FunctionName: name });
  await send(lambda.DeleteFunctionEventInvokeConfigCommand, { FunctionName: name });
  await send(lambda.DeleteEventSourceMappingCommand, { UUID: globalThis.mapping });
  await send(lambda.RemovePermissionCommand, { FunctionName: name, StatementId: 'url' });
  await send(lambda.DeleteFunctionUrlConfigCommand, { FunctionName: name });
  await send(lambda.DeleteAliasCommand, { FunctionName: name, Name: 'live' });
  await send(lambda.DeleteFunctionCommand, { FunctionName: name });
  return 'deleted';
});

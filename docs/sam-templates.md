# SAM templates on FF

`ff deploy template.yaml` takes a SAM template as `sam deploy` takes it, within FF's subset of SAM: what this page
lists. Every piece of a template outside it is named at its line, with why and what FF has instead, in one refusal
that changes nothing; `ff doctor template.yaml` names the same pieces as warnings, since AWS takes them. The
[getting-started guide](getting-started.md#sam-templates) shows the commands, and [ADR 0016](adr/0016-sam-templates.md)
the choices behind the subset.

The functions of a template are deployed today, with their URLs, aliases, asynchronous settings and
[events](#events), an `S3` event aside. Queues and buckets are in the subset, which `ff doctor` reads, and come to
`ff deploy` next, `S3` events with them: until then it refuses them, saying so.

## `sam init`'s hello world

`sam init`'s hello world is outside the subset by its `Api` event: it makes an API Gateway REST API, which FF hasn't.
`ff init <name> --template sam --runtime nodejs|python` writes FF's version of it, which `sam deploy` takes to AWS as
it is. These are its only changes to `sam init`'s template:

```diff
       CodeUri: hello-world/
       Handler: app.lambdaHandler
-      Runtime: nodejs22.x
+      Runtime: nodejs24.x
       Architectures:
         - x86_64
-      Events:
-        HelloWorld:
-          Type: Api
-          Properties:
-            Path: /hello
-            Method: get
+      FunctionUrlConfig:
+        AuthType: NONE

 Outputs:
   HelloWorldApi:
-    Description: "API Gateway endpoint URL for Prod stage for Hello World function"
-    Value: !Sub "https://${ServerlessRestApi}.execute-api.${AWS::Region}.${AWS::URLSuffix}/Prod/hello/"
+    Description: "Function URL for Hello World function"
+    Value: !GetAtt HelloWorldFunctionUrl.FunctionUrl
   HelloWorldFunction:
     Description: "Hello World Lambda Function ARN"
     Value: !GetAtt HelloWorldFunction.Arn
-  HelloWorldFunctionIamRole:
-    Description: "Implicit IAM Role created for Hello World function"
-    Value: !GetAtt HelloWorldFunctionRole.Arn
```

- **The runtime:** FF runs `nodejs24.x` and `python3.13`; Python's hello world has its runtime already.
- **The URL:** `FunctionUrlConfig` gives the function a URL on FF and on AWS alike, which any path of reaches, `/hello`
  among them. `HelloWorldApi`, the output that named the API, is that URL.
- **The role's output** is left out: SAM makes the function an IAM role, and FF has no IAM.
- **The event,** `events/event.json`, is a function URL's request, Lambda's payload of version 2.0, which FF's URLs
  send; `sam init`'s is API Gateway's. The handler stays `sam init`'s: its `statusCode` and `body` are a URL's answer
  as they were API Gateway's.

Its test needs no library, and sits outside the code's folder so that no package holds it: `node --test`, or
`python3 -m unittest`, from the application's folder.

## The template's sections

| Section | On FF |
|---|---|
| `Transform` | SAM's, `AWS::Serverless-2016-10-31`, which a template of `AWS::Serverless` resources needs, as on AWS |
| `Parameters` | Of the types `String`, `Number`, `CommaDelimitedList` and `List<Number>`, their value from `--parameter-overrides`, else `samconfig.toml`, else the stack's last deploy, else `Default`, as `sam deploy` gives them. `AllowedValues`, the lengths and the bounds are checked as CloudFormation checks them; `AllowedPattern` is left to AWS; a `NoEcho` value isn't kept |
| `Globals` | Its `Function` section, merged into each function as SAM merges it; SAM's keys of each function alone (`FunctionName`, `Events`, `Policies`, `Role`, `InlineCode`) are refused there, as SAM refuses them |
| `Resources` | The types below |
| `Outputs` | Printed once FF knows what they name, a function's URL and its version among them, and in `--output json`. An `Export` is outside: FF's stacks share no values |
| `Metadata`, `Description`, `AWSTemplateFormatVersion` | Read, and left as they are |
| `Conditions`, `Fn::If`, a resource's `Condition` | Outside: each resource is made, each value as written |
| `Mappings`, `Rules` | Outside: a parameter gives a value, and its `AllowedValues` check it |

**The intrinsic functions** are `Ref`, `Fn::GetAtt`, `Fn::Sub` and `Fn::Join`, short or long; the others are outside.
**The pseudo parameters** are FF's: `AWS::Region`, FF's region; `AWS::AccountId`, the account's ID; `AWS::StackName`;
and `AWS::Partition`, `aws`, which FF's ARNs are in. `AWS::URLSuffix` is outside, AWS's endpoints' domain, which FF's
aren't on, and so are `AWS::NoValue` and `AWS::NotificationARNs`.

**What a function's name gives:** `!Ref` of a function, its name; `!GetAtt <function>.Arn`; with its
`FunctionUrlConfig`, `!GetAtt <function>Url.FunctionUrl` and `.FunctionArn`; with its `AutoPublishAlias`,
`!Ref <function>.Alias`, `!Ref <function>.Version` and `!Ref <function>Alias<alias>`, as SAM names them. A value FF
can't know before the deploy, such as a function's URL in another function's variables, is refused.

## Functions: `AWS::Serverless::Function`

| Property | On FF |
|---|---|
| `CodeUri` | A folder, built as `ff deploy <folder>` builds one, with its libraries, or a .zip, deployed as it is; `sam build`'s `.aws-sam/build/template.yaml` names folders it built, which are deployed as they are |
| `Handler`, `MemorySize`, `Timeout`, `Description`, `Tags` | As Lambda's |
| `Runtime` | `nodejs24.x` or `python3.13` |
| `FunctionName` | Its name; without it, the stack's last deploy's, else one made as CloudFormation makes one, the stack's name, the logical ID and 12 random letters and digits, within 64 characters. A function of that name outside the stack is refused: `ff deploy` doesn't take it over |
| `Environment` | Its `Variables`. A variable with the name of one of the function's secrets is refused: secrets stay with `ff secrets`, out of the template |
| `ReservedConcurrentExecutions` | The most instances it runs; 0, which would stop every call, is refused |
| `ProvisionedConcurrencyConfig` | The instances kept running, with `AutoPublishAlias`, as SAM's |
| `AutoPublishAlias` | A version published at each deploy, and the alias moved to it; the URL is then the alias's |
| `FunctionUrlConfig` | Its `AuthType`, `NONE` or `AWS_IAM`, which on FF takes FF's API keys; its `Cors`; `InvokeMode` `BUFFERED`, as FF doesn't stream answers |
| `EventInvokeConfig` | Its retries and event age, and its destinations, a queue or a function of the account |
| `DeadLetterQueue` | A queue of the account, `Type: SQS`: FF has no SNS topics |
| `Architectures`, `Tracing`, `PackageType` | FF's one value each: `x86_64`, `PassThrough` or `Disabled`, `Zip` |
| `Policies`, `Role`, `PermissionsBoundary`, `RolePath`, `AssumeRolePolicyDocument` | Read and left for AWS: on FF, a function's own key stands for its role, and reaches its account |
| `Events` | `Schedule`, `ScheduleV2`, `SQS`, and `HttpApi` whose routes all go to the function, as [Events](#events) says; `S3`, next. An `Api` event is outside, as above |
| `Layers` | Outside: the libraries go in the function's package |
| `VpcConfig` | Outside: a function reaches its account's buckets, queues and databases without one |
| `KmsKeyArn`, `CodeSigningConfigArn`, `SnapStart`, `EphemeralStorage`, `LoggingConfig`, `FileSystemConfigs` | Outside: FF seals what it keeps with its own keys, signs no code, starts instances without snapshots, gives 512 MB of `/tmp` and keeps the log as the code writes it, and mounts no file system |
| `ImageUri`, `ImageConfig`, `InlineCode` | Outside: FF builds a .zip package from the function's folder |
| `DeploymentPreference` | Outside: FF moves an alias at once |

## Events

| Type | On FF |
|---|---|
| `Schedule` | One of the function's schedules, as an EventBridge rule: its `Schedule`, `rate(…)` or `cron(…)`, in UTC, as EventBridge reads it; `Input`, JSON text, the function's event, else EventBridge's Scheduled Event; `State`, `ENABLED` or `DISABLED`, or `Enabled`; `Description`; and `Name`, the schedule's, else the event's key. `RetryPolicy` and `DeadLetterConfig` are outside: FF's schedules run the function, retried as an asynchronous call is |
| `ScheduleV2` | The same, as EventBridge Scheduler's schedule: its `ScheduleExpression` in UTC, its `ScheduleExpressionTimezone` `UTC` alone; `at(…)`, a run once, is outside |
| `SQS` | The function reading a queue of the account, which `ff queues create` makes, until templates make theirs: `Queue`, the queue's ARN, `arn:aws:sqs:<region>:<account>:<name>`, which `!Sub arn:aws:sqs:${AWS::Region}:${AWS::AccountId}:<name>` gives; `BatchSize`, `MaximumBatchingWindowInSeconds`, 1 to 300 for over 10 messages, `FunctionResponseTypes`, `ReportBatchItemFailures`, `ScalingConfig`'s `MaximumConcurrency` and `Enabled`, Lambda's defaults where left out. A function reads a queue once, as on Lambda. `FilterCriteria` is outside: the function gets each message |
| `HttpApi` | Its routes go to the function's URL, made with `AuthType: NONE` if the function has no `FunctionUrlConfig`: each path and method reaches the function, whose code reads them in the event's `rawPath` and `requestContext.http.method`, its `routeKey` `$default`. `TimeoutInMillis` is left, the function's `Timeout` being its own. One function's `HttpApi` events alone, of `PayloadFormatVersion` `2.0`; `ApiId`, `Auth` and `RouteSettings` are outside |
| `S3` | Next, with the buckets: SAM writes it in its bucket's `NotificationConfiguration` |

An event's `BatchSize`, `MaximumBatchingWindowInSeconds` and `Enabled` are a number and a boolean, not text, as SAM's
transform takes them, where CloudFormation would take text. With `AutoPublishAlias`, each schedule runs the alias and
the alias reads each queue, as SAM's events call it. Before
any change, `ff deploy` reads each expression with FF's own parser and looks for each queue: what it wouldn't take is
in its one refusal. A schedule or a queue's reader of the function made outside the template, with `ff schedule` or
`ff event-sources`, stays as it is.

## Other resources

| Type | On FF |
|---|---|
| `AWS::Lambda::Permission` | Kept without effect: a function's URL, and its account's buckets and queues, call it with no permission |
| `AWS::SQS::Queue`, `AWS::SQS::QueuePolicy`, `AWS::S3::Bucket`, `AWS::S3::BucketPolicy` | In the subset, and next: a standard queue with its attributes and its dead-letter queue, a bucket with its notifications and its website; their policies kept without effect |
| `AWS::Lambda::Function`, `Url`, `Alias`, `Version`, `EventInvokeConfig`, `EventSourceMapping` | Outside: SAM's function gives each, by its `CodeUri`, `FunctionUrlConfig`, `AutoPublishAlias`, `EventInvokeConfig` and `SQS` event |
| `AWS::Events::Rule`, `AWS::Scheduler::Schedule` | Outside: a function's `Schedule` or `ScheduleV2` event makes its schedule |
| `AWS::IAM::…` | Outside: FF has no IAM |
| `AWS::Serverless::LayerVersion`, `AWS::Lambda::LayerVersion` | Outside: FF has no layers |
| `AWS::Serverless::SimpleTable`, `AWS::DynamoDB::…` | Outside: FF's databases are PostgreSQL's, made with `ff db create` beside the template |
| `AWS::Serverless::Api`, `AWS::Serverless::HttpApi`, `AWS::ApiGateway::…`, `AWS::ApiGatewayV2::…` | Outside: a function's `FunctionUrlConfig` gives it a URL |
| `AWS::SNS::…` | Outside: a queue and a function's `SQS` event carry messages |
| `AWS::Serverless::StateMachine`, `AWS::StepFunctions::…` | Outside: FF has no Step Functions |
| `AWS::Serverless::Application`, `AWS::CloudFormation::Stack` | Outside: each template is deployed on its own |

## The stack FF keeps

A deploy keeps the stack in FF: each logical ID with its type and the FF resource it made, by SAM's names, `<function>`,
`<function>Url`, `<function>Alias<alias>`, `<function>EventInvokeConfig` and `<function><event>`, an event's schedule
or reading of a queue, and each permission, kept without effect; the template's SHA-256, and the parameters' values, a `NoEcho` one left out. The next deploy changes what the
template changed and deletes, after asking (`--yes` in a script), what it no longer has, last, as CloudFormation cleans
up. `ff get` and the console name a function's stack, and `ff delete-stack` deletes it with what it made.

**A resource's `DeletionPolicy: Retain`** leaves what it made in the account, out of the stack, once the template has it
no more and at `ff delete-stack`, as CloudFormation does with the policy of the template it was made by. A function's
URL, alias, settings and events follow the function's policy, as SAM gives them its. **`UpdateReplacePolicy: Retain`**
does the same for what a new name replaces, a function given another `FunctionName` or a schedule another `Name`, by the
new template's policy. What is left is the account's, as any function made with `ff`: a template that names it again is
refused, as CloudFormation refuses a name that exists, until `ff delete` deletes it or the template names another.

## Checking a template

`ff doctor template.yaml` reads it as `ff deploy` does, with the parameters' values `sam deploy` would take: what is
outside the subset is a warning, since AWS takes it, and what CloudFormation would refuse an error. AWS's own linter
checks it too, with one of AWS's regions, since FF's isn't in its list:

```bash
sam validate --lint --region eu-west-3
```

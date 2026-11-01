# ADR 0016: SAM templates, read by `ff`, a stack kept by FF

| | |
|---|---|
| **Status** | Accepted: the [step-5 plan](../step-5-plan.md)'s D11, and its choices (its §9, 9 and 10), confirmed on 2026-10-31 (the [decision log](../decisions.md)'s 51 to 64); what the SAM CLI asks AWS, and how a template's YAML is read in Rust, measured by X-01's spikes the same day |
| **Date** | 2026-10-31 |
| **Implementation** | Step-5 plan: decision D11 (the CLI plan's C-30); tasks X-12 (`ff deploy` from a `template.yaml`) and X-13 (SAM's events, queues and buckets) |
| **Related** | [ADR 0002](0002-cli.md) (the `ff` command); [ADR 0010](0010-queue.md) (a queue's URL inside the cluster); [ADR 0014](0014-lambda-api.md) (Lambda's API) and [ADR 0015](0015-versions-and-aliases.md) (`AutoPublishAlias`'s versions and aliases); the spikes, [`hack/spikes/sam-yaml`](../../hack/spikes/sam-yaml/README.md) and [`hack/spikes/lambda`](../../hack/spikes/lambda/README.md)'s SAM part |

## Context

On AWS, an app's functions, URLs, queues, buckets and events are often one file: a SAM template, `template.yaml`, which `sam build` builds and `sam deploy` turns into a CloudFormation stack. On FF, nothing reads one: `ff deploy` takes a folder or a file with flags, and the small app is set up by about twenty `ff` commands. A template that `sam deploy` takes as it is on AWS, and `ff deploy` on FF, is the parent plan's ADR-009, and the export kit (X-02) writes one back.

### What the SAM CLI does with a template, measured

`hack/spikes/lambda/`'s SAM part: the SAM CLI 1.169.0 on a small app's template (a function with a public URL, an SQS event and an alias published with each change, its queue, a bucket), every AWS endpoint pointed at the spike's. `sam validate`, `sam validate --lint` and `sam build` asked AWS nothing. `--lint` refuses a region outside AWS's list, FF's among them (`Regions ['tn-tunis-1'] are unsupported`, cfn-lint's words): the region only picks the resources' specification to check against, so a lint runs with one of AWS's and passes. `sam build` leaves `.aws-sam/build/`: a folder for each function, its code and its `node_modules`, and a template whose `CodeUri` names that folder.

### A template's YAML, read in Rust, measured

`hack/spikes/sam-yaml/`: a reader of about 300 lines on yaml-rust2 0.13's events, a crate of its own. Five templates read value for value as cfn-flip 1.3.0, AWS's own converter, reads them: `sam init`'s hello-world for Node.js and for Python, the small app, a fixture with all 18 of CloudFormation's short tags, and one of plain scalars. CloudFormation's guide says it supports YAML 1.1 with a few exceptions (no aliases, no merges, none of the `binary`, `omap`, `pairs`, `set` and `timestamp` tags), and cfn-flip and the SAM CLI read through PyYAML, YAML 1.1 too: typed as YAML 1.2, 12 of the fixture's 17 plain scalars read otherwise (`yes` a string, not a boolean; `0755` 755, not 493; `1:30` a string, not 90). yaml-rust2's events carry each value's line and column but not a tag's own position; serde_json keeps a template's order only with its `preserve_order` feature.

## Decision

### 1. `ff` reads the template, and FF's API does the rest

`ff deploy` in a folder with a `template.yaml` (or `--template`, or `sam build`'s `.aws-sam/build/template.yaml`) reads the template on the machine it runs on, as `sam deploy` does, builds each function's code as `ff package` builds it, and makes or changes what the template declares, in order, through FF's API. The backend never reads YAML: a template is the customer's file, and what reaches FF is the API's requests, checked as any are.

### 2. The template read as CloudFormation reads it

The reader is the spike's grown up (`cli/src/sam.rs`, brought into `ff` by X-04's `ff doctor`; X-12 builds on it), on yaml-rust2's events: each short tag in its long form, plain scalars typed by YAML 1.1's rules as CloudFormation and AWS's tools type them, and every value's line kept, so that each message names the file and the line. What CloudFormation doesn't take is refused at its line, before anything is made: an alias, a merge, YAML's tags it lists, a tag it doesn't have, a key given twice, a second document. A template FF takes is one AWS takes too.

### 3. The subset, and one refusal for what is outside it

The plan's D11: `Globals`; `Parameters` with `--parameter-overrides` and `samconfig.toml`; `!Ref`, `!GetAtt`, `!Sub`, `!Join` and the pseudo parameters as FF's (`AWS::Region`, `AWS::AccountId`, `AWS::StackName`); `AWS::Serverless::Function` with its code, handler, runtime, memory, timeout, description, environment, tags, reserved concurrency, URL, `AutoPublishAlias`, async settings and dead-letter queue, and its events of the types `Schedule`, `ScheduleV2`, `SQS`, `S3` and `HttpApi`; `AWS::SQS::Queue`; `AWS::S3::Bucket` with its notifications and its website; `AWS::Lambda::Permission`; `Outputs`, printed. `Policies` are read and left for AWS: on FF a function's key reaches its account. Anything else fails before any change, in one message listing every resource and key outside the subset, each with its line.

### 4. A stack, kept by FF

A deploy's **stack**, named by `--stack-name` or `samconfig.toml`, is kept in FF (`/stacks`): for each resource the template made, its logical ID, its type and the FF resource it is; the parameters it was deployed with; and the template's SHA-256, to tell when it changed. Not the template's text: the template is the customer's, in their repository, as the code is. The next deploy changes the stack's resources, and removes those the template no longer has after asking (§9, 9); `ff delete-stack` removes them all, as `sam delete`. The console and `ff get` say when a function belongs to a stack.

### 5. What a template means on FF

`!Ref` of a queue in a function's environment gives the URL functions reach inside the cluster, so that AWS's SDK for JavaScript, which sends to the URL's host, keeps working. FF's secrets stay out of templates: set with `ff secrets` or `ff db create --secret-for`, and a template variable with a secret's name is refused. `sam init`'s hello-world, whose `Api` event FF doesn't have, is refused with a message naming `FunctionUrlConfig` and `HttpApi`, and `ff init --template sam` writes FF's variant of it, its output naming a function URL. FF's tools and documents lint a template with `sam validate --lint --region` and one of AWS's regions.

## Consequences

- One file describes an app on both: `sam deploy` takes it on AWS, `ff deploy` on FF, and the export kit writes it back.
- The `ff` command gains a YAML reader and its dependency, yaml-rust2, which the spike chose: maintained, the most used, its newest release weeks old, where serde_yaml is deprecated, serde_yml at 0.0.x and saphyr's newest days old.
- A template's mistakes are named at their line before anything changes, in CloudFormation's terms.
- A stack is FF's record of what a template made, so a resource removed from the template can be removed from FF; the template stays the customer's.
- `ff`'s JSON keeps a template's order only if X-12 turns serde_json's `preserve_order` on, which would change the order of every map `ff` prints: it keeps the order beside the values instead, or turns it on knowingly.
- What is not here: CloudFormation itself (FF builds no stacks of CloudFormation's own, What to build next §11), `Conditions` for now, nested stacks, and resources outside the subset.

## Alternatives considered

- **The backend reading templates:** a YAML parser and a template's semantics in the server every account calls, where the CLI can read the file on the customer's machine and send the API's requests, checked as any are.
- **A CloudFormation-compatible engine on FF:** CloudFormation's whole model, its resources and its rollbacks, for an app's dozen resources that FF's API already makes.
- **A YAML 1.2 reader, as yaml-rust2's own loader reads:** `yes`, `0755` and `1:30` would mean on FF what they don't on AWS.
- **serde_yaml or serde_yml:** the first deprecated, the second young; saphyr, yaml-rust2's successor, can replace it later, its events being the same in kind.
- **Keeping the template's text in the stack:** the customer's file twice, one copy out of date at the first edit.

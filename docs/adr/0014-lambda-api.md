# ADR 0014: Lambda's API, a front door of the backend's own

| | |
|---|---|
| **Status** | Accepted: the [step-5 plan](../step-5-plan.md)'s D1 to D8, and its choices (its §9), confirmed on 2026-10-31 (the [decision log](../decisions.md)'s 51 to 64); what AWS's tools call, and what a key's end and a pod's replacement do, measured by X-01's spikes the same day |
| **Date** | 2026-10-31 |
| **Implementation** | Step-5 plan: decisions D1 to D8; tasks X-07 (one signature check, keys that reach functions), X-08 (functions' keys that expire), X-09 (the endpoint, and functions), X-10 (invoke, and the rest of Lambda's settings) |
| **Related** | [ADR 0009](0009-buckets.md), [ADR 0010](0010-queue.md) and [ADR 0012](0012-customer-mail.md) (the S3, SQS and SES front doors this one joins); [ADR 0015](0015-versions-and-aliases.md) (versions and aliases); [ADR 0016](0016-sam-templates.md) (SAM templates); the spikes, [`hack/spikes/lambda`](../../hack/spikes/lambda/README.md) and [`hack/spikes/keys`](../../hack/spikes/keys/README.md) |

## Context

FF speaks four of AWS's APIs already, each a port of the backend's own behind the edge: S3 (3002), SQS (3003), the sites (3004) and SES (3005), where the checks of keys, plans and credit live. Its functions are made and called through FF's own API, the console and `ff`. "No lock-in" means more: `aws lambda …`, AWS's SDKs, Terraform's AWS provider and the SAM CLI working against FF with one endpoint setting, as they work against AWS.

Three things stood in the way. Each front door reads Signature Version 4 with a copy of its own, and Lambda's paths are signed as SES's, not as S3's. FF's API keys keep only a hash of their secret, so they can't check a signature: the account's access keys (`AKFF…`, made for buckets) reach no function. And a function's own key works until the function is deleted, where a Lambda role's credentials end within 12 hours (decision 10's promise).

### What AWS's tools call, measured

`hack/spikes/lambda/`: a minimal Lambda endpoint, Node.js's standard library alone, D2's 41 operations in memory, a function `Pending` for 3 s and an update `InProgress` for 2 s as Lambda's are, every request recorded whole as signed. Against it, the AWS CLI 2.34.32, the SDK for JavaScript 3.1156.0 and boto3 1.43.118 each took a function through its whole life (made, waited for, called with its log's tail and without waiting, 6 MB of code, its settings, a version, an alias called by name and by ARN, a URL, a permission, an SQS mapping, async settings, a concurrency, tags, every read, deleted); Terraform's AWS provider 6.69.1, with OpenTofu 1.13.1 and Terraform 1.16.6, applied, planned again and destroyed what the reference modules hold; the SAM CLI 1.169.0 validated and built a small app.

| What | Measured |
|---|---|
| Operations | D2's alone, from every tool; 168 requests from the three clients, 49 from the provider, none from the SAM CLI, which checks and builds offline |
| Paths | signed as every service but S3 signs them, each segment escaped again: an ARN in a path, `arn%3Aaws%3Alambda…` on the wire, is signed over `arn%253Aaws%253Alambda…` |
| Signed headers | the SDK for JavaScript signs six headers, eight with a body, `x-amz-content-sha256` among them; boto3 and the CLI sign `host` and `x-amz-date`, with `content-type` for a body, and send no payload hash |
| Waits | `GetFunction` until `Active` or `Successful`: boto3 every 1 s for up to 5 minutes, the SDK from 1 s with jitter, the provider every 5 s, so a function made by Terraform costs at least 5 s |
| Refusals | `409 ResourceConflictException` (a call while `Pending`, a change during a change) and `400 UnknownOperationException` (an operation FF doesn't offer yet) shown at once, never retried; `404 ResourceNotFoundException` the clients' own modeled exception |
| The largest body | a 6 MB zip, 8.4 MB of JSON in base64, sent with a `Content-Length`; Lambda takes 50 MB zipped, about 67 MB of JSON |
| A clean plan | an alias with no second version answers without `RoutingConfig`, and async settings answer only what was set: Lambda's defaults sent back read to the provider as a change to make each time |

### A key's end and a pod's replacement, measured

`hack/spikes/keys/`: past its key's end, both SDKs show the service's own refusal at once, one request each (`ExpiredToken` for S3 and SQS, `ExpiredTokenException` for SES and Lambda). With `AWS_CREDENTIAL_EXPIRATION` in the environment, boto3 sends nothing and raises `RuntimeError: Credentials were refreshed, but the refreshed credentials are still expired.`, from 10 minutes before the key's end. A function at one instance, called without pause by four callers while its environment changed (a new Secret, then the rollout, the path a renewed key takes): none of 573 and 587 calls lost through FF's API and the cluster API's proxy, but 166 of 742 on production's path, straight to the function's Service, where the backend's kept-alive connections went on reaching the old pod, which answers `503 Runtime is shutting down` while it drains. With the fix below, the same run lost none of 569, 578 and 576. A rollout of one instance costs the cluster's API about 85 requests.

## Decision

### 1. A front door of the backend's own, on its own port

A sixth server of the backend's, on `FF_LAMBDA_PORT` (3006), at `https://lambda.<domain>` behind the edge, and inside the cluster at `ff-storage`'s fixed address, where functions reach it with their key and `AWS_ENDPOINT_URL_LAMBDA`. Lambda's REST API in JSON, at the dated paths AWS documents for each operation; a function named by its name, its ARN or its partial ARN, with `:version` or `:alias` after it. Each answer carries `x-amzn-RequestId`; each refusal comes in Lambda's error shape, its type in `x-amzn-ErrorType`; another account's function answers as a missing one. It is a translation over FF's own services, as the SQS endpoint is: nothing about a function differs by the way it came, and the audit log names the access key.

### 2. 41 operations first, the others refused saying they come later

The plan's D2: functions, `Invoke`, versions and aliases, URLs, SQS mappings, async settings, permissions, concurrency, tags, `GetAccountSettings`, which the spike found the tools call and no other. Every other operation answers `400 UnknownOperationException`, naming it and saying FF doesn't offer it yet, which every client shows at once and none retries. The two operations that carry code take a body of up to about 67 MB, Lambda's 50 MB zipped in base64.

### 3. One signature check for every AWS API

One module reads and checks Signature Version 4 for every front door, told three things by each: its service's name, how its paths are signed (S3's way, or each segment escaped twice, as the spike measured for Lambda), and its error words. It checks the headers each client names, whatever they are, and takes the payload's hash from `x-amz-content-sha256` when there is one and from the body when there isn't. It is tested against AWS's published Signature Version 4 suite and the spike's recordings, and the three readers of today move onto it, their tests passing as they are. An `AWS_IAM` function URL also takes a request signed for `lambda` by a key that may invoke the function.

### 4. Access keys that reach functions, at three levels

The account's access keys may name the functions they reach, or all of them, at one of three levels close to how IAM groups Lambda's actions: **read**, **invoke** (and so an `AWS_IAM` URL), **write**. A key made before this step reaches no function until it is given some. Keys get names, and an account may have more than two. A function's own key may invoke its account's functions, as a role allowed `lambda:InvokeFunction`.

### 5. A function's own key lasts 12 hours, and no call is lost when it is renewed

A function's own key works 12 hours, as a role's session can last. At half its life the backend writes a new one into the function's environment Secret and replaces its pods one at a time, each new pod ready before an old one goes; a function scaled to zero starts with a fresh key. The variables stay those of today, with `AWS_ENDPOINT_URL_LAMBDA` beside them: no session token, and no `AWS_CREDENTIAL_EXPIRATION`, with which boto3 fails before the key does and says nothing of why. An expired key is refused in each service's words, as the SDKs show them.

**First, a rollout loses no call** (X-08's part 1, done before the rest). Told to stop, a runtime answers the call it runs and refuses every other, one waiting its turn or one that comes on a connection still open, with `503` and `X-FF-Not-Run: shutting-down`: the call never ran. Each answer closes its connection, so that the caller's next call opens one the Service gives a ready pod. The runtime closes no other connection itself, since a call could be crossing it and would be lost: it waits for its callers to close them, the backend each one it leaves unused for 5 seconds, and exits once nothing runs and no connection is open, at the latest a second past the function's timeout or those 5 seconds. The backend tries a call refused as never run again, on a connection of its own, as it tries a connection refused, for 5 seconds from the first refusal. Every rollout of a busy function gains it, a deploy's and a scale-down's as much as a renewal's. The renewal's cost is small: a hundred warm functions make 17 rollouts an hour, 17 Secrets written and about 1,400 requests to the cluster's API, and a renewal needs only the Secret and the Deployment of a deploy's seven applies.

### 6. Changes answered at once, as Lambda answers them

`CreateFunction` answers at once with `State: Pending`, an update with `LastUpdateStatus: InProgress`; FF's rollout goes on after the answer, a real instance checked and a failure rolled back, and `GetFunction` then says `Active` or `Successful`, or `Failed` with its reason, the previous version still live. A second change while one rolls out is refused with `ResourceConflictException`, which the clients wait out with their waiters rather than retry; `RevisionId` is checked as Lambda checks it. `GetFunction` must be cheap: the waiters ask it every second.

### 7. Each of Lambda's settings kept, mapped onto FF's, or refused aloud

The plan's D7: the role, the description, tags and the log's settings kept as given; the runtime, the code (a zip in the request or in a bucket the key reaches), the reserved concurrency, the dead-letter queue, the variables, the architecture and `/tmp` mapped onto FF's; what would change what runs and FF can't do (a VPC, layers, a KMS key, file systems, images, SnapStart, code signing, active tracing, object versions) refused, saying why. Permissions are kept as sent and given back, not enforced: FF's keys and URLs decide, and that is said everywhere.

### 8. Invoke, as Lambda's

A function that threw or timed out answers 200 with `X-Amz-Function-Error: Unhandled` and Lambda's error document; `X-Amz-Executed-Version` names the version that ran; `X-Amz-Log-Type: Tail` gets the call's last 4 KB of output in `X-Amz-Log-Result`, which the runtimes give back with their answer, since the log store sees lines about 5 seconds late. `Event` 202 and `DryRun` 204; `413 RequestTooLargeException` and `429 TooManyRequestsException`, with its reason, as Lambda's.

## Consequences

- AWS's tools reach FF's functions with one endpoint setting, signed as they sign for AWS, and what FF doesn't do yet is said in Lambda's own words, not retried.
- One signature check instead of three: what matters most is in one place, tested once, against AWS's suite and the recordings.
- Keys gain names, levels and functions; a key of before reaches nothing new, so no key gains a right it didn't have.
- A key copied out of a function stops working within 12 hours. The fix that makes its renewal lose no call came first, and makes every deploy and scale-down of a busy function lose none too, where production lost some before it.
- A pod told to stop lives up to 5 seconds longer, while the backend's connections to it close, and in development, where the cluster API's proxy keeps its own 90 seconds, until the runtime's limit: a second past the function's timeout or those 5 seconds.
- The nightly's `tools` job tries each tool's newest release against the recordings: a change in what a tool sends is known the next morning.
- What is not here: Lambda's other operations, IAM's policies, and the Lambda service as a server of its own, which the same code can become later, as the website server could.

## Alternatives considered

- **A Lambda server apart from the backend:** a seventh deployment, its own copy of the checks of keys, plans and credit, for an API that is a translation of the backend's own. The front doors' pattern keeps one place for them; a server of its own can come from the same code.
- **Lambda's whole API at once:** about 70 operations, where the tools call 41; the others are refused saying they come later, which no client retries.
- **Temporary credentials with a session token, as STS gives:** every front door would have to learn tokens, for no more protection than an expiry gives a key that the backend renews.
- **`AWS_CREDENTIAL_EXPIRATION` beside the key, so that SDKs know its end:** boto3 then fails 10 minutes before the key does, with a message that names nothing.
- **Renewing keys by restarting pods all at once:** every call in flight lost, and every caller's next one refused while the pods start.
- **Trying again a call whose kept-alive connection was reset:** what Node.js's documentation suggests for a request that can be sent twice, but a call's connection is reset too when its pod dies under it, and the call would run again. HTTP says a client should not send again on its own a request that may have been applied, a POST's, unless it knows it was not; the runtimes say which calls never ran, and close no connection a call could be crossing.
- **Holding each pod a few seconds before it stops** (a `preStop` sleep), the usual remedy: the Service's endpoints move first, but connections kept alive still lead to the old pod, and every pod's stop takes the longer.

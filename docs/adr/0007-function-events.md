# ADR 0007: The event a function receives

| | |
|---|---|
| **Status** | Accepted; its choice for the functions made before, the wrapper until switched, confirmed by you on 2026-10-22 with the step-1 plan's other choices (its §9) |
| **Date** | 2026-10-21 |
| **Supersedes** | The event of FF's original wrapper, `{ body, headers, method, query, path }`, which the Kubernetes migration kept (K-05) |
| **Implementation** | [Step-1 plan](../step-1-plan.md): decision D5, task U-03 |
| **Related** | [Parent plan](../local-markets-and-aws-portability-plan.md) §6.2 (the runtime contract), §6.4 (event payloads), Appendix D, task R-04; the [CLI plan](../cli-plan.md)'s question 1 |

## Context

A handler on FF gets `handler(event, context)`, as on AWS Lambda, but not Lambda's `event`. Both runtimes build it from the HTTP request the backend sends to the pod:

```json
{ "body": { "name": "Tunis" }, "headers": { "content-type": "application/json", "x-ff-request-id": "…" }, "method": "POST", "query": {}, "path": "/invoke" }
```

`body` is what the caller invoked the function with. The rest describes the backend's own request to the pod, which means nothing to the function. On Lambda, a direct invoke hands the payload to the handler as `event` itself. So every handler written for FF reads `event.body`, and fails on Lambda, which is the move FF promises to keep open (parent §3.3).

Three things make this the moment to change it:
1. **The events step 1 brings are AWS's.** A function URL hands the handler API Gateway's payload 2.0; a schedule, EventBridge's "Scheduled Event" (parent §4.6). Under the wrapper, they would arrive inside `body`, which works nowhere else.
2. **The CLI's `ff init` templates and `ff local`** (CLI plan, C-06 and C-07) need to know what a handler reads before they are written.
3. **No customer has functions yet,** but the operator's own development functions read `event.body`, and must not break unseen.

## Decision

### 1. The payload is the event: runtime protocol v3
The body of the runtime's `POST /invoke` is the event, handed to the handler as it is: any JSON value, a string or a number as well as an object. The runtime no longer looks at the request's headers, method or path for the event. Everything else of protocol v2 stays: the probes, the `X-FF-*` headers, the errors, the logs.

### 2. The backend builds every event
- a direct invoke: the caller's `input`, as it came, any JSON value, as Lambda's `Invoke` takes it;
- a function URL: API Gateway's payload 2.0, built from the HTTP request (step-1 plan, D6);
- a schedule: EventBridge's "Scheduled Event", or the schedule's fixed input (D9);
- later, a queue's or a bucket's records (steps 2 and 3).

The runtime stays the same for all of them: one way for an event to reach the code.

### 3. Existing functions keep the wrapper until switched
Each function has an `eventFormat`:
- `lambda`, the default for every new function;
- `wrapped`, which a migration gives every function that existed before.

The deployment tells the runtime with `FF_EVENT_FORMAT`. For `wrapped`, the v3 runtime builds v2's wrapper itself, so such a function's handler sees what it always saw, on a v2 pod not updated yet as on a v3 one. Switching is an update (`{"eventFormat": "lambda"}`), rolled out and checked like any, and rolled back if the new version can't start.

### 4. Function URLs and schedules need `lambda`
A `wrapped` function would get AWS's event inside `body`. The API refuses a URL or a schedule for one, and says how to switch.

### 5. New image tags, and no older runtime by mistake
The images are `ff-runtime-nodejs:24-v3` and `ff-runtime-python:3.13-v3`, the backend's defaults. Its configuration refuses a runtime image tagged `-v1` or `-v2`: such a runtime would hand a `lambda` function the wrapper, silently. A running function keeps its image until its next update, which is harmless either way: its format doesn't change with the image.

## Consequences

- **Portable handlers.** `exports.handler = async (event) => event.name` runs on FF and on Lambda alike, and so does a handler written for API Gateway or EventBridge.
- **Every example, test and document that read `event.body` changes** to read the event itself: `examples/`, the runtimes' fixtures, the L3 to L5 suites, the getting-started guide and `how-it-works.html`.
- **The console's invoke box** takes any JSON value, and a `wrapped` function's page says what its handler gets, with the switch.
- **`ff doctor`** (CLI plan, C-33) flags a function still `wrapped`; `ff export` refuses one, or says what to change.
- **The context object doesn't change** here. Lambda's other fields (`invokedFunctionArn`, `logGroupName`) wait for the region and ARN names of the parent's ADR-006.

## Alternatives considered

- **Switch every function at once.** Simpler, and no customer has a function yet; but the operator's development functions would break without a word, and a pilot customer who started before the change would too. A switch per function costs one column and a few lines in each runtime.
- **The backend builds the wrapper, and the runtime only passes events through.** Then a `wrapped` function still on a v2 pod would wrap the wrapper again. The runtime building it from a setting gives the same event from v2 and v3.
- **A header per call naming the format.** A v2 runtime ignores headers it doesn't know, so the same double wrapping, and the format is a property of the function, not of a call.

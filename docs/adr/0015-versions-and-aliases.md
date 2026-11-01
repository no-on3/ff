# ADR 0015: Versions and aliases, each version in pods of its own

| | |
|---|---|
| **Status** | Accepted: the [step-5 plan](../step-5-plan.md)'s D9, and its choices (its §9, 7), confirmed on 2026-10-31 (the [decision log](../decisions.md)'s 51 to 64); how a version runs on the cluster measured by X-01's spike the same day |
| **Date** | 2026-10-31 |
| **Implementation** | Step-5 plan: decision D9; tasks X-05 (versions and aliases in the backend) and X-06 (in the console, `ff` and the admin app), with X-09 and X-10 for Lambda's operations of them. As built: X-05's scaler, idle sweep and capacity samples (below), decision 2 changed |
| **Related** | [ADR 0003](0003-code-delivery.md) (one code image per package, which a version names by digest); [ADR 0014](0014-lambda-api.md) (Lambda's API); [ADR 0016](0016-sam-templates.md) (SAM's `AutoPublishAlias`); the spike, [`hack/spikes/versions`](../../hack/spikes/versions/README.md) |

## Context

A function on FF is one version, `$LATEST`: a Deployment and a Service, both named `fn-<id>`, its pods chosen by the label `ff.dev/function-id`. Staging and safe deploys need more, and AWS's tools expect it: SAM's `AutoPublishAlias` publishes a version and moves an alias at each deploy, Terraform has `aws_lambda_alias`, and an alias can send a share of its calls to a second version. Code is already one image per package, named by digest, so a version costs a row until it is called.

### How a version runs, measured

`hack/spikes/versions/`: a function made through FF on the dev cluster (k3s 1.37.1), and beside its `$LATEST` a version 1 made by hand from `$LATEST`'s Deployment and Service, a label `ff.dev/version` on it, its pods and its selector, `FUNCTION_VERSION` set to 1; 13 checks, about 2 minutes.

| What | Measured |
|---|---|
| A version's first call from zero | ready after 5.2, 4.7 and 4.0 s, answered 16 ms later each time, none refused while its Service caught up; `$LATEST` from zero through FF, 6.1 s |
| `$LATEST`'s Service, its selector the function's ID alone, with version 1's pod up | 43 of 100 calls answered by version 1 |
| `$LATEST`'s Deployment | kept its own pod: each ReplicaSet owns the pods of its template's hash |
| FF's counts of the function's instances, two pods ready | `readyInstances` 1 (`$LATEST`'s Deployment by name), `readyInstancesByFunction` 1 (the last Deployment listed per function); the function's Deployments listed by label, 2 |
| An alias with 10 % to version 1, routed by the caller, each version behind a Service of its own | 107 of 1,000 calls to version 1 (76 to 124 is chance's 99 %), each answered by the version it was sent to, none failed; 1.6 ms a call at the median through the proxy, 52 ms at the 95th percentile |

Read in the code: a function's environment is in two Secrets written in turn, `fn-<id>-env-0` and `-1`, a new one going into the Secret its running pods don't read; a version copied from `$LATEST` would share one, and `$LATEST`'s second change of environment after it would overwrite it.

## Decision

### 1. A version is published once, and frozen

Publishing (`PublishVersion`, `POST /functions/:id/versions`, `ff publish`) makes version 1, 2, 3… of a function, never reused: its package by digest, its runtime, handler, memory, timeout, event format and description, and its variables and secrets as they were, in a Secret of its own (`fn-<id>-v<n>-env`) written once, never one of `$LATEST`'s two. `CodeSha256` and `RevisionId` are checked when given; when nothing changed since the last version, publishing answers with that version, as Lambda does.

### 2. Each version that is called runs in pods of its own

A version's Deployment and Service, `fn-<id>-v<n>`, are made at its first call and scaled to zero when idle, as `$LATEST`'s is: its first call costs a pod's start, 4 to 5 s on the dev cluster, as a cold `$LATEST` does. Its pods carry `ff.dev/function-id`, by which the log pipeline gives each line to its function, and `ff.dev/version` with the version's number, which its Deployment's and its Service's selectors name too. The runtime is told its number (`FUNCTION_VERSION`), so its log lines say `Version: 3` and `context.functionVersion` is the version's.

### 3. The first publish moves `$LATEST` onto a label of its own

A Service selects pods by equality alone, so `$LATEST`'s, which names the function's ID only, would take a version's pods for its own. When a function's first version is published, `$LATEST`'s pods take `ff.dev/version: latest` (a label can't hold `$`): first in their Deployment's template, which rolls them, then, once they all carry it, in its Service's selector, so that the Service never has no pod. `$LATEST`'s Deployment keeps its selector, which can't change and needn't: its ReplicaSets own their pods by their template's hash. A function never published stays as today, and nothing rolls at the upgrade.

### 4. A function's instances are counted together

`maxInstances` and the plan cap the sum of a function's instances across its versions: the counts list the function's Deployments by its label and add them up (where `readyInstances` reads `$LATEST`'s by name and `readyInstancesByFunction` keeps the last one listed today); the scaler raises the Deployment of the version a call is for, within what the sum leaves; the idle sweep scales each version's to zero on its own idleness. Warm instances (`minInstances`) stay `$LATEST`'s in this step.

### 5. An alias is chosen at each call, by the backend

An alias names a version, or `$LATEST`, and at most one other version with a share of the calls. The backend, which makes every call, picks the version by the alias's weights and calls that version's Service, as it calls `$LATEST`'s today: nothing in the cluster changes when an alias moves or its weights change, and moving it back is a rollback. A version or an alias can be named wherever a function is: an invoke, a URL (one per alias), a mapping, a destination, a schedule, a bucket's notification; the history and the metrics say which version ran each call, and the alias it came through.

### 6. What goes with what

A version is deleted only when no alias names it; deleting the function deletes its versions and aliases, their Deployments, Services and Secrets. The packages versions name are kept, and count against the account's code storage.

### As built (X-05): the scaler, the idle sweep and the samples

Decision 2 changed: an idle version isn't scaled to zero. After its plan's idle window, and at once when its account is suspended or closed, its Deployment, Service and Secret are removed, so that a function's versions that no one calls hold nothing in the cluster, however many, where each would keep a Deployment and a Service at zero. Its next call makes them again from the version's record: the cold start its first call costs. Decision 4 as built: `$LATEST` and each version called are scaled apart, each on its own calls, up to `maxInstances` less what the function's others ask for, read in one list of the function's Deployments; one that has calls keeps one instance even when the others hold all of `maxInstances`, and the account's quota caps the pods as before. The capacity samples take each Deployment apart, a row each minute with its version (0 for `$LATEST`), at the memory it runs with, a version's as published, `minInstances` `$LATEST`'s alone: the bill prices a version's instances at its own memory, never as provisioned time, and the metrics of the calls a version ran have its pods' instances.

## Consequences

- SAM's `AutoPublishAlias`, Terraform's `aws_lambda_alias` and Lambda's qualified calls work on FF, and a version that is never called costs a row.
- A version's first call is a cold start; a version called often stays warm by its own calls.
- The counts of instances, the scaler and the idle sweep read a function's Deployments by its label: three places that read one Deployment by name today change, and the capacity's count with them.
- A function's first publish rolls its `$LATEST` once, which, with ADR 0014's fix for a rollout's calls, loses none.
- An alias's weights live in the backend's records, not in the cluster, so changing them is a write of a row.

## Alternatives considered

- **A label on every function's `$LATEST` at the upgrade:** every function rolled once, for the few that publish versions.
- **Versions' pods without `ff.dev/function-id`, under a key of their own:** `$LATEST` untouched, but two keys for one meaning, which the log pipeline and every reader of pods would have to know.
- **The cluster splitting an alias's calls** (weighted routes, a mesh): an object to rewrite at each change of weights, where the backend already makes each call and can choose.
- **One Deployment running every version's code:** a version's pods would no longer be its own, nor its environment, nor its number in the logs.
- **A version sharing `$LATEST`'s environment Secrets:** its environment would change under it at `$LATEST`'s second change after it.

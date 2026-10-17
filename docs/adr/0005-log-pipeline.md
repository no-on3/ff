# ADR 0005: The log pipeline

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-17 |
| **Supersedes** | Nothing: D10 of the client-readiness plan left the collector to this spike |
| **Implementation** | [Client-readiness plan](../client-readiness-plan.md): decision D10; tasks P-42 (the pipeline), P-43 (the logs API), P-45 (deletion at account closure) |
| **Related** | [Parent plan](../local-markets-and-aws-portability-plan.md) ADR-008 (VictoriaLogs); the spike's harness, [`hack/spikes/p41-logging/`](../../hack/spikes/p41-logging/README.md) |

## Context

A function's logs live today in its pod: `GET /functions/:id/logs` reads them through the Kubernetes API (P-40), and they go when the pod goes. D10 decided the path that keeps them:
1. Function pods write to stdout.
2. A collector DaemonSet reads the container logs of `ff-t-*` namespaces only.
3. It adds the tenant, the pod, the function and the request ID.
4. It writes to VictoriaLogs, which only the backend may query.

D10 left five questions to this spike:
1. Which collector, Vector or Fluent Bit?
2. Is the delay from a `print` to a query result under 5 s?
3. Can each namespace's ingestion be limited, so that one function printing in a loop can't fill the store?
4. Can the request ID be read from both runtimes' output?
5. Can one account's logs be deleted, and how does retention work?

The answers must fit a cluster the size of a laptop's: the collector runs on every node.

## How it was measured

`hack/spikes/p41-logging/run.sh` runs on the k3d development cluster, one node:
- **The stack:** a backend of its own in development mode, with two accounts, so two tenant namespaces. Account A has a Node.js and a Python function, and account B a Node.js one, each printing two lines per call.
- **Each collector in turn,** with a fresh VictoriaLogs and fresh function pods, so that neither reads the other's history. Both collectors are configured alike:
  - the function containers of the spike's namespaces;
  - the namespace, the pod, the function ID and the request ID;
  - 200 lines a second per namespace;
  - lines cut past 16,384 characters.
- **The versions,** each at least two weeks old: VictoriaLogs v1.53.0 (2026-10-01), Vector 0.58.0 (2026-08-26; 0.59.0 was too recent) and Fluent Bit 5.1.3 (2026-10-01).
- **CPU and memory** come from the node's `crictl stats`: CPU time used, and the working set.

| | Vector 0.58.0 | Fluent Bit 5.1.3 |
|---|---|---|
| Delay from a call to all its lines queryable, median of 20 calls | 2.0 s | 1.4 s |
| The same, slowest | 2.1 s | 1.5 s |
| A new pod's first call's lines, from the collector's start | 2.7 s | 1.1 s |
| Idle | 16 MiB, 1 ms CPU a second | 5 MiB, under 1 ms CPU a second |
| A 20,000-line burst in A, while B calls 5 times | 185 MiB at most; 615 ms CPU | 7 MiB at most; 215 ms CPU |
| The burst's lines kept, by the limit of 200 a second | none after 8 s; 597 after 30 s | 399 after 8 s, as after 30 s |
| B's lines during the burst | 25 of 25 | 25 of 25 |
| A 100,000-character line | dropped by default (over 32 KiB); cut with `max_merged_line_bytes` and `max_merged_line_action: truncate` | merged, then cut to 16,384 characters and `…[truncated]` |
| Calls whose 5 lines all have their request ID | Node.js 0 of 10; Python 10 of 10 | Node.js 0 of 10; Python 10 of 10 |
| Node.js user lines written after their call's `END` | 10 of 20 | 10 of 20 |

VictoriaLogs v1.53.0, the same in both phases:

| | |
|---|---|
| Memory | 9 to 13 MiB, idle or during the burst |
| Deleting one namespace's lines, `POST /delete/run_task?filter={namespace="ff-t-…"}` | done in 0.6 to 0.9 s for a few hundred lines; the other namespace's all kept; without the key, 401 |
| Retention, `-retentionPeriod=31d` | a line 40 days old refused when written, and counted (`vl_rows_dropped_total{reason="too_small_timestamp"}`); a new one stored |

Each measurement is the last of several runs: the earlier ones found the five things below, and the harness was fixed for each.

## What the spike found

1. **Vector falls behind on a burst.** It holds the burst's lines for 8 to 30 s before they reach the store, while using 25 times Fluent Bit's memory. Fluent Bit had them stored within 8 s.
2. **A rate limit by the time of processing drops a backlog.** Vector's `throttle` transform counts the lines it processes in each second. So does a Lua filter counting by the wall clock. When a collector restarts, or catches up, it reads minutes of lines in seconds: one namespace's budget is used up at once, and normal lines are dropped. The spike first hit this when Fluent Bit read the previous phase's 20,000-line burst again. Both collectors now count each namespace's lines per second of the lines' own time, in Lua: a backlog keeps each of its seconds' budgets.
3. **Long lines need a setting in Vector.** Containers write a line over 16 KiB in parts, and both collectors merge them. Vector then drops a merged line over 32 KiB unless told to cut it. Fluent Bit merged the 100,000-character line, and the Lua filter cut it.
4. **Node.js user lines come after their call's `END`.** The Node.js runtime runs the handler in a worker thread, whose output reaches the process's stdout asynchronously. The main thread prints `END` and `REPORT` as soon as the result arrives. Every call's last `console.log` line landed after `END`, so a tag running from `START` to `REPORT` misses it. Python's lines are written in order (`PYTHONUNBUFFERED`), and all of them were tagged. P-40's endpoint tags lines the same way, so it has the same gap.
5. **VictoriaLogs reads a JSON line body only with a JSON content type.** With curl's default form type, it reads no line and still answers 200. The collectors send the right type; FF's own writes, if any, must too.

## Decision

### 1. Fluent Bit collects
- **Fluent Bit 5.1.3** runs as a DaemonSet. Why:
  - its delay is lower;
  - it uses a third of Vector's memory idle, a twenty-fifth during a burst, and a third of its CPU;
  - it keeps up with a burst;
  - it handles long lines without a special setting;
  - it is Apache-2.0 (Vector is MPL-2.0).
- **Its pipeline,** as in `fluent-bit.yaml` here:
  - the `tail` input on the containers named `function`, with the CRI parser and its offsets in a file on the node;
  - the `kubernetes` filter for the pod's labels;
  - one Lua filter for the tenant, the function and the request ID, the per-namespace limit, and the cut;
  - the `http` output to VictoriaLogs' `/insert/jsonline`.
- **The limit:** each namespace keeps a number of lines per second of the lines' own time, 200 in the spike. P-42 sets the production figure, and writes one line per namespace and second saying how many lines were dropped, so that the owner can see it.
- **The cut** counts bytes, as LuaJIT has no UTF-8 library. P-42 backs it off to a character boundary.
- **Times:** Fluent Bit writes them to the microsecond (Kubernetes has nanoseconds). Two lines of one pod in the same microsecond may come back in either order.
- **Vector** remains possible. It would need `max_merged_line_bytes` with `truncate`, the same Lua limit (not `throttle`), and the memory to match.

### 2. VictoriaLogs stores
- **VictoriaLogs v1.53.0, single node,** in `ff-system`, as D10 decided.
- **Fields:** the stream fields are the namespace and the function ID. The pod, the stream and the request ID are fields.
- **Retention:** `-retentionPeriod=31d`, the longest plan's 30 days and a day for the partition being written. Each plan's own window is the API's start bound (P-43).
- **Deletion:** `-delete.enable`, with `-deleteAuthKey` (from v1.53.0) known only to the backend.
  - Closing an account deletes its namespace's lines with `/delete/run_task?filter={namespace="ff-t-…"}` (P-45). A data-subject request uses a narrower filter.
  - A deletion rewrites the stored data, so it is for these rare cases, never for retention.
- **Access:** only the backend may reach it (P-42's NetworkPolicy), and the backend builds every query.

### 3. Request IDs: from `START` to `REPORT`, once the Node.js runtime writes in order
- **The collector tags each line** with the call between its pod's `START` and `REPORT`, as P-40's endpoint does. An instance runs one call at a time (D14), so that call is the line's.
- **Before P-42 ships, the Node.js runtime must write a call's output before its `END`.** It starts its worker with `stdout` and `stderr` of its own, and forwards them itself. When the handler settles, the worker writes an end-of-call marker to both streams; the main thread prints `END` and `REPORT` once it has forwarded both markers, waiting a second at most. The output's own order then puts every user line before `END`, and the same change fixes P-40's endpoint.
- **A collector restarted in the middle of a call** loses the tag for the rest of that call's lines. That is rare, and accepted.
- **Rejected:** prefixing each user line with the request ID, as Lambda's Node.js runtime does. It changes what customers see. It can't apply to Python's `print` without wrapping stdout, and the ordering fix is enough.

## Consequences
- **P-42:**
  - the Node.js runtime's ordering change, with a test that checks a call's last line comes before its `END`;
  - the manifests in `deploy/k8s/logging/`: VictoriaLogs as a StatefulSet with a volume, Fluent Bit as a DaemonSet with read-only access to pods' and namespaces' metadata, and the NetworkPolicies;
  - the limit's production figure, the line counting what was dropped, and the cut on a character boundary;
  - L3 tests: a `print` arrives with its function ID and request ID, and a namespace printing in a loop is limited without affecting another.
- **P-43:**
  - the API keeps P-40's shape and reads VictoriaLogs instead of the pods;
  - `start` is bounded by the plan's retention;
  - `q` is a quoted phrase;
  - every query has the namespace and the function in it;
  - lines are sorted by time, the microsecond being the finest the store has.
- **P-45:** closing an account runs the deletion task for its namespace, after the notice period, and checks that it finished (`/delete/active_tasks`).
- **The spike's harness** stays in `hack/spikes/p41-logging/`, to measure again before an upgrade of either component.

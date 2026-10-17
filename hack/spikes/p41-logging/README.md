# P-41 spike: the log pipeline

The measurements behind [ADR 0005](../../../docs/adr/0005-log-pipeline.md): Vector and Fluent Bit, each feeding VictoriaLogs, on the k3d development cluster.

```bash
hack/spikes/p41-logging/run.sh                                  # both collectors, about 6 minutes
COLLECTORS=fluent-bit hack/spikes/p41-logging/run.sh            # one of them
LIMIT=500 RUNS=20 hack/spikes/p41-logging/run.sh                # another limit, more calls per runtime
COLLECTORS=vector VECTOR_DEFAULT_LINES=1 hack/spikes/p41-logging/run.sh   # Vector's default line handling
```

The results go to `hack/.e2e/logging-spike/results.md`. The same directory gets each collector's own log, the burst's lines kept by second, and, when a step fails, the store's lines.

## What it does
- **The stack:** the e2e stack of `hack/lib/e2e-stack.sh` (compose project `ff-logging-spike`, PostgreSQL on 55437 and S3 on 59008), with a backend in development mode. It deploys a Node.js and a Python function in account A, and a Node.js one in account B: two tenant namespaces. Each function prints two lines a call, with its request ID in their text, so that a call's lines are found whether or not they were tagged.
- **For each collector:**
  1. fresh function pods, and a fresh VictoriaLogs (`victorialogs.yaml`);
  2. the collector (`vector.yaml` or `fluent-bit.yaml`), limited to the spike's namespaces;
  3. the measurements: the delay of 10 calls a runtime, their tags, CPU and memory idle and during a 20,000-line burst in A, the per-namespace limit, a 100,000-character line, deleting A's lines, retention at ingestion.
- **Cleanup:** on exit, the backend stops, and the compose project, the tenant namespaces, the spike's namespace and cluster roles, and the collectors' files on the node are all removed.

## The collectors' configuration
Both do the same:
- the containers named `function` in the given namespaces;
- the namespace, the pod, the function ID (pod label `ff.dev/function-id`) and the stream;
- the request ID: each line gets the call between its pod's `START RequestId:` and `REPORT RequestId:` lines;
- the per-namespace limit, counted per second of the lines' own time;
- lines cut past 16,384 characters.

Both do the tagging and the limit in Lua: Vector's `throttle` counts by the time of processing, which drops a backlog.

# Cache spike

The measurements behind [ADR 0013](../../../docs/adr/0013-caches.md) (step 4's caches): the [step-4 plan](../../../docs/step-4-plan.md)'s W-01, its last part. One script:

```bash
hack/spikes/cache/valkey.sh              # about a minute
CACHES=50 hack/spikes/cache/valkey.sh
```

It needs Docker, Node.js 22 or later, `jq`, OpenSSL and Python 3. Its work files go to `hack/.spike-cache/`, which git ignores.

- **Valkey 9.1.2** (`valkey/valkey:9.1.2-alpine3.24`), as the server of customers' caches would run it: a process for each cache, `CACHES` (20) of them in one container, each under a user of its own, its folder its alone; TLS only, from a CA of the spike's; the customer's password kept only as its SHA-256, in the cache's ACL file, with every command but those that would change the server, write to its disk or reach out; an agent's user of FF's own beside it, which may read the cache's measures and turn the customer off and on, never read its keys; the plan's memory, 64 MB, evicting the least recently used keys; nothing kept on disk.
- **Measured:** how long a process takes to answer over TLS once started, each and all together; what an idle cache costs in memory; one cache filled past its memory with 150,000 keys of 1 KB (`valkey-benchmark`, 20 clients), what it then holds and evicted, and what its process costs.
- **`checks.mjs`,** from outside as an app connects (`resp.mjs`, Valkey's protocol over TLS, Node.js's standard library only, the server's certificate checked against the CA): the cache's password; a Lua script, as ElastiCache runs them; nine commands refused (`CONFIG`, `ACL SETUSER`, `SAVE`, `REPLICAOF`, `MIGRATE`, `DEBUG`, `MODULE`, `SHUTDOWN`); a wrong password and another cache's; a plain connection without TLS; the agent turning the customer off, its connection ended and a new login refused, then on again, the data still there.

What was measured, and what it decided, is in ADR 0013.

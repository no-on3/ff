# ADR 0013: Caches, a Valkey process for each

| | |
|---|---|
| **Status** | Accepted: the [step-4 plan](../step-4-plan.md)'s D7, and its choices (its §9), confirmed on 2026-10-30; Valkey as the server of customers' caches would run it, measured by W-01's spike the same day |
| **Date** | 2026-10-30 |
| **Implementation** | Step-4 plan: decision D7; tasks W-04 and W-05. As built: W-04 and W-05 (below); W-09 documented it: the guide's "A cache", `how-it-works.html`'s scenario of it, the page in French, and the export kit's [`data/elasticache.md`](../../cli/templates/export/data/elasticache.md) |
| **Related** | [ADR 0008](0008-customer-databases.md) (customers' databases, on a server apart from the cluster); the [client-readiness plan](../client-readiness-plan.md)'s D5; the spike, [`hack/spikes/cache`](../../hack/spikes/cache/README.md) |

## Context

An app keeps sessions, rate counters and the results of slow calls in Redis: on AWS, an ElastiCache cluster of Valkey or Redis OSS, reached at an address with TLS and a password (`rediss://…`), its memory its node's, billed by the hour. Valkey is Redis's fork under the BSD licence, which AWS's ElastiCache runs, and speaks its protocol.

One Valkey server with a user per account would cost the least memory, but Valkey's users limit keys and commands, not memory: one account could fill the server for every other. A process per cache gives each its own `maxmemory`.

### A process for each cache, measured

`hack/spikes/cache/valkey.sh`: Valkey 9.1.2 (`valkey/valkey:9.1.2-alpine3.24`, jemalloc 5.3.0), 20 processes in one container, as a server of customers' caches would run them, each under a user of its own and its folder its alone; TLS only, from a CA of the spike's; the customer's password kept only as its SHA-256, in the cache's ACL file; 64 MB, evicting the least recently used keys; nothing kept on disk; an agent's user of FF's beside the customer's. On this machine (8 CPUs, shared), the second of two runs, the first's in brackets:

| Measure | |
|---|---|
| Started, all 20 at once through one `docker exec`, until each answers a login over TLS | first 2.19 s (2.16), median 2.31 s (2.26), last 2.43 s (2.36) |
| An idle cache's process | 10.7 to 15.9 MB (12.9), 239 MB for the 20 (219) |
| 150,000 writes of 1 KB, 20 clients (`valkey-benchmark`) | 49,800 a second (101,300), p50 0.27 ms (0.14) |
| One cache after them, past its 64 MB | 63.6 MB used; 100,681 keys evicted, 49,240 kept; its process 78.3 MB (74.8) |

24 checks, 24 as wanted, from outside as an app connects (Valkey's protocol over TLS, the server's certificate checked against the CA):
- the cache's password; `SET` and `GET`; a Lua script, as ElastiCache runs them; `ACL WHOAMI`;
- refused with `NOPERM`: `CONFIG GET`, `CONFIG SET dir`, `ACL SETUSER`, `SAVE`, `REPLICAOF`, `MIGRATE`, `SHUTDOWN`; and refused by the server's own switches (`enable-debug-command no`, `enable-module-command no`) before the ACL is read, with `ERR`: `DEBUG`, `MODULE LOAD`;
- refused: a wrong password, another cache's password, a connection without TLS;
- the agent's user turns the customer off (`ACL SETUSER default off`) and ends its connections (`CLIENT KILL USER default`); the app's connection is closed and a new login refused; on again, the data are there; the agent reads the cache's measures (`INFO`), never its keys.

## Decision

### 1. A Valkey process for each cache, on a server of customers' caches

Apart from the cluster, as customers' databases are (ADR 0008), so that a cache's memory never competes with functions'. Each cache is a process of its own, under a user of its own, its memory the plan's (`maxmemory`, `allkeys-lru`), no persistence (`save ""`, no AOF), TLS only, with a password FF keeps only as its SHA-256. A server holds as many caches as its memory takes each one's `maxmemory` and about 15 MB more, as measured.

### 2. What a customer may run, and FF's own user

The customer's user may run every command but those that would change the server, write to its disk or reach another server: `-config -debug -module -acl +acl|whoami -save -bgsave -bgrewriteaof -shutdown -replicaof -slaveof -sync -psync -migrate -failover -cluster`, with `DEBUG` and `MODULE` off in the server's settings as well. An agent's user of FF's, beside it, may read the cache's measures and turn the customer off and on (`+info +ping +client|kill +client|list +acl|setuser`), never read or write its keys: that is how FF suspends an account's caches.

### 3. Started by a small agent, reached at an address shown once

A small agent of FF's on the server starts and stops the processes, writes each one's settings and ACL file, and reports their measures; the backend tells it what each account's caches are. A cache's address, `rediss://default:<password>@<host>:<port>`, is shown once, and kept by nobody but the customer and, when asked, a function's secret, as `ff db create` does a database's; the account's functions reach it whatever their internet access, and developers' machines too, where ElastiCache's, inside a VPC, need a tunnel.

### As built (W-04): the server and the API

- **The server** (decisions 1 and 2): `deploy/cache/`, Valkey 9.1.2 and FF's agent (`agent.mjs`, Node.js's standard library alone), which keeps each cache's description on disk, writes its settings (TLS alone on its port, the plan's `maxmemory` with `allkeys-lru`, nothing on disk, `DEBUG` and `MODULE` off) and its ACL file (the customer's user, `default`, by its password's SHA-256; FF's own, `ff-agent`), starts its process under a user of its own and again when it stops, and answers the backend on port 6390, over HTTPS, to a token whose SHA-256 alone it has. docker-compose.yml's `cache` and `hack/k8s/cache-up.sh` in development.
- **The API** (decision 3): `/caches`, a name as ElastiCache names its clusters, the account's once; the first free port of the server's range (`FF_CACHE_PORTS`, 6400 to 6999); the plan's `caches` (1 on beta) and `cacheMb` (64). The address in the answer that makes the cache or gives it a new password, and never again; the connections under way keep theirs at a new password, as an ElastiCache AUTH token's rotation does. Functions reach the caches' ports whatever their account's internet access (one NetworkPolicy rule, a port range), and trust the server's CA with the database server's, in one file. A suspended or closed account's caches refuse its user and end its connections, their keys kept until reactivated; a closed account's are deleted at its data deletion date. Each change in the account's audit log.

### As built (W-05): the console, `ff`, the admin app, and the bill

- **The console's Caches page** and `ff caches create|list|get|password|delete`, `--secret-for` setting the address as a function's secret (`REDIS_URL` unless `--secret-name` says otherwise), as `ff db create` does; the admin app's account page lists the account's caches, never their address.
- **Measured every hour, billed as ElastiCache bills a node:** each minute, the backend measures each cache it hasn't measured yet in the hour through the agent (its memory, what its keys use, its connections, its hits, misses and evictions, when its process started), into `cache_samples` (the migration `CacheMeasures`, by month, append-only). Each hour sampled is rated (the kind `cache`): its memory for an hour, by the GB-hour at the book's `cacheGbHour`, ElastiCache for Valkey's `cache.t4g.micro` (0.0128 US$ an hour for 0.5 GiB, so 0.0256 a GB-hour) times the book's rate, with no free tier; an hour the server never answers in isn't billed.
- **Metrics and alarms:** `GET /caches/:name/metrics`, a point an hour: `BytesUsedForCache` and `CurrConnections` (Maximum, Average) from the hour's sample; `CacheHits`, `CacheMisses` and `Evictions` (Sum), from the next hour's sample less its own, all of the next one's when the process started again between them. Alarms on all five name the cache (`cacheName`).

## Consequences

- One more server to run, apart from the cluster: its memory sets how many caches it holds, each one's `maxmemory` and about 15 MB more; its agent is FF's code, in `deploy/cache/`.
- A cache's keys live in memory alone: a restarted process, or a moved server, starts empty, as a cache may (the plan's §9, 9). An app that needs its data kept writes it to a database.
- Customers reach their caches from their own machines too, at an address and port of FF's: the password, the TLS and the port's range are all that stand in front of a cache.
- What the build leaves for later, each said above: snapshots and replicas, as ElastiCache's; sizes past the plan's one; FF's own rate limits in Valkey, with the backend's second copy (the plan's §9, 11).

## Alternatives considered

- **One Valkey with a user per account:** cheaper, but Valkey's users limit keys and commands, not memory: one account could fill it for all (the plan's §9, 8).
- **Caches in the cluster, as pods:** their memory would compete with functions', and the cluster's quotas would have to keep room for them; a server apart is customers' databases' way (ADR 0008).
- **Snapshots,** as ElastiCache takes them: set aside, a cache being a cache (the plan's §9, 9).

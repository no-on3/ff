# ADR 0013: Caches, a Valkey process for each

| | |
|---|---|
| **Status** | Accepted: the [step-4 plan](../step-4-plan.md)'s D7, and its choices (its §9), confirmed on 2026-10-30; Valkey as the server of customers' caches would run it, measured by W-01's spike the same day |
| **Date** | 2026-10-30 |
| **Implementation** | Step-4 plan: decision D7; tasks W-04 and W-05 |
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

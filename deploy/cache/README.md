# The server of customers' caches

Customers' caches, Valkey as ElastiCache runs it, live on a server of their own, apart from the cluster ([ADR 0013](../../docs/adr/0013-caches.md)), as customers' databases do: a cache's memory never competes with functions', and the server can move to bigger hardware alone. Each cache is a Valkey process of its own, under a user of its own, within the plan's memory, keeping nothing on disk. This folder is the reference server.

## The image

`docker build -t ff-cache deploy/cache`:
- **Valkey 9.1.2** (`valkey/valkey:9.1.2-alpine3.24`), the version step 4's spike measured (ADR 0013).
- **FF's agent,** `agent.mjs`, Node.js's standard library alone: it keeps each cache's description in `/var/lib/ff-cache/caches/<name>/`, writes its settings and its ACL file, starts its process as the cache's own user (`su-exec`), starts it again when it stops, and answers the backend's API on port 6390, over HTTPS with the server's certificate, to a bearer token whose SHA-256 alone it has:
  - `GET /caches`, `GET /caches/<name>`: each cache's port, memory and switch, and its measures now (its memory used, connections, hits, misses, evictions), never its password's hash;
  - `PUT /caches/<name>` with `{"port", "memoryMb", "passwordSha256", "enabled"}`: made, or changed; a new port or memory starts its process again, its keys gone, as a node's change does; a new password, or the switch, applies at once, the switch ending the customer's connections;
  - `DELETE /caches/<name>`: its process stopped, its folder deleted;
  - `GET /health`.
- **Each cache's settings:** TLS alone on its port (`port 0`), its memory the plan's (`maxmemory`, `allkeys-lru`), no persistence (`save ""`, no AOF), `DEBUG` and `MODULE` off; the customer's user, `default`, by its password's SHA-256, may run every command but those that would change the server, write to its disk or reach another; FF's user, `ff-agent`, its password made at each start of the agent, reads the measures and turns the customer off and on, never a key.
- **`entrypoint.sh`:** the certificate checked, or made in development; the token's SHA-256.
- The agent runs as root, which starting each cache as its own user takes; the caches never do. The certificate's key is readable by the caches' group alone.

## Installing it

1. **A machine of its own,** in Tunisia as FF's others (the [decision log](../../docs/decisions.md), 21), its memory the caches' `maxmemory` together and about 15 MB more each (ADR 0013's measure), and a firewall: the caches' ports (6400 to 6999, `FF_CACHE_PORTS`) from the cluster's nodes and, for developers' laptops, the internet; the agent's, 6390, from the backend alone. Nothing else.
2. **Its name,** such as `cache.ffunc.cloud`, in DNS: caches' addresses name it, and its certificate does.
3. **Its certificate,** for that name, from a public CA (Let's Encrypt, by DNS or on port 80), in `/var/lib/ff-cache/tls/server.crt` and `server.key`: every client then connects with `rediss://` and checks it. Renew it before it expires, then restart the server: the caches read it when they start, and lose their keys, as caches may.
4. **The backend's token,** 32 random bytes, kept in FF's password manager: the server gets its SHA-256 alone, `FF_CACHE_AGENT_TOKEN_SHA256` (`printf %s "$token" | sha256sum`).
5. **Start it:** `docker run -d --name ff-cache --restart unless-stopped --network host -v /var/lib/ff-cache:/var/lib/ff-cache -e FF_CACHE_AGENT_TOKEN_SHA256=… ff-cache`.
6. **The backend's settings** (`deploy/k8s/platform/backend.env`, the token in the Secret): `FF_CACHE_HOST` (the server's name), `FF_CACHE_AGENT_URL` (`https://<name>:6390`, or another address the backend reaches it at), `FF_CACHE_AGENT_TOKEN`, `FF_CACHE_CIDRS` (the addresses the server's name resolves to from the cluster: functions' NetworkPolicy opens the caches' ports to them, whatever their account's internet access), and `FF_CACHE_CA_FILE` for a CA of the operator's. The backend checks them at its start.

## What the backend does there

- **A cache:** a port of the range no other cache has, the plan's memory, a password FF makes, shows once in the cache's address (`rediss://default:<password>@<name>:<port>`) and never keeps, the agent getting its SHA-256 alone.
- **A suspended account:** its caches' users are turned off and their connections ended; reactivated, on again, their keys still there.
- **A closed account,** at its data deletion date: each cache deleted.

## Development

`hack/k8s/cache-up.sh` starts docker-compose.yml's `cache` (its profile `cache`) at 10.199.0.11 on the data network, joins the cluster's node to it, copies the development CA out to `hack/.cache-server/ca.crt` and prints the backend's settings. Its token is `ff-cache-dev`, which production refuses.

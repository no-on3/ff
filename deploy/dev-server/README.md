# FF on its development server

FF's own install on its development server, the one in Canada ([decision log](../../docs/decisions.md), 21): FF as production runs it, from [`deploy/k8s`](../k8s/README.md), on one machine that other sites share. It is for development and tests, never for a customer's personal data.

## How it sits on the server

The server has its own rules ([`/data/proxy/README.md`](#its-files) on the server). One Caddy at `/data/proxy` owns ports 80 and 443 for every project. Each project has its directory, `/data/<project>`, owned by the user `deploy`, and one route file, `/data/proxy/sites/<project>.caddy`. FF follows them:
- **k3s** without its ingress (Traefik) or its load balancer (ServiceLB), and node ports on the loopback alone: nothing of the cluster's listens on the public address. Its data is on the data disk, `/data/kubernetes/k3s`; gVisor runs every function, as in production.
- **The edge** has a fixed address in the cluster, `10.43.0.252`, and the route file `ff.caddy` sends FF's hostnames there. The server's proxy terminates the internet's TLS; the edge does everything else as in production, and believes the caller's address only from that proxy (`FF_EDGE_TRUSTED_PROXIES`).
- **Beside the cluster,** in the Compose project `ff` (`/data/ff`): PostgreSQL for the backend and Keycloak, S3 (SeaweedFS), Mailpit, and the server of customers' databases ([`deploy/data-db`](../data-db/README.md)). Each listens on the Docker bridge's address (docker0's), which the cluster's pods reach and the internet doesn't.
- **The firewall:** pods may reach the node's API server (6443) and its kubelet (10250), nothing else of the node.

| | Production ([`deploy/k8s`](../k8s/README.md)) | This server |
|---|---|---|
| The internet's TLS | The edge's, from Let's Encrypt | The server's proxy's: Let's Encrypt's for the six fixed names, its own authority's for function URLs and buckets |
| The edge's certificates | Let's Encrypt | Its own authority (`local_certs`), which the proxy checks it against |
| Function URLs and buckets | A wildcard certificate each, by DNS | A wildcard each, from the proxy's own authority, whose root your browser must trust |
| Customers' own domains | Certificates on demand, at the edge | Not routed: the proxy sends FF's names alone |
| PostgreSQL and S3 | Servers of their own, backed up to a second site | Containers beside the cluster, no backup |
| Mail | A mail server | Mailpit: every e-mail kept on the server, none sent |
| Invoices | The seller's and the bank's details | Placeholders that say what they are |
| Nodes | Several | One |

## Installing and updating it

From a checkout, with the server in your SSH config (here `next`, whose address and login stay there):

```bash
deploy/dev-server/install.sh next      # the first time, about 20 minutes; an update, a few
```

The same command installs and updates. It copies the checkout's files to `/data/ff/src` (those git tracks and those it doesn't ignore: never a `.env`, a key or `node_modules`), then runs [`server.sh`](server.sh) there as root. Each step of it does nothing when already done:
1. FF's passwords and keys, made once in `/data/ff/secrets`.
2. The Compose project, and the backend's and Keycloak's databases.
3. k3s and gVisor, at the versions the development cluster runs (`hack/k8s/env.sh`, `hack/k8s/gvisor-up.sh`), each checked against its release's checksum; the firewall's two rules; customers' databases' name in the cluster's DNS.
4. The images, built on the server and given to k3s, tagged with the commit (with `-dirty-<time>` when the checkout has changes).
5. `deploy/k8s`: base, the Secrets, logging, monitoring, gVisor's RuntimeClass; then the platform with `deploy/k8s/platform/deploy.sh` and this folder's overlay (`k8s/`), with what is the server's own added on the server (`/data/ff/overlay`).
6. The first operator, `operator`, once.
7. The route file, installed and the proxy reloaded. The proxy checks a configuration as it loads it; a route it refuses is put back as it was, so that no other project's next reload meets it.
8. Every hostname, through the proxy, as from the internet, once Let's Encrypt has given the six fixed names their certificates (a minute or so the first time).

Then [`smoke.sh`](smoke.sh) takes a customer's path through the proxy: an operator and a customer of its own, each signed in as a browser signs in; an account asked for, the operator told by e-mail, the account approved; a function in gVisor, invoked and called at its URL; a bucket at its own host; a queue sent to and read. Then it deletes all of it, closes the account and removes both users, whether its checks passed or not. `--no-smoke` skips it.

The admin app and Keycloak's administration answer only the address the server sees you connect from; `FF_ADMIN_ALLOW='<address>/32 …' deploy/dev-server/install.sh next` gives others.

## Reaching it

FF's names are under `dev.ffunc.cloud`, in OVH's DNS: `api`, `console`, `admin`, `login`, `s3` and `sqs`, and the wildcards `*.fn` and `*.s3`, each an A record to the server's address. None has an AAAA record: the proxy gets IPv6 callers through Docker's relay, which hides their address, and the admin app answers by address. The domain is `k8s/edge.env`'s, from which `server.sh` and `smoke.sh` take it.

1. **The proxy's root,** for function URLs and buckets, which your browser and your system must trust: `ssh next 'sudo docker compose --project-directory /data/proxy exec -T caddy cat /data/caddy/pki/authorities/local/root.crt' > ff-dev-root.crt`. It is the one that already signs the other projects' certificates for the server's address. The six fixed names need nothing: their certificates are Let's Encrypt's.
2. **The console,** `https://console.dev.ffunc.cloud`: sign up, confirm the address from the e-mail in Mailpit, and ask for an account.
3. **The admin app,** `https://admin.dev.ffunc.cloud`, as `operator`: its password is `ssh next sudo cat /data/ff/secrets/operator-password`, and it sets up its one-time password at its first login. Approve the account there.
4. **Mail:** `ssh -L 8026:127.0.0.1:8026 next`, then `http://localhost:8026`.
5. **The `ff` command:** `FF_ENDPOINT=https://api.dev.ffunc.cloud`, with an API key made in the console (the [getting-started guide](../../docs/getting-started.md)). The API's certificate is Let's Encrypt's; calling a function at its URL takes the proxy's root among your system's.

## Function URLs' and buckets' certificates

They come from the proxy's own authority: one certificate for `*.fn.dev.ffunc.cloud`, one for `*.s3.dev.ffunc.cloud`. Let's Encrypt's would need more of the proxy, which every project shares: either a DNS module in its Caddy, for DNS-01, with an OVH key that can change every record of `ffunc.cloud`, kept on this server; or certificates on demand, one per host, asking FF's backend which hosts are FF's, which takes a line in the proxy's main file (`on_demand_tls`). That choice is yours (the [decision log](../../docs/decisions.md)'s questions).

## Its files

| File | What |
|---|---|
| `install.sh` | From a checkout: the copy, `server.sh`, `smoke.sh` |
| `server.sh` | On the server, as root: everything above, step by step |
| `smoke.sh` | On the server, as root: a customer's path through the proxy, then nothing of it left |
| `docker-compose.yml` | What runs beside the cluster, installed as `/data/ff/docker-compose.yml`; `server.sh` writes its `.env` |
| `k8s/` | The overlay of `deploy/k8s/platform` with FF's names under `dev.ffunc.cloud`, the edge's Service at its fixed address, the services beside the cluster, and the CA of customers' databases mounted for the backend |
| `ff.caddy` | The route, which `server.sh` fills in with the edge's root and installs as `/data/proxy/sites/ff.caddy` |
| `alertmanager.yaml` | The operator's alerts, to Mailpit |

On the server: `/data/ff/secrets` (the passwords and keys, readable by root and `deploy` alone), `/data/ff/overlay` (made on each run), `/data/kubernetes/k3s` (the cluster), `/etc/rancher/k3s` (its settings, and the nodes' login to the code registry), and the Docker volumes `ff_postgres`, `ff_s3`, `ff_mail` and `ff_data_db`. The server's own rules are in `/data/proxy/README.md` there.

## Removing it

```bash
ssh next 'sudo rm /data/proxy/sites/ff.caddy && sudo docker compose --project-directory /data/proxy exec -T caddy caddy reload --config /etc/caddy/Caddyfile'
ssh next 'sudo /usr/local/bin/k3s-uninstall.sh'      # the cluster, its data and its network rules
ssh next 'sudo docker compose --project-directory /data/ff down --volumes && sudo rm -rf /data/ff /data/kubernetes/k3s'
ssh next 'sudo ufw delete allow proto tcp from 10.42.0.0/16 to any port 6443 && sudo ufw delete allow proto tcp from 10.42.0.0/16 to any port 10250'
```

## What it doesn't do yet

- **A function with internet access reaches the node's public address,** as in production: tenants' NetworkPolicy blocks private addresses only. Here the firewall then lets it reach the API server and the kubelet, which ask for credentials it doesn't have. Production's nodes need the same narrow rules, or the node's addresses among those blocked.
- **Anything on the server itself can reach the edge and name any caller:** the allowlist of the admin app keeps the internet out, not the server's other projects. The operator's password and one-time password still stand.
- **No backup:** the data here are tests.

#!/usr/bin/env bash
# Step 4's cache spike (the step-4 plan's W-01): Valkey 9.1.2 as the server of customers' caches would run it, a
# process for each cache, each under a user of its own, CACHES of them in one container: TLS only, from a CA of the
# spike's; the cache's own password, kept only as its SHA-256 in an ACL file; the plan's memory (maxmemory, evicting
# the least recently used keys) and nothing kept on disk; an agent's user of FF's own beside the customer's. Measures
# how long a process takes to answer and what it costs in memory, idle and full; fills one past its memory; then
# checks.mjs's checks from outside. The container goes on exit.
#   hack/spikes/cache/valkey.sh               # about a minute
#   CACHES=50 hack/spikes/cache/valkey.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../../k8s/env.sh"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$FF_REPO_ROOT/hack/.spike-cache"
"$FF_REPO_ROOT/hack/check-resources.sh"
image=valkey/valkey:9.1.2-alpine3.24
# A run stopped before its end leaves the caches' folders to their users inside the container: removed from one.
rm -rf "$work" 2>/dev/null || docker run --rm -v "$work:/work" "$image" rm -rf /work/certs /work/caches
rm -rf "$work" && mkdir -p "$work/certs" "$work/caches"
caches="${CACHES:-20}"

# A CA of the spike's, and the server's certificate for its name and 127.0.0.1, as the development one would be.
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=FF spike cache CA' -keyout "$work/certs/ca.key" -out "$work/certs/ca.crt" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj '/CN=cache.spike.test' -keyout "$work/certs/server.key" -out "$work/certs/server.csr" 2>/dev/null
openssl x509 -req -in "$work/certs/server.csr" -CA "$work/certs/ca.crt" -CAkey "$work/certs/ca.key" -CAcreateserial -days 2 \
  -extfile <(printf 'subjectAltName=DNS:cache.spike.test,IP:127.0.0.1') -out "$work/certs/server.crt" 2>/dev/null
chmod 644 "$work/certs/"*

# The caches' ports inside the container, one a cache; Docker publishes each on a free port of this machine's.
base=6380
sha256() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
agent_password="$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"
passwords=()
for i in $(seq 0 $((caches - 1))); do
  password="$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"
  passwords+=("$password")
  port=$((base + i))
  mkdir -p "$work/caches/$i"
  # The customer's user: every command, but those that would change the server, write to its disk or reach out.
  cat >"$work/caches/$i/users.acl" <<ACL
user default on #$(sha256 "$password") ~* &* +@all -config -debug -module -acl +acl|whoami -save -bgsave -bgrewriteaof -shutdown -replicaof -slaveof -sync -psync -migrate -failover -cluster
user ff-agent on #$(sha256 "$agent_password") resetkeys -@all +info +ping +client|kill +client|list +acl|setuser
ACL
  cat >"$work/caches/$i/valkey.conf" <<CONF
port 0
tls-port $port
bind 0.0.0.0
tls-cert-file /certs/server.crt
tls-key-file /certs/server.key
tls-ca-cert-file /certs/ca.crt
tls-auth-clients no
aclfile /caches/$i/users.acl
maxmemory 64mb
maxmemory-policy allkeys-lru
save ""
appendonly no
dir /caches/$i
enable-debug-command no
enable-module-command no
enable-protected-configs no
logfile /caches/$i/valkey.log
CONF
done

container="ff-spike-cache-$$"
# On exit, the caches' folders back to this machine's user, then the container gone.
trap 'docker exec "$container" chown -R "$(id -u):$(id -g)" /caches >/dev/null 2>&1 || true; docker rm -f -v "$container" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$container" --entrypoint sleep -p "127.0.0.1::$base-$((base + caches - 1))" \
  -v "$work/certs:/certs:ro" -v "$work/caches:/caches" "$image" infinity >/dev/null
# Each cache as an app reaches it from this machine: the port Docker published it on, and its password.
list="$(for i in $(seq 0 $((caches - 1))); do
  printf '{"port": %s, "password": "%s"}\n' "$(docker port "$container" "$((base + i))/tcp" | head -1 | sed 's/.*://')" "${passwords[$i]}"
done | jq -cs .)"
echo "{\"valkey\": \"$(docker exec "$container" valkey-server --version | head -c 60)\"}"
# Each cache's own user, its folder its alone; the key readable by their group only.
docker exec "$container" sh -c "addgroup -S caches && for i in \$(seq 0 $((caches - 1))); do adduser -S -D -H -u \$((20000 + i)) -G caches c\$i && chown -R c\$i /caches/\$i && chmod 700 /caches/\$i; done"
# su-exec starts each process as its cache's user; Valkey's image has setpriv alone.
docker exec "$container" sh -c 'command -v su-exec' >/dev/null || docker exec "$container" apk add --no-cache su-exec >/dev/null
started="$(date +%s%3N)"
docker exec "$container" sh -c "for i in \$(seq 0 $((caches - 1))); do su-exec c\$i valkey-server /caches/\$i/valkey.conf & done"
HOST=127.0.0.1 CA="$work/certs/ca.crt" STARTED="$started" CACHES="$list" node "$here/ready.mjs"

rss() { docker exec "$container" sh -c 'for p in $(pgrep valkey-server); do awk "/^VmRSS/ { print \$2 }" /proc/$p/status; done' | sort -n; }
idle="$(rss)"
echo "{\"measure\": \"memory of idle caches\", \"caches\": $caches, \"eachMbMin\": $(head -1 <<<"$idle" | awk '{ printf "%.1f", $1 / 1024 }'), \"eachMbMax\": $(tail -1 <<<"$idle" | awk '{ printf "%.1f", $1 / 1024 }'), \"allMb\": $(awk '{ s += $1 } END { printf "%.0f", s / 1024 }' <<<"$idle")}"

# One cache filled past its memory: 150,000 keys of 1 KB into 64 MB.
first_password="${passwords[0]}"
docker exec "$container" valkey-benchmark --tls --cacert /certs/ca.crt -h 127.0.0.1 -p "$base" --user default -a "$first_password" \
  -t set -n 150000 -d 1024 -r 100000000 -c 20 -q 2>/dev/null | tr '\r' '\n' | grep -E '^SET' | tail -1 | sed 's/^/{"measure": "writes, 20 clients", "result": "/; s/$/"}/'
info() { docker exec "$container" valkey-cli --tls --cacert /certs/ca.crt -p "$base" --user ff-agent --pass "$agent_password" --no-auth-warning INFO "$1" | tr -d '\r'; }
memory="$(info memory)" stats="$(info stats)" keyspace="$(info keyspace)"
pid="$(info server | grep '^process_id:' | cut -d: -f2)"
full_rss="$(docker exec "$container" awk '/^VmRSS/ { print $2 }' "/proc/$pid/status")"
echo "{\"measure\": \"one cache filled past its memory\", \"usedMemoryMb\": $(grep '^used_memory:' <<<"$memory" | cut -d: -f2 | awk '{ printf "%.1f", $1 / 1048576 }'), \"maxmemoryMb\": $(grep '^maxmemory:' <<<"$memory" | cut -d: -f2 | awk '{ printf "%.0f", $1 / 1048576 }'), \"evictedKeys\": $(grep '^evicted_keys:' <<<"$stats" | cut -d: -f2), \"keys\": \"$(grep '^db0:' <<<"$keyspace" | cut -d: -f2 | cut -d, -f1)\", \"processRssMb\": $(awk '{ printf "%.1f", $1 / 1024 }' <<<"$full_rss")}"
plain="refused"
(exec 3<>"/dev/tcp/127.0.0.1/$(jq -r '.[0].port' <<<"$list")" && printf 'PING\r\n' >&3 && timeout 2 head -c 5 <&3 | grep PONG >/dev/null) 2>/dev/null && plain="answered"
echo "{\"check\": \"a connection without TLS\", \"want\": \"refused\", \"got\": \"$plain\"}"

HOST=127.0.0.1 CA="$work/certs/ca.crt" CACHES="$list" AGENT_PASSWORD="$agent_password" node "$here/checks.mjs" | tee "$work/results.jsonl"
docker exec "$container" grep -h -E 'WARNING|Warning' /caches/0/valkey.log | head -5 || true
jq -rs '"checks: \(map(select(.want == .got)) | length) of \(length) as wanted\(map(select(.want != .got) | "\n  not as wanted: \(.check) (want \(.want), got \(.got))") | join(""))"' "$work/results.jsonl"

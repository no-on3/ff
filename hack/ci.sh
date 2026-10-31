#!/usr/bin/env bash
# FF's pipeline, one stage per job, the same here as on the CI server (.github/workflows/ci.yml calls it):
#   deps      what the stages after it use: npm ci in the backend, the console, the admin app and the Node.js
#             runtime, and the ff command's Rust (hack/install-tools.sh), each for the stages that need it; alone,
#             all of them (CI only: locally, the installed dependencies are used as they are)
#   static    linters and type checks, the builds, the ff command's formatting and lints, the docs' links and
#             tables, npm audit's checker, the nightly run's issue, the docs-only rule and the suites' checks against
#             stand-ins, how-it-works.html's script, every shell script parsed, the CI workflow linted, and secrets
#             in the history (gitleaks): what a push that changes only documents runs
#   unit      the unit tests: the backend's (L1), the console's, the admin app's, both runtimes', the cache
#             and mail servers' agents', the small app's handlers, the ff command's and its binary's (L1, L2),
#             the alert rules' and the log collector's filter (these two in their own images)
#   db        the backend's database tests (L2) and the migrations' drift check, on a PostgreSQL of its own,
#             with servers of customers' databases and caches, and a store for buckets
#   security  the dependencies' advisories (npm audit, but those .npmauditignore accepts until a date), and every
#             image built, scanned (Trivy, but what .trivyignore.yaml accepts) and listed as an SBOM (CycloneDX),
#             into hack/.ci/sbom
#   cluster   l3, l4, l5, cli and images below, one after the other, as a laptop runs them; GitHub runs l3 to cli
#             each on a runner of its own, at once, and images after security, in its job, on the images it built.
#             Each makes or reuses the k3d dev cluster (hack/k8s/cluster-up.sh):
#     l3      the Kubernetes driver (L3)
#     l4      the stack through the API (L4)
#     l5      every route as another account (L5)
#     cli     the ff command on the stack and in Docker
#     images  the platform's images, run as the cluster runs them, and its manifests, without deploying them
#   advisories  the last security run's SBOMs (hack/.ci/sbom; on GitHub, the branch's last push's) and the lockfiles,
#             checked again with the day's advisories, for an image or a package unchanged since its push: nightly
#   tools     the latest release of each tool the tests pin (the AWS CLI, the SDK for JavaScript, boto3, OpenTofu,
#             Terraform and its AWS provider, the SAM CLI, Rust's stable toolchain), tried as the pinned ones run,
#             and what changed said: nightly
#   platform  FF deployed from deploy/k8s on a cluster of its own (hack/e2e-platform.sh), about 15 minutes
#   all       static, unit, db, security and cluster, one after the other
# A failed step is reported and the next one runs, so that a run names every failed step, not only the first; a step
# that the steps after it need (npm ci, the dev cluster) stops the run when it fails; FF_FAIL_FAST=1 stops at the
# first failure. A suite in a step reports each of its failed checks, not only the first. hack/.ci/report.md lists
# each step with its result and its seconds, and every failed check, and GitHub shows it as the job's summary.
# Heavy steps run one at a time. FF_CI_JOBS=<n> caps the test runners' and Rust's parallelism at n, for a machine
# others share; unset, each tool takes its own default.
#   hack/ci.sh <stage> [<stage> ...]
#   FF_CI_JOBS=2 hack/ci.sh unit
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

# Pinned to releases at least two weeks old when chosen.
TRIVY_IMAGE=aquasec/trivy:0.75.0
GITLEAKS_IMAGE=zricethezav/gitleaks:v8.30.1
POSTGRES_IMAGE=postgres:15.19-alpine3.24
SEAWEEDFS_IMAGE=chrislusf/seaweedfs:4.48
ACTIONLINT_IMAGE=rhysd/actionlint:1.7.12
ci_dir="$repo/hack/.ci"
mkdir -p "$ci_dir"
# What failed suites leave behind (hack/lib/evidence.sh): this run's alone.
rm -rf "$ci_dir/failure"
# Each step run, timed and reported, and the run's report written at exit.
source "$repo/hack/lib/ci-steps.sh"
# The console's and the admin app's Vitest, then cargo's builds and test threads, at most FF_CI_JOBS at once.
vitest_jobs=()
if [ -n "${FF_CI_JOBS:-}" ]; then
  vitest_jobs=(-- "--maxWorkers=$FF_CI_JOBS")
  export CARGO_BUILD_JOBS="$FF_CI_JOBS" RUST_TEST_THREADS="$FF_CI_JOBS"
fi
# The ff command's Rust, where hack/install-tools.sh put it because the machine had none recent enough.
if [ -x "$repo/hack/.rust/cargo/bin/cargo" ]; then
  export PATH="$repo/hack/.rust/cargo/bin:$PATH" RUSTUP_HOME="$repo/hack/.rust/rustup" CARGO_HOME="$repo/hack/.rust/cargo"
fi

in_dir() { (cd "$1" && shift && "$@"); } # <directory> <command...>
# The first of <n> ports in a row that nothing on this machine answers on.
free_ports() {
  local n=$1 first port
  for _ in $(seq 1 50); do
    first=$((40000 + RANDOM % 20000))
    for port in $(seq "$first" $((first + n - 1))); do
      (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null && continue 2
    done
    echo "$first"
    return
  done
  echo "no $n free ports in a row on this machine" >&2
  return 1
}

# What each stage uses that deps installs: the directories npm ci runs in, and the ff command's Rust. A stage that runs
# the backend here needs its packages; the images build in Docker with their own, and npm audit reads the lockfiles.
declare -A stage_uses=(
  [static]="BE FE admin runtimes/nodejs rust" [unit]="BE FE admin runtimes/nodejs rust" [db]=BE [security]=''
  [l3]=BE [l4]=BE [l5]=BE [cli]="BE rust" [images]=BE [platform]='' [advisories]='' [tools]=''
)
stage_uses[cluster]="${stage_uses[l3]} ${stage_uses[l4]} ${stage_uses[l5]} ${stage_uses[cli]} ${stage_uses[images]}"
stage_uses[all]="${stage_uses[static]} ${stage_uses[unit]} ${stage_uses[db]} ${stage_uses[security]} ${stage_uses[cluster]}"

stage_deps() {
  local stage uses=' ' dir
  for stage in $ci_stages; do uses+="${stage_uses[$stage]:-} "; done
  [ "$ci_stages" != deps ] || uses=" ${stage_uses[all]} "
  for dir in BE FE admin runtimes/nodejs; do
    case "$uses" in *" $dir "*) prepare "npm ci in $dir" in_dir "$dir" npm ci --no-audit --no-fund ;; esac
  done
  case "$uses" in *" rust "*) prepare "Rust for the ff command" hack/install-tools.sh rust ;; esac
}

# The page's one script, which a syntax error stops entirely (and with it every scenario).
how_it_works_parses() {
  python3 - "$repo/docs/how-it-works.html" "$ci_dir/how-it-works.js" <<'PY'
import re, sys
scripts = re.findall(r'<script(?: [^>]*)?>(.*?)</script>', open(sys.argv[1]).read(), re.S)
open(sys.argv[2], 'w').write('\n'.join(scripts))
PY
  [ $? -eq 0 ] && node --check "$ci_dir/how-it-works.js"
}

# The scanners run as this user: what they write here stays this user's.
as_me=(--user "$(id -u):$(id -g)")

# Every commit HEAD holds, with gitleaks' own rules; .gitleaksignore lists the findings that aren't secrets. HEAD's
# history alone, what a push sends: by default gitleaks reads every ref, a laptop's own branches too.
gitleaks_history() {
  docker run --rm "${as_me[@]}" -v "$repo:/repo:ro" "$GITLEAKS_IMAGE" git /repo --log-opts='--full-history --diff-filter=tuxdb HEAD' \
    --gitleaks-ignore-path /repo/.gitleaksignore --redact --no-banner --log-level warn
}

workflow_lints() { # the CI server's workflow, its run: steps shellchecked
  docker run --rm --user "$(id -u):$(id -g)" -v "$repo:/repo:ro" -w /repo "$ACTIONLINT_IMAGE" -color=false
}

# Under pipefail, grep -q's exit at its first match fails a writer that is still writing, and a match reads as none:
# the images' test found its metrics on 2 nights of 4 that way. grep without -q reads everything; a file is safe.
no_pipe_into_grep_q() { ! git grep -nE '\| *grep -[a-zA-Z]*q' -- '*.sh'; }
# A fresh PostgreSQL's image runs a server on its socket alone while it initializes, then restarts it: a readiness check
# on the socket can pass between the two and a client connect in the gap, as the ff suite's database did on 2026-10-31.
# Over TCP, only the server that stays answers.
postgres_waited_over_tcp() { ! git grep -nE '^[^#]*pg_isready' -- '*.sh' '*.yml' '*.yaml' | grep -v -- '-h 127.0.0.1'; }

shell_scripts_parse() {
  local file
  while IFS= read -r file; do bash -n "$file" || { echo "  $file" >&2; return 1; }; done < <(git ls-files '*.sh')
}

stage_static() {
  step "backend: linter" in_dir BE npm run lint
  step "backend: types, tests included" in_dir BE npx tsc --noEmit -p tsconfig.json
  step "backend: build" in_dir BE npm run build
  step "console: linter" in_dir FE npm run lint
  step "console: types and build" in_dir FE npm run build
  step "admin app: linter" in_dir admin npm run lint
  step "admin app: types and build" in_dir admin npm run build
  step "Node.js runtime: build" in_dir runtimes/nodejs npm run build
  step "ff: formatting" in_dir cli cargo fmt --check
  step "ff: lints, its tests included, and its build (clippy)" in_dir cli cargo clippy --all-targets --locked -- -D warnings
  step "docs: the checker itself, on documents with one problem each" hack/test-check-docs.sh
  step "npm audit's checker, on reports of each kind" hack/test-npm-audit.sh
  step "the nightly run's issue, against a stand-in gh" hack/test-nightly-issue.sh
  step "the suites' checks, on suites of their own" hack/test-checks.sh
  step "the pipeline's steps, on runs of their own" hack/test-ci-steps.sh
  step "a push of documents alone, told from one with code" hack/test-changes.sh
  step "the nightly's SBOMs, the branch's last, against a stand-in gh" hack/test-last-sboms.sh
  step "the nightly's latest tools, compared with the pinned ones, on recordings of its own" hack/test-tools-compare.sh
  step "the resource guard, its limits and the load's off" hack/test-check-resources.sh
  # shellcheck disable=SC2046 # one argument per file
  step "docs: fences, tables and relative links" python3 hack/check-docs.py $(git ls-files '*.md')
  step "how-it-works.html: its script parses" how_it_works_parses
  step "shell scripts parse" shell_scripts_parse
  step "shell scripts: no pipe into grep -q, which pipefail turns into a race" no_pipe_into_grep_q
  step "shell scripts and compose files: a fresh PostgreSQL waited for over TCP, not its socket" postgres_waited_over_tcp
  step "the CI workflow (actionlint)" workflow_lints
  step "no secret in any commit (gitleaks)" gitleaks_history
}

stage_unit() {
  "$repo/hack/check-resources.sh"
  step "backend: L1" in_dir BE npx jest --maxWorkers=2
  step "console: unit tests" in_dir FE npm test "${vitest_jobs[@]}"
  step "admin app: unit tests" in_dir admin npm test "${vitest_jobs[@]}"
  step "Node.js runtime: protocol tests" in_dir runtimes/nodejs npm test
  step "Python runtime: protocol tests" in_dir runtimes/python python3 -m unittest discover -s tests
  step "the cache server's agent: unit tests" node --test deploy/cache/agent.test.mjs
  step "the mail server's agent: unit tests" node --test deploy/mail/agent.test.mjs
  step "the small app: its handlers, their clients stubbed" node --test examples/orders-app/test/handlers.test.js
  step "ff: unit tests, and its binary's against a scripted API (L1, L2)" in_dir cli cargo test --locked
  step "alert rules and dashboards" hack/k8s/test-monitoring-rules.sh
  step "log collector: configuration and filter" hack/k8s/test-logging-filter.sh
}

stage_db() {
  "$repo/hack/check-resources.sh"
  local name="ff-ci-postgres-$$" data="ff-ci-data-db-$$" s3="ff-ci-s3-$$" cache="ff-ci-cache-$$" password port admin data_port s3_key s3_port \
    cache_port first caches
  password="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
  admin="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
  s3_key="ci$(head -c 9 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  ci_cleanups+=("docker rm -f -v $name $data $s3 $cache >/dev/null 2>&1 || true")
  docker run -d --name "$name" -e POSTGRES_PASSWORD="$password" -p 127.0.0.1::5432 "$POSTGRES_IMAGE" >/dev/null
  port="$(docker port "$name" 5432/tcp | head -1 | sed 's/.*://')"
  # Customers' database server (ADR 0008), its certificate from a CA of its own, for the suites that make databases.
  docker build -q -t ff-data-db:ci "$repo/deploy/data-db" >/dev/null
  docker run -d --name "$data" -e POSTGRES_PASSWORD="$password" -e FF_DATA_DB_ADMIN_PASSWORD="$admin" \
    -e FF_DATA_DB_TLS_NAMES=DNS:localhost,IP:127.0.0.1 -p 127.0.0.1::5432 ff-data-db:ci >/dev/null
  data_port="$(docker port "$data" 5432/tcp | head -1 | sed 's/.*://')"
  # Customers' cache server (ADR 0013), its certificate from a CA of its own: its agent on a port of this machine's,
  # its caches on ten more, the same here as in the container, as the caches' addresses name them.
  docker build -q -t ff-cache:ci "$repo/deploy/cache" >/dev/null
  first="$(free_ports 10)"
  caches="$first-$((first + 9))"
  docker run -d --name "$cache" -e FF_CACHE_AGENT_TOKEN="$admin" -e FF_CACHE_PORTS="$caches" -e FF_CACHE_TLS_NAMES=DNS:localhost,IP:127.0.0.1 \
    -p 127.0.0.1::6390 -p "127.0.0.1:$caches:$caches" ff-cache:ci >/dev/null
  cache_port="$(docker port "$cache" 6390/tcp | head -1 | sed 's/.*://')"
  # The store behind buckets' S3 front door, as development's, with keys of its own, for the suites that send it requests.
  mkdir -p "$ci_dir"
  printf '{"identities": [{"name": "ci", "credentials": [{"accessKey": "%s", "secretKey": "%s"}], "actions": ["Admin", "Read", "List", "Tagging", "Write"]}]}\n' \
    "$s3_key" "$password" >"$ci_dir/s3.json"
  chmod 644 "$ci_dir/s3.json"
  docker run -d --name "$s3" -p 127.0.0.1::8333 -v "$ci_dir/s3.json:/etc/seaweedfs/s3.json:ro" "$SEAWEEDFS_IMAGE" \
    server -dir=/data -s3 -s3.port=8333 -s3.config=/etc/seaweedfs/s3.json -master.volumeSizeLimitMB=64 >/dev/null
  s3_port="$(docker port "$s3" 8333/tcp | head -1 | sed 's/.*://')"
  for _ in $(seq 1 60); do docker exec "$name" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break; sleep 1; done
  for _ in $(seq 1 60); do docker exec "$data" pg_isready -q -h 127.0.0.1 >/dev/null 2>&1 && break; sleep 1; done
  # SeaweedFS answers S3 once its volume server has joined: an anonymous request is refused then, with a status.
  for _ in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$s3_port/")" != 000 ] && break; sleep 1; done
  docker cp -q "$data:/var/lib/postgresql/tls/ca.crt" "$ci_dir/data-db-ca.crt"
  for _ in $(seq 1 60); do curl -sfk -o /dev/null -H "authorization: Bearer $admin" "https://127.0.0.1:$cache_port/health" && break; sleep 1; done
  docker cp -q "$cache:/var/lib/ff-cache/tls/ca.crt" "$ci_dir/cache-ca.crt"
  # The variables win over BE/.env, which dotenv never overrides.
  export DB_HOST=127.0.0.1 DB_PORT="$port" DB_USERNAME=postgres DB_PASSWORD="$password" DB_NAME=postgres DB_SSL=false
  export FF_DATA_DB_HOST=127.0.0.1 FF_DATA_DB_PORT="$data_port" FF_DATA_DB_ADMIN_PASSWORD="$admin" FF_DATA_DB_CA_FILE="$ci_dir/data-db-ca.crt"
  export FF_CACHE_HOST=127.0.0.1 FF_CACHE_PORTS="$caches" FF_CACHE_AGENT_URL="https://127.0.0.1:$cache_port" FF_CACHE_AGENT_TOKEN="$admin" \
    FF_CACHE_CA_FILE="$ci_dir/cache-ca.crt"
  export FF_OBJECT_STORE_ENDPOINT=127.0.0.1 FF_OBJECT_STORE_PORT="$s3_port" FF_OBJECT_STORE_USE_SSL=false FF_OBJECT_STORE_ACCESS_KEY="$s3_key" FF_OBJECT_STORE_SECRET_KEY="$password"
  step "backend: L2 on PostgreSQL ${POSTGRES_IMAGE#postgres:}, customers' databases on 18, buckets on SeaweedFS ${SEAWEEDFS_IMAGE#*:}" in_dir BE npm run test:db
  step "migrations: exactly the entities' schema" in_dir BE npm run migration:check
  docker rm -f -v "$name" "$data" "$s3" "$cache" >/dev/null
}

# Every image FF builds: the platform's, the runtimes', the edge's, the backup's, and customers' database, cache and
# mail servers', each with its build arguments. The apps bake their addresses in: any will do for a scan.
apps=(--build-arg VITE_API_URL=https://api.ff.test --build-arg VITE_OIDC_AUTHORITY=https://login.ff.test/realms/ff)
IMAGES=(
  "ff-backend:ci BE"
  "ff-console:ci FE ${apps[*]}"
  "ff-admin:ci admin ${apps[*]}"
  "ff-edge:ci deploy/edge"
  "ff-runtime-nodejs:ci runtimes/nodejs"
  "ff-runtime-python:ci runtimes/python"
  "ff-postgres-walg:ci deploy/backup/postgres-walg"
  "ff-data-db:ci deploy/data-db"
  "ff-cache:ci deploy/cache"
  "ff-mail:ci deploy/mail"
)

npm_audit() { # <directory>: what ships, high and critical advisories, but those .npmauditignore accepts until a date
  local report
  # npm audit exits 1 whenever it reports anything: the checker decides, and fails on a report that isn't one.
  report="$(in_dir "$1" npm audit --omit=dev --json)" || true
  python3 "$repo/hack/lib/npm-audit.py" "$1" "$repo/.npmauditignore" <<<"$report"
}

scan_image() { # <image> <directory> [build arguments]: built, saved, scanned and listed, the scanner never given the Docker socket
  local image="$1" dir="$2" tar status=0
  shift 2
  docker build -q "$@" -t "$image" "$dir" >/dev/null || return 1
  tar="$ci_dir/${image%%:*}.tar"
  docker save -o "$tar" "$image" || return 1
  local trivy=(docker run --rm "${as_me[@]}" -v "$ci_dir:/ci" "$TRIVY_IMAGE")
  "${trivy[@]}" image --cache-dir /ci/trivy-cache --quiet --input "/ci/$(basename "$tar")" --format cyclonedx --output "/ci/sbom/${image%%:*}.cdx.json" ||
    status=1
  # Fixed advisories only: one without a fix can't be acted on here; the SBOM lets it be found later.
  "${trivy[@]}" image --cache-dir /ci/trivy-cache --quiet --input "/ci/$(basename "$tar")" --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 \
    --ignorefile /ci/trivyignore.yaml || status=1
  rm -f "$tar"
  docker rmi "$image" >/dev/null # the SBOM keeps what it held
  return $status
}

stage_security() {
  "$repo/hack/check-resources.sh"
  mkdir -p "$ci_dir/sbom" "$ci_dir/trivy-cache"
  cp "$repo/.trivyignore.yaml" "$ci_dir/trivyignore.yaml"
  for dir in BE FE admin runtimes/nodejs; do
    step "$dir: no high or critical advisory in what ships, but those accepted until a date (npm audit)" npm_audit "$dir"
  done
  local entry
  for entry in "${IMAGES[@]}"; do
    # shellcheck disable=SC2086 # image, directory and build arguments, none with a space
    step "${entry%% *}: built, no fixed high or critical vulnerability (Trivy), SBOM written" scan_image $entry
  done
  echo "SBOMs: $(cd "$ci_dir/sbom" && ls | paste -sd' ')"
}

scan_sbom() { # <image>: its SBOM, which the security stage wrote, scanned again with the day's advisories as the image was
  local sbom="${1%%:*}.cdx.json"
  if [ ! -f "$ci_dir/sbom/$sbom" ]; then
    echo "no SBOM for $1 in hack/.ci/sbom: the security stage writes them, and the nightly takes the last push's" >&2
    return 1
  fi
  docker run --rm "${as_me[@]}" -v "$ci_dir:/ci" "$TRIVY_IMAGE" sbom --cache-dir /ci/trivy-cache --quiet --severity HIGH,CRITICAL \
    --ignore-unfixed --exit-code 1 --ignorefile /ci/trivyignore.yaml "/ci/sbom/$sbom"
}

# What the security stage checked, checked again without building anything: advisories come out every day, and an
# image or a package unchanged since its push can have one by the next night.
stage_advisories() {
  mkdir -p "$ci_dir/trivy-cache"
  cp "$repo/.trivyignore.yaml" "$ci_dir/trivyignore.yaml"
  for dir in BE FE admin runtimes/nodejs; do
    step "$dir: no high or critical advisory in what ships, but those accepted until a date (npm audit)" npm_audit "$dir"
  done
  local entry
  for entry in "${IMAGES[@]}"; do
    step "${entry%% *}: no fixed high or critical vulnerability in its SBOM, today (Trivy)" scan_sbom "${entry%% *}"
  done
}

# The latest release of each tool the tests pin, tried as the pinned ones run: a change of theirs is seen the night it
# comes out, before a pin moves. Into hack/.ci/tools/: the versions (latest.env), the spike's log and recordings.
latest_tools() {
  mkdir -p "$ci_dir/tools"
  "$repo/hack/lib/latest-tools.sh" >"$ci_dir/tools/latest.env"
  grep -v SHA256 "$ci_dir/tools/latest.env"
}
rust_stable() { # the ff command's lints and tests with Rust's newest stable release, the toolchain file's pin aside
  RUSTUP_TOOLCHAIN=stable "$repo/hack/install-tools.sh" rust >/dev/null &&
    in_dir cli env RUSTUP_TOOLCHAIN=stable cargo clippy --all-targets --locked -- -D warnings &&
    in_dir cli env RUSTUP_TOOLCHAIN=stable cargo test --locked
}
tools_spike() { # the Lambda spike's flows with the latest, compared with the pinned ones' recordings; the spike's output in a log
  local dir="$ci_dir/tools"
  rm -rf "$dir/recordings"
  # The newest tools in a directory of their own: the pinned ones in hack/bin stay the other stages', on a laptop too.
  if ! (set -a && source "$dir/latest.env" && set +a &&
    FF_TOOLS_BIN="$dir/bin" FF_SAM_DIR="$dir/sam" SPIKE_WORK="$dir/spike" SPIKE_RECORDINGS="$dir/recordings" \
      "$repo/hack/spikes/lambda/run.sh") >"$dir/spike.log" 2>&1; then
    echo "the spike's run failed (hack/.ci/tools/spike.log):" >&2
    tail -20 "$dir/spike.log" >&2
    return 1
  fi
  python3 "$repo/hack/spikes/lambda/compare.py" "$repo/hack/spikes/lambda/recordings" "$dir/recordings" cli sdk boto3 tofu terraform sam
}
stage_tools() {
  "$repo/hack/check-resources.sh"
  prepare "the latest releases of the tools the tests pin" latest_tools
  step "Rust's latest stable release: the ff command's lints and tests" rust_stable
  step "the AWS tools' latest releases: the Lambda spike's flows, as the pinned ones ran" tools_spike
}

runtime_images() { # the tags the backend runs, which the cluster tests import
  docker build -q -t ff-runtime-nodejs:24-v3 runtimes/nodejs >/dev/null &&
    docker build -q -t ff-runtime-python:3.13-v3 runtimes/python >/dev/null
}

cluster_is_ready=false
cluster_ready() { # the runtime images and the dev cluster, once a run: every stage below needs them
  $cluster_is_ready && return 0
  prepare "the runtime images, built" runtime_images
  prepare "the dev cluster, made or reused" hack/k8s/cluster-up.sh
  cluster_is_ready=true
}
stage_l3() {
  cluster_ready
  step "what a failed run leaves behind, collected from the cluster" hack/test-evidence.sh
  step "L3: the Kubernetes driver on the cluster" hack/k8s/test-it.sh
}
stage_l4() { cluster_ready; step "L4: the stack through the API" hack/e2e.sh; }
stage_l5() { cluster_ready; step "L5: every route as another account" hack/e2e-tenancy.sh; }
stage_cli() { cluster_ready; step "the ff command on the stack and in Docker" hack/cli-e2e.sh; }
# After security in a run, the images are built already: Docker's build cache has every layer of them.
stage_images() {
  cluster_ready
  step "the platform's images, run as the cluster runs them" hack/test-images.sh
  step "the platform's manifests, without deploying them" hack/k8s/test-platform-manifests.sh
}
stage_cluster() { stage_l3; stage_l4; stage_l5; stage_cli; stage_images; }

stage_platform() {
  prepare "kubectl and k3d, pinned and checked" hack/install-tools.sh
  step "FF deployed from deploy/k8s on a cluster of its own" hack/e2e-platform.sh
}

# Without a stage: the header above, its comment lines to the first line of code.
[ $# -gt 0 ] || { trap - EXIT; awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 2; }
ci_stages="$*"
for stage in "$@"; do
  case "$stage" in
    deps | static | unit | db | security | cluster | l3 | l4 | l5 | cli | images | advisories | tools | platform) "stage_$stage" ;;
    all) stage_static; stage_unit; stage_db; stage_security; stage_cluster ;;
    *) echo "unknown stage $stage: deps, static, unit, db, security, cluster (or l3, l4, l5, cli, images), advisories, tools, platform or all" >&2; exit 2 ;;
  esac
done
ci_done

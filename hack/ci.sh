#!/usr/bin/env bash
# FF's pipeline, one stage per job, the same here as on the CI server (.github/workflows/ci.yml calls it):
#   deps      npm ci in the backend, the console, the admin app and the Node.js runtime, and Rust for the ff
#             command where the machine has none recent enough (CI only: locally, the installed
#             dependencies are used as they are)
#   static    linters and type checks, the builds, the ff command's formatting and lints, the docs' links and
#             tables and npm audit's checker, how-it-works.html's script, every shell script parsed, and the CI
#             workflow linted
#   unit      the unit tests: the backend's (L1), the console's, the admin app's, both runtimes', the ff
#             command's and its binary's (L1, L2), the alert rules' and the log collector's filter (these two
#             in their own images)
#   db        the backend's database tests (L2) and the migrations' drift check, on a PostgreSQL of its own
#   security  secrets in the history (gitleaks), the dependencies' advisories (npm audit, but those
#             .npmauditignore accepts until a date), and every image built, scanned (Trivy, but what
#             .trivyignore.yaml accepts) and listed as an SBOM (CycloneDX), into hack/.ci/sbom
#   cluster   on the k3d dev cluster (hack/k8s/cluster-up.sh reuses or makes it): the Kubernetes driver (L3),
#             the stack (L4), every route as another account (L5), the ff command on the stack and in
#             Docker, the images run as the cluster runs them, and the platform's manifests
#   platform  FF deployed from deploy/k8s on a cluster of its own (hack/e2e-platform.sh), about 15 minutes
#   all       static, unit, db, security and cluster, one after the other
# Each stage stops at its first failure, naming the step. Heavy steps run one at a time. FF_CI_JOBS=<n> caps the test
# runners' and Rust's parallelism at n, for a machine others share; unset, each tool takes its own default.
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

# A step runs as an `if`'s condition, where bash ignores `set -e`: a step of several commands checks each one.
step() { # <name> <command...>: runs one step, timed; stops the stage when it fails
  local name="$1" start=$SECONDS
  shift
  echo "== $name"
  if "$@"; then
    echo "   ok, $((SECONDS - start)) s"
  else
    echo "FAILED: $name ($((SECONDS - start)) s)" >&2
    exit 1
  fi
}
in_dir() { (cd "$1" && shift && "$@"); } # <directory> <command...>

stage_deps() {
  for dir in BE FE admin runtimes/nodejs; do
    step "npm ci in $dir" in_dir "$dir" npm ci --no-audit --no-fund
  done
  step "Rust for the ff command" hack/install-tools.sh rust
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

workflow_lints() { # the CI server's workflow, its run: steps shellchecked
  docker run --rm --user "$(id -u):$(id -g)" -v "$repo:/repo:ro" -w /repo "$ACTIONLINT_IMAGE" -color=false
}

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
  # shellcheck disable=SC2046 # one argument per file
  step "docs: fences, tables and relative links" python3 hack/check-docs.py $(git ls-files '*.md')
  step "how-it-works.html: its script parses" how_it_works_parses
  step "shell scripts parse" shell_scripts_parse
  step "the CI workflow (actionlint)" workflow_lints
}

stage_unit() {
  "$repo/hack/check-resources.sh"
  step "backend: L1" in_dir BE npx jest --maxWorkers=2
  step "console: unit tests" in_dir FE npm test "${vitest_jobs[@]}"
  step "admin app: unit tests" in_dir admin npm test "${vitest_jobs[@]}"
  step "Node.js runtime: protocol tests" in_dir runtimes/nodejs npm test
  step "Python runtime: protocol tests" in_dir runtimes/python python3 -m unittest discover -s tests
  step "ff: unit tests, and its binary's against a scripted API (L1, L2)" in_dir cli cargo test --locked
  step "alert rules and dashboards" hack/k8s/test-monitoring-rules.sh
  step "log collector: configuration and filter" hack/k8s/test-logging-filter.sh
}

stage_db() {
  "$repo/hack/check-resources.sh"
  local name="ff-ci-postgres-$$" data="ff-ci-data-db-$$" s3="ff-ci-s3-$$" password port admin data_port s3_key s3_port
  password="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
  admin="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
  s3_key="ci$(head -c 9 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  # shellcheck disable=SC2064 # the names are fixed now
  trap "docker rm -f -v $name $data $s3 >/dev/null 2>&1 || true" EXIT
  docker run -d --name "$name" -e POSTGRES_PASSWORD="$password" -p 127.0.0.1::5432 "$POSTGRES_IMAGE" >/dev/null
  port="$(docker port "$name" 5432/tcp | head -1 | sed 's/.*://')"
  # Customers' database server (ADR 0008), its certificate from a CA of its own, for the suites that make databases.
  docker build -q -t ff-data-db:ci "$repo/deploy/data-db" >/dev/null
  docker run -d --name "$data" -e POSTGRES_PASSWORD="$password" -e FF_DATA_DB_ADMIN_PASSWORD="$admin" \
    -e FF_DATA_DB_TLS_NAMES=DNS:localhost,IP:127.0.0.1 -p 127.0.0.1::5432 ff-data-db:ci >/dev/null
  data_port="$(docker port "$data" 5432/tcp | head -1 | sed 's/.*://')"
  # The store behind buckets' S3 front door, as development's, with keys of its own, for the suites that send it requests.
  mkdir -p "$ci_dir"
  printf '{"identities": [{"name": "ci", "credentials": [{"accessKey": "%s", "secretKey": "%s"}], "actions": ["Admin", "Read", "List", "Tagging", "Write"]}]}\n' \
    "$s3_key" "$password" >"$ci_dir/s3.json"
  chmod 644 "$ci_dir/s3.json"
  docker run -d --name "$s3" -p 127.0.0.1::8333 -v "$ci_dir/s3.json:/etc/seaweedfs/s3.json:ro" "$SEAWEEDFS_IMAGE" \
    server -dir=/data -s3 -s3.port=8333 -s3.config=/etc/seaweedfs/s3.json -master.volumeSizeLimitMB=64 >/dev/null
  s3_port="$(docker port "$s3" 8333/tcp | head -1 | sed 's/.*://')"
  for _ in $(seq 1 60); do docker exec "$name" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
  for _ in $(seq 1 60); do docker exec "$data" pg_isready -q -h 127.0.0.1 >/dev/null 2>&1 && break; sleep 1; done
  # SeaweedFS answers S3 once its volume server has joined: an anonymous request is refused then, with a status.
  for _ in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$s3_port/")" != 000 ] && break; sleep 1; done
  docker cp -q "$data:/var/lib/postgresql/tls/ca.crt" "$ci_dir/data-db-ca.crt"
  # The variables win over BE/.env, which dotenv never overrides.
  export DB_HOST=127.0.0.1 DB_PORT="$port" DB_USERNAME=postgres DB_PASSWORD="$password" DB_NAME=postgres DB_SSL=false
  export FF_DATA_DB_HOST=127.0.0.1 FF_DATA_DB_PORT="$data_port" FF_DATA_DB_ADMIN_PASSWORD="$admin" FF_DATA_DB_CA_FILE="$ci_dir/data-db-ca.crt"
  export FF_OBJECT_STORE_ENDPOINT=127.0.0.1 FF_OBJECT_STORE_PORT="$s3_port" FF_OBJECT_STORE_USE_SSL=false FF_OBJECT_STORE_ACCESS_KEY="$s3_key" FF_OBJECT_STORE_SECRET_KEY="$password"
  step "backend: L2 on PostgreSQL ${POSTGRES_IMAGE#postgres:}, customers' databases on 18, buckets on SeaweedFS ${SEAWEEDFS_IMAGE#*:}" in_dir BE npm run test:db
  step "migrations: exactly the entities' schema" in_dir BE npm run migration:check
  docker rm -f -v "$name" "$data" "$s3" >/dev/null
  trap - EXIT
}

# Every image FF builds: the platform's, the runtimes', the edge's, the backup's and customers' database server's, each with its build
# arguments. The apps bake their addresses in: any will do for a scan.
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
)

# The scanners run as this user: what they write here stays this user's.
as_me=(--user "$(id -u):$(id -g)")

gitleaks_history() { # every commit, with gitleaks' own rules; .gitleaksignore lists the findings that aren't secrets
  docker run --rm "${as_me[@]}" -v "$repo:/repo:ro" "$GITLEAKS_IMAGE" git /repo \
    --gitleaks-ignore-path /repo/.gitleaksignore --redact --no-banner --log-level warn
}

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
  step "no secret in any commit (gitleaks)" gitleaks_history
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

runtime_images() { # the tags the backend runs, which the cluster tests import
  docker build -q -t ff-runtime-nodejs:24-v3 runtimes/nodejs >/dev/null &&
    docker build -q -t ff-runtime-python:3.13-v3 runtimes/python >/dev/null
}

stage_cluster() {
  step "the runtime images, built" runtime_images
  step "the dev cluster, made or reused" hack/k8s/cluster-up.sh
  step "L3: the Kubernetes driver on the cluster" hack/k8s/test-it.sh
  step "L4: the stack through the API" hack/e2e.sh
  step "L5: every route as another account" hack/e2e-tenancy.sh
  step "the ff command on the stack and in Docker" hack/cli-e2e.sh
  step "the platform's images, run as the cluster runs them" hack/test-images.sh
  step "the platform's manifests, without deploying them" hack/k8s/test-platform-manifests.sh
}

stage_platform() {
  step "kubectl and k3d, pinned and checked" hack/install-tools.sh
  step "FF deployed from deploy/k8s on a cluster of its own" hack/e2e-platform.sh
}

# Without a stage: the header above, its comment lines to the first line of code.
[ $# -gt 0 ] || { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 2; }
for stage in "$@"; do
  case "$stage" in
    deps | static | unit | db | security | cluster | platform) "stage_$stage" ;;
    all) stage_static; stage_unit; stage_db; stage_security; stage_cluster ;;
    *) echo "unknown stage $stage: deps, static, unit, db, security, cluster, platform or all" >&2; exit 2 ;;
  esac
done
echo "ci: $* passed"

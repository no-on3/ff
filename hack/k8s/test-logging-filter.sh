#!/usr/bin/env bash
# L1 for the log collector (client-readiness plan P-42): a dry run of its configuration, and the tests of
# its Lua filter, both in the Fluent Bit image that the DaemonSet runs, so with its LuaJIT. The tests end
# Fluent Bit with their result. Needs Docker, not the cluster. FILTER_DIR tests another copy of
# deploy/k8s/logging/fluent-bit, for a mutation check.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dir="${FILTER_DIR:-$repo/deploy/k8s/logging/fluent-bit}"
image="$(awk '$1 == "image:" && $2 ~ /^fluent\/fluent-bit:/ { print $2 }' "$repo/deploy/k8s/logging/30-fluent-bit.yaml")"

echo "== the configuration, in $image"
out="$(timeout 120 docker run --rm -v "$dir:/fluent-bit/etc/ff:ro" "$image" -c /fluent-bit/etc/ff/fluent-bit.yaml --dry-run 2>&1)" || true
grep -q "configuration test is successful" <<<"$out" || { echo "$out" >&2; echo "the configuration is refused" >&2; exit 1; }
echo "  accepted"

echo "== ff.lua's tests, in $image"
status=0
out="$(timeout 120 docker run --rm -e FF_LOG_LINES_PER_SECOND=3 -e FF_LOG_BYTES_PER_SECOND=20000 -v "$dir:/ff:ro" "$image" \
  -q -i dummy -p samples=1 -F lua -p script=/ff/test/ff_test.lua -p call=run -m '*' -o null -m '*' 2>&1)" || status=$?
grep -v '^\[' <<<"$out" | sed 's/^/  /'
exit "$status"

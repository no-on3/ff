#!/usr/bin/env bash
# hack/lib/suggest.sh and hack/suggest.map: every file the repository tracks matches a line of the map, every stage and
# every suite's section a line names exists, a path takes the first line it matches, and what a change needs comes out
# as commands in the stages' order, one at a time: the resource check first, a suite whole when anything needs it
# whole, else its sections together, stages in a row in one run. In a few seconds.
#   hack/test-suggest.sh
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo/hack/lib/checks.sh"
# shellcheck source=lib/suggest.sh
source "$repo/hack/lib/suggest.sh"
commands() { suggest_commands <<<"$1" | paste -sd'|'; }

section "the map"
check "every file the repository tracks matches a line" "" \
  "$(cd "$repo" && git ls-files | while IFS= read -r path; do suggest_needs "$path" >/dev/null || echo "$path"; done | paste -sd' ')"
# Each suite's sections, as its own list names them.
declare -A ids=()
for suite in l4 l5 cli; do ids[$suite]=" $("$repo/${suggest_suite[$suite]}" --list | awk '{ print $1 }' | paste -sd' ') "; done
unknown=''
while read -r pattern needs; do
  [[ -z "$pattern" || "$pattern" == \#* ]] && continue
  for word in $needs; do
    if [[ "$word" == *:* ]]; then
      suite="${word%%:*}"
      [ -n "${ids[$suite]:-}" ] || { unknown+=" $word"; continue; }
      IFS=, read -ra listed <<<"${word#*:}"
      for id in "${listed[@]}"; do [[ "${ids[$suite]}" == *" $id "* ]] || unknown+=" $suite:$id"; done
    else
      [[ " ${suggest_order[*]} " == *" $word "* ]] || unknown+=" $word"
    fi
  done
done <"$suggest_map"
check "every stage and section a line names exists" "" "${unknown# }"
check "a path takes the first line it matches: a module's sections, then the backend whole" \
  "static unit db l4:queues,mappings,notifications,sites_counted l5 cli:queues,event_sources,queues_counted|static unit db l3 l4 l5 cli" \
  "$(suggest_needs BE/src/queues/sqs-operations.ts)|$(suggest_needs BE/src/functions/functions.service.ts)"
check "the ff command's templates are code, its guide a document" "static unit cli|static" \
  "$(suggest_needs cli/templates/README.md)|$(suggest_needs cli/README.md)"
check "a path no line matches matches none" 1 "$(suggest_needs no-such-folder/file.txt >/dev/null && echo 0 || echo 1)"

section "the commands"
check "documents: static alone, after the resource check" "hack/check-resources.sh|FF_CI_JOBS=2 hack/ci.sh static" "$(commands static)"
check "a suite's sections in its stage's place, the stages in a row in one run" \
  "hack/check-resources.sh|FF_CI_JOBS=2 hack/ci.sh static unit db|hack/e2e.sh --only queues,mappings|FF_CI_JOBS=2 hack/ci.sh l5|hack/cli-e2e.sh --only queues" \
  "$(commands "l5 cli:queues db static unit l4:queues,mappings")"
check "a suite needed whole runs whole, its sections dropped; a section named twice, once" \
  "hack/check-resources.sh|FF_CI_JOBS=2 hack/ci.sh static l4|hack/cli-e2e.sh --only queues,buckets" \
  "$(commands "l4:queues static l4 cli:queues,buckets cli:queues")"
check "FF_CI_JOBS as it is set" "hack/check-resources.sh|FF_CI_JOBS=4 hack/ci.sh unit" "$(FF_CI_JOBS=4 commands unit)"
check "a commit that isn't one: refused, exit 2" "2 suggest: no-such-commit is no commit" \
  "$("$repo/hack/ci.sh" suggest no-such-commit 2>"$repo/hack/.ci/suggest.err" >/dev/null && echo 0 || echo $?) $(cat "$repo/hack/.ci/suggest.err")"
rm -f "$repo/hack/.ci/suggest.err"

checks_done suggest

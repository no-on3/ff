#!/usr/bin/env bash
# hack/check-docs.py, on small documents with one problem each and one without: each problem named at its line,
# the clean document passing. In a second or so.
#   hack/test-check-docs.sh
set -euo pipefail
checker="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-docs.py"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
passed=0
check() { # <description> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  ok   $1"; passed=$((passed + 1)); else echo "  FAIL $1 (expected '$2', got '$3')"; exit 1; fi
}
problems() { python3 "$checker" "$work/$1" | grep -v '^docs:' | sed "s|^$work/||" || true; }
fence='```'

printf '%s\n' '# Clean' '' "${fence}bash" 'echo hi' "$fence" '' '| a | b |' '|---|---|' '| `x|y` | 2 |' '' '[here](clean.md)' >"$work/clean.md"
check "a clean document passes" "0" "$(python3 "$checker" "$work/clean.md" >/dev/null; echo $?)"

printf '%s\n' "${fence}bash" 'echo hi' >"$work/open.md"
check "a block never closed" "open.md: unbalanced code fences (1)" "$(problems open.md)"

printf '%s\n' "${fence}bash" 'echo hi' "$fence Then a sentence." '' 'More text.' "${fence}bash" 'echo again' "$fence" >"$work/glued.md"
check "text after a closing fence" "glued.md:3: text after a closing code fence: the block doesn't end there" "$(problems glued.md)"

printf '%s\n' "$fence Run this:" 'echo hi' "$fence" >"$work/sentence.md"
check "a sentence where the language goes" "sentence.md:1: a code fence names one language; the rest belongs on a line of its own" "$(problems sentence.md)"

printf '%s\n' '| a | b |' '|---|---|' '| 1 | 2 | 3 |' >"$work/table.md"
check "a row with a cell too many" "table.md:3: table row has 3 cells, header has 2" "$(problems table.md)"

printf '%s\n' 'See [the guide](missing.md#part) and [the site](https://example.tn) and [above](#top).' >"$work/link.md"
check "a relative link to nothing, and only that one" "link.md:1: broken relative link -> missing.md#part" "$(problems link.md)"

echo "check-docs: $passed checks passed"

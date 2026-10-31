#!/usr/bin/env bash
# hack/lib/changes.sh, on paths and on a repository of its own: documents are docs/ and *.md, the ff command's templates
# are code, and so is every file the ff command embeds (include_str!, include_bytes!), whatever its name, so that a push
# that changes one runs every job; commits that change only documents skip the heavy jobs, the others don't, and two
# commits that can't be compared run everything. In a second or so.
#   hack/test-changes.sh
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$repo/hack/lib/changes.sh"
work="$(mktemp -d)"
source "$repo/hack/lib/checks.sh"
on_exit 'rm -rf "$work"'
# shellcheck source=lib/changes.sh
source "$script"
kind() { if is_document "$1"; then echo document; else echo code; fi; }

section "paths"
for path in docs/getting-started.md docs/how-it-works.html docs/adr/0010-queue.md README.md hack/spikes/lambda/README.md; do
  check "$path is a document" document "$(kind "$path")"
done
for path in cli/templates/README.md cli/templates/function.ts hack/ci.sh .github/workflows/ci.yml BE/src/main.ts docs.sh; do
  check "$path is code" code "$(kind "$path")"
done
check "only documents, and none at all, skip the heavy jobs; one path of code doesn't" "true true false" \
  "$(printf '%s\n' docs/a.md README.md | only_documents && echo true || echo false) $(only_documents </dev/null && echo true || echo false) \
$(printf '%s\n' docs/a.md hack/ci.sh | only_documents && echo true || echo false)"

section "what the ff command embeds is code"
# Each include_str!/include_bytes! path, from the file it is in to the repository's root.
embedded="$(cd "$repo" && git grep -nE 'include_(str|bytes)!\("' -- 'cli/src/*.rs' | python3 -c '
import os, re, sys
for line in sys.stdin:
    file, _, code = line.split(":", 2)
    for target in re.findall(r"include_(?:str|bytes)!\(\"([^\"]+)\"\)", code):
        print(os.path.normpath(os.path.join(os.path.dirname(file), target)))
' | sort -u)"
check "the ff command embeds files: its templates and the backend's sources it checks against" true \
  "$(grep -x 'cli/templates/README.md' <<<"$embedded" >/dev/null && grep '^BE/src/' <<<"$embedded" >/dev/null && echo true || echo false)"
check "every one of them is code" "" "$(while read -r path; do is_document "$path" && echo "$path"; done <<<"$embedded" | paste -sd' ')"

section "commits"
git -C "$work" init -q -b main
commit() { # <path>: a commit that changes it; its hash
  mkdir -p "$work/$(dirname "$1")"
  echo "$RANDOM" >>"$work/$1"
  git -C "$work" add "$1"
  git -C "$work" -c user.name=test -c user.email=test@example.test -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -qm "$1"
  git -C "$work" rev-parse HEAD
}
first="$(commit docs/a.md)"
docs="$(commit README.md)"
code="$(commit hack/ci.sh)"
template="$(commit cli/templates/README.md)"
changes() { (cd "$work" && "$script" "$@"); }
check "a commit of documents alone: code=false" code=false "$(changes "$first" "$docs")"
check "a commit with code: code=true" code=true "$(changes "$docs" "$code")"
check "a commit of the ff command's templates, which are code: code=true" code=true "$(changes "$code" "$template")"
check "documents then code, pushed together: code=true" code=true "$(changes "$first" "$code")"
check "a new branch's first push, which has no base: code=true" code=true "$(changes 0000000000000000000000000000000000000000 "$docs")"
check "a base the history doesn't have: code=true" code=true "$(changes 1111111111111111111111111111111111111111 "$docs")"

checks_done changes

#!/usr/bin/env bash
# Whether commits change more than the documents, for the CI workflow's changes job: a push or a pull request that
# changes only documents runs static alone, which checks them, gitleaks among its steps. The documents are docs/ and
# every *.md file, but those a build embeds, which are code: the ff command's templates, which `ff init` writes into a
# project. hack/test-changes.sh keeps that true: every file the ff command embeds must count as code here.
#   hack/lib/changes.sh <base> <head>    code=true or code=false, as $GITHUB_OUTPUT takes it: true when a path outside
#                                        the documents changed between the two, or when they can't be compared
#   source hack/lib/changes.sh           for is_document <path> and only_documents (the paths on stdin)
set -euo pipefail

is_document() { # <path>: whether a change to it is a change to the documents alone
  case "$1" in
    cli/templates/*) return 1 ;;
    docs/* | *.md) return 0 ;;
    *) return 1 ;;
  esac
}

only_documents() { # whether every path on stdin, one a line, is a document; true for none
  local path
  while IFS= read -r path; do
    [ -z "$path" ] || is_document "$path" || return 1
  done
  return 0
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  base="${1:?the base commit}"
  head="${2:?the head commit}"
  # A new branch's first push has no base (all zeros), and a rewritten history may have lost it: then everything runs.
  if paths="$(git diff --name-only "$base...$head" 2>/dev/null)" && only_documents <<<"$paths"; then
    echo code=false
  else
    echo code=true
  fi
fi
